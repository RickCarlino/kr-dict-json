#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  term?: string;
  definitions?: string[];
  source?: string;
  attrs?: Record<string, unknown>;
  senses?: Record<string, unknown>[];
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: bun scripts/examples-for-term.ts <term> [--dir=out/by-initial] [--all] [--max=50]");
  process.exit(1);
}

const term = args[0];
const dirArg = getArg("--dir") ?? "out/by-initial";
const searchAll = args.includes("--all");
const maxArg = getArg("--max");
const maxResults = maxArg ? Number(maxArg) : 200;

if (!Number.isFinite(maxResults) || maxResults <= 0) {
  console.error(`Invalid --max value: ${maxArg}`);
  process.exit(1);
}

const normalizedInput = normalize(term);
const inputTrimmed = term.trim();
const firstChar = Array.from(inputTrimmed)[0] ?? "";

const dirPath = path.resolve(dirArg);
const files = readdirSync(dirPath)
  .filter((f) => f.endsWith(".json") && f !== "attribute-summary.json")
  .sort();

const targetFiles = searchAll || !firstChar
  ? files
  : files.filter((f) => f.startsWith(firstChar));

if (targetFiles.length === 0) {
  console.log("[]");
  process.exit(0);
}

const examples: string[] = [];
const seen = new Set<string>();

for (const file of targetFiles) {
  const filePath = path.join(dirPath, file);
  let data: Entry[];
  try {
    const raw = readFileSync(filePath, "utf8");
    data = JSON.parse(raw) as Entry[];
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    continue;
  }

  for (const entry of data) {
    if (!isMatch(entry, inputTrimmed, normalizedInput)) continue;

    const entryExamples = collectExamples(entry);
    for (const ex of entryExamples) {
      if (!seen.has(ex)) {
        seen.add(ex);
        examples.push(ex);
        if (examples.length >= maxResults) break;
      }
    }
    if (examples.length >= maxResults) break;
  }
  if (examples.length >= maxResults) break;
}

console.log(JSON.stringify(examples, null, 2));

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

function isMatch(entry: Entry, raw: string, normalized: string) {
  const candidates = new Set<string>();
  if (entry.term) candidates.add(entry.term);

  const wordInfo = entry.attrs && (entry.attrs as Record<string, unknown>).wordInfo;
  if (wordInfo && typeof wordInfo === "object") {
    const word = (wordInfo as Record<string, unknown>).word;
    collectStrings(word, candidates);
  }

  for (const candidate of candidates) {
    if (candidate === raw) return true;
    if (normalize(candidate) === normalized) return true;
  }
  return false;
}

function collectStrings(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    if (value.trim()) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
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
