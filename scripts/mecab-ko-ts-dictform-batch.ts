#!/usr/bin/env bun
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  examples?: unknown;
};

type MecabToken = string[];

type SentenceResult = {
  sentence: string;
  dictForms?: string[];
  error?: string;
};

const CONTENT_POS = new Set([
  "NNG",
  "NNP",
  "NNB",
  "NNBC",
  "NR",
  "NP",
  "SN",
  "SL",
  "SH",
  "XR",
  "MAG",
  "MAJ",
  "MM",
  "IC",
]);
const VERB_POS = new Set(["VV", "VA", "VX", "VCP", "VCN"]);
const DERIVATION_BASE_POS = new Set([
  "NNG",
  "NNP",
  "NNB",
  "NNBC",
  "NR",
  "NP",
  "SN",
  "SL",
  "SH",
  "XR",
]);

const args = process.argv.slice(2);
const inDir = getArg("--in-dir") ?? "out/mini";
const outDir = getArg("--out") ?? "out/mini-dictform";
const chunkRaw = getArg("--chunk") ?? "1000";
const limitRaw = getArg("--limit");
const clean = !args.includes("--no-clean");

const chunkSize = Number(chunkRaw);
if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
  console.error(`Invalid --chunk value: ${chunkRaw}`);
  process.exit(1);
}

const limit = limitRaw ? Number(limitRaw) : undefined;
if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
  console.error(`Invalid --limit value: ${limitRaw}`);
  process.exit(1);
}

const inPath = path.resolve(inDir);
const outPath = path.resolve(outDir);

const files = readdirSync(inPath)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error(`No .json files found in ${inPath}`);
  process.exit(1);
}

if (clean) {
  rmSync(outPath, { recursive: true, force: true });
}
mkdirSync(outPath, { recursive: true });

const mecab = await loadMecab();
const analyze = makeAllAnalyzer(mecab);

let chunkIndex = 1;
let buffer: SentenceResult[] = [];
let processed = 0;
let stop = false;

for (const file of files) {
  if (stop) break;
  const filePath = path.join(inPath, file);
  let entries: Entry[];
  try {
    entries = readJson<Entry[]>(filePath);
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    continue;
  }

  for (const entry of entries) {
    if (stop) break;
    const examples = collectExamples(entry.examples);
    for (const sentence of examples) {
      if (typeof limit === "number" && processed >= limit) {
        stop = true;
        break;
      }
      try {
        const tokens = await analyze(sentence);
        buffer.push({ sentence, dictForms: toDictionaryForms(tokens) });
      } catch (err) {
        buffer.push({
          sentence,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      processed += 1;

      if (buffer.length >= chunkSize) {
        writeChunk(outPath, chunkIndex, buffer);
        chunkIndex += 1;
        buffer = [];
      }
    }
  }
}

if (buffer.length > 0) {
  writeChunk(outPath, chunkIndex, buffer);
}

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function collectExamples(value: unknown) {
  const out: string[] = [];
  const add = (item: unknown) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(item)) {
      for (const v of item) add(v);
    }
  };
  add(value);
  return out;
}

async function loadMecab() {
  try {
    const mod = await import("mecab-ko-ts");
    return (mod as { default?: unknown }).default ?? mod;
  } catch (err) {
    const hint = "Install mecab-ko-ts first (e.g. bun add mecab-ko-ts).";
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`${hint}\n${detail}`);
    process.exit(1);
  }
}

function makeAllAnalyzer(mecab: any) {
  if (typeof mecab?.allSync === "function") {
    return async (text: string) => mecab.allSync(text) as MecabToken[];
  }
  if (typeof mecab?.all === "function") {
    return (text: string) =>
      new Promise<MecabToken[]>((resolve, reject) => {
        mecab.all(text, (err: Error | null, result: MecabToken[]) => {
          if (err) reject(err);
          else resolve(result ?? []);
        });
      });
  }
  throw new Error("mecab-ko-ts does not expose all/allSync.");
}

function toDictionaryForms(tokens: MecabToken[]) {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const surface = token[0] ?? "";
    const rawPos = token[1] ?? "";
    const pos = rawPos.split("+")[0] ?? rawPos;
    const lemma = pickLemma(token, surface);

    const next = tokens[i + 1];
    if (next && DERIVATION_BASE_POS.has(pos) && hasDerivationSuffix(next[1])) {
      const base = extractDerivationBase(next);
      if (base) {
        out.push(`${lemma}${toVerbLemma(base)}`);
        i += 1;
        continue;
      }
    }

    if (VERB_POS.has(pos)) {
      out.push(getVerbLemma(token, surface));
      continue;
    }
    if (CONTENT_POS.has(pos)) {
      out.push(lemma);
    }
  }
  return out;
}

function pickLemma(fields: string[], surface: string) {
  const candidate = fields[4];
  if (candidate && candidate !== "*") return candidate;
  return surface;
}

function getVerbLemma(fields: string[], surface: string) {
  const rawPos = fields[1] ?? "";
  const useExpr = rawPos.includes("+");
  const base = useExpr ? extractBaseFromExpr(fields) : null;
  const lemma = base ?? pickLemma(fields, surface);
  return toVerbLemma(lemma);
}

function hasDerivationSuffix(rawPos: string | undefined) {
  if (!rawPos) return false;
  return rawPos.includes("XSA") || rawPos.includes("XSV");
}

function extractDerivationBase(fields: string[]) {
  const base = extractBaseFromExpr(fields);
  if (base) return base;
  const lemma = pickLemma(fields, "");
  return lemma || null;
}

function extractBaseFromExpr(fields: string[]) {
  const expr = fields[8];
  if (expr && expr !== "*") {
    const first = expr.split("+")[0] ?? "";
    const base = first.split("/")[0] ?? "";
    if (base && base !== "*") return base;
  }
  return null;
}

function toVerbLemma(lemma: string) {
  return lemma.endsWith("다") ? lemma : `${lemma}다`;
}

function writeChunk(outPath: string, index: number, data: SentenceResult[]) {
  const name = `dictform-${String(index).padStart(3, "0")}.json`;
  const filePath = path.join(outPath, name);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}
