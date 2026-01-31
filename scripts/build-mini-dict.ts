#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  term?: string;
  definitions?: string[];
  attrs?: Record<string, unknown>;
  senses?: Record<string, unknown>[];
};

type WordInfo = {
  word?: string | string[];
  definition?: string | string[];
  example?: string | string[];
  pos?: string | string[];
};

type Agg = {
  defs: string[];
  defSet: Set<string>;
  examples: string[];
  exSet: Set<string>;
  pos: string[];
  posSet: Set<string>;
};

const args = process.argv.slice(2);
const freqPath = getArg("--freq") ?? "frequency.json";
const dictDir = getArg("--dict") ?? "out/by-initial";
const outDir = getArg("--out") ?? "out/mini";
const chunkSize = Number(getArg("--chunk") ?? "1000");
const maxExampleChars = Number(getArg("--max-example-chars") ?? "18");
const clean = !args.includes("--no-clean");

if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
  console.error(`Invalid --chunk value: ${chunkSize}`);
  process.exit(1);
}
if (!Number.isFinite(maxExampleChars) || maxExampleChars <= 0) {
  console.error(`Invalid --max-example-chars value: ${maxExampleChars}`);
  process.exit(1);
}

const freqList = readJson<string[]>(freqPath).filter((v) => typeof v === "string");
if (freqList.length === 0) {
  console.error("frequency.json is empty or invalid.");
  process.exit(1);
}

if (clean) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const targetsByInitial = new Map<string, Set<string>>();
const normToTerms = new Map<string, string[]>();
const aggByNorm = new Map<string, Agg>();

for (const term of freqList) {
  const norm = normalize(term);
  if (!norm) continue;
  const initial = firstChar(norm);
  if (!initial) continue;

  const set = targetsByInitial.get(initial) ?? new Set<string>();
  set.add(norm);
  targetsByInitial.set(initial, set);

  const list = normToTerms.get(norm) ?? [];
  list.push(term);
  normToTerms.set(norm, list);

  if (!aggByNorm.has(norm)) {
    aggByNorm.set(norm, {
      defs: [],
      defSet: new Set(),
      examples: [],
      exSet: new Set(),
      pos: [],
      posSet: new Set(),
    });
  }
}

const dictPath = path.resolve(dictDir);
const files = readdirSync(dictPath)
  .filter((f) => f.endsWith(".json") && f !== "attribute-summary.json")
  .sort();

const filesByInitial = new Map<string, string[]>();
for (const file of files) {
  const base = path.basename(file, ".json");
  const initial = firstChar(base);
  if (!initial) continue;
  const list = filesByInitial.get(initial) ?? [];
  list.push(path.join(dictPath, file));
  filesByInitial.set(initial, list);
}

for (const [initial, targets] of targetsByInitial) {
  const fileList = filesByInitial.get(initial);
  if (!fileList) continue;

  for (const filePath of fileList) {
    let data: Entry[];
    try {
      data = readJson<Entry[]>(filePath);
    } catch (err) {
      console.error(`Failed to parse ${filePath}:`, err);
      continue;
    }

    for (const entry of data) {
      const normCandidates = collectCandidateNorms(entry);
      for (const norm of normCandidates) {
        if (!targets.has(norm)) continue;
        const agg = aggByNorm.get(norm);
        if (!agg) continue;

        const defs = collectDefinitions(entry);
        for (const def of defs) {
          if (agg.defSet.has(def)) continue;
          agg.defSet.add(def);
          agg.defs.push(def);
        }

        const examples = collectExamples(entry);
        for (const ex of examples) {
          if (agg.exSet.has(ex)) continue;
          agg.exSet.add(ex);
          agg.examples.push(ex);
        }

        const posList = collectPos(entry);
        for (const pos of posList) {
          if (agg.posSet.has(pos)) continue;
          agg.posSet.add(pos);
          agg.pos.push(pos);
        }
      }
    }
  }
}

const finalByNorm = new Map<string, { definitions: string[]; examples: string[]; pos: string[] }>();
for (const [norm, agg] of aggByNorm) {
  const definitions = agg.defs.slice(0, 5);
  const examples = pickShortestExamples(
    agg.examples.filter((text) => Array.from(text).length <= maxExampleChars),
    4,
  );
  finalByNorm.set(norm, { definitions, examples, pos: agg.pos });
}

const output: { term: string; freq: number; definitions: string[]; examples: string[]; pos: string[] }[] =
  [];
for (let i = 0; i < freqList.length; i += 1) {
  const term = freqList[i];
  const norm = normalize(term);
  const entry = norm ? finalByNorm.get(norm) : undefined;
  const definitions = entry?.definitions ?? [];
  const examples = entry?.examples ?? [];
  const pos = entry?.pos ?? [];
  if (definitions.length === 0 || examples.length === 0) continue;
  output.push({ term, freq: i + 1, definitions, examples, pos });
}

let chunkIndex = 0;
for (let i = 0; i < output.length; i += chunkSize) {
  const chunk = output.slice(i, i + chunkSize);
  chunkIndex += 1;
  const fileName = `mini-${String(chunkIndex).padStart(3, "0")}.json`;
  const filePath = path.join(outDir, fileName);
  writeFileSync(filePath, JSON.stringify(chunk, null, 2) + "\n");
}

console.log(`Wrote ${output.length} terms to ${outDir} (${chunkIndex} chunks).`);

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\s·•∙⋅ㆍ･\u00B7\u2027\u2219\u2212\u2010-\u2015\-^]/g, "")
    .replace(/\d+$/g, "")
    .trim();
}

function firstChar(value: string) {
  return Array.from(value)[0] ?? "";
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function collectCandidateNorms(entry: Entry) {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const norm = normalize(value);
      if (norm) out.add(norm);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) add(v);
    }
  };

  if (entry.term) add(entry.term);

  const wordInfo = getWordInfo(entry);
  if (wordInfo) {
    add(wordInfo.word);
  }

  return out;
}

function getWordInfo(entry: Entry): WordInfo | null {
  const attrs = entry.attrs;
  if (!attrs || typeof attrs !== "object") return null;
  const wordInfo = (attrs as Record<string, unknown>).wordInfo;
  if (!wordInfo || typeof wordInfo !== "object") return null;
  return wordInfo as WordInfo;
}

function collectDefinitions(entry: Entry) {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) add(v);
    }
  };

  if (entry.definitions) {
    for (const def of entry.definitions) add(def);
  }

  const wordInfo = getWordInfo(entry);
  if (wordInfo) add(wordInfo.definition);

  return out;
}

function collectExamples(entry: Entry) {
  const out: string[] = [];
  const addExample = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) addExample(v);
    }
  };

  if (entry.senses) {
    for (const sense of entry.senses) {
      walkExamples(sense, addExample);
    }
  }

  const wordInfo = getWordInfo(entry);
  if (wordInfo) addExample(wordInfo.example);

  return out;
}

function collectPos(entry: Entry) {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) add(v);
    }
  };

  const wordInfo = getWordInfo(entry);
  if (wordInfo) add(wordInfo.pos);

  return out;
}

function walkExamples(obj: Record<string, unknown>, add: (v: unknown) => void) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === "example") {
      add(value);
      continue;
    }
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object") {
            walkExamples(item as Record<string, unknown>, add);
          }
        }
      } else {
        walkExamples(value as Record<string, unknown>, add);
      }
    }
  }
}

function pickShortestExamples(values: string[], count: number) {
  const decorated = values.map((text, index) => ({
    text,
    len: Array.from(text).length,
    index,
  }));
  decorated.sort((a, b) => a.len - b.len || a.index - b.index);
  return decorated.slice(0, count).map((item) => item.text);
}
