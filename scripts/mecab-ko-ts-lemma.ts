#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  examples?: unknown;
};

type Token = {
  surface: string;
  pos: string;
  lemma: string;
  features: string[];
};

type SentenceResult = {
  sentence: string;
  tokens?: Token[];
  error?: string;
};

const args = process.argv.slice(2);
const inputArg = getArg("--in") ?? "out/mini/mini-001.json";
const limitRaw = getArg("--limit");
const unique = args.includes("--unique");

const limit = limitRaw ? Number(limitRaw) : undefined;
if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
  console.error(`Invalid --limit value: ${limitRaw}`);
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const entries = readJson<Entry[]>(inputPath);
const examples = collectExamples(entries);
const sentences = unique ? Array.from(new Set(examples)) : examples;
const selected = typeof limit === "number" ? sentences.slice(0, limit) : sentences;

const mecab = await loadMecab();
const analyze = makeAnalyzer(mecab);

const results: SentenceResult[] = [];
for (const sentence of selected) {
  try {
    const tokens = await analyze(sentence);
    results.push({
      sentence,
      tokens: tokens.map(formatToken),
    });
  } catch (err) {
    results.push({
      sentence,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

console.log(
  JSON.stringify(
    {
      source: inputArg,
      sentenceCount: selected.length,
      unique,
      results,
    },
    null,
    2
  )
);

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function collectExamples(entries: Entry[]) {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
    }
  };

  for (const entry of entries) {
    add(entry.examples);
  }

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

function makeAnalyzer(mecab: any) {
  if (typeof mecab?.allSync === "function") {
    return async (text: string) => mecab.allSync(text) as string[][];
  }
  if (typeof mecab?.all === "function") {
    return (text: string) =>
      new Promise<string[][]>((resolve, reject) => {
        mecab.all(text, (err: Error | null, result: string[][]) => {
          if (err) reject(err);
          else resolve(result ?? []);
        });
      });
  }
  throw new Error("mecab-ko-ts does not expose all/allSync.");
}

function formatToken(fields: string[]): Token {
  const surface = fields[0] ?? "";
  const pos = fields[1] ?? "";
  const lemma = pickLemma(fields, surface);
  return {
    surface,
    pos,
    lemma,
    features: fields.slice(1),
  };
}

function pickLemma(fields: string[], fallback: string) {
  // mecab-ko feature layout (after surface):
  // pos, semantic, has_jongseong, reading, type, start_pos, end_pos, expression
  const candidate = fields[4];
  if (candidate && candidate !== "*") return candidate;
  return fallback;
}
