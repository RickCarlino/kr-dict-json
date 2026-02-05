#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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
const analyze = makeAllAnalyzer(mecab);

const results: SentenceResult[] = [];
for (const sentence of selected) {
  try {
    const tokens = await analyze(sentence);
    const dictForms = toDictionaryForms(tokens);
    results.push({
      sentence,
      dictForms,
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
