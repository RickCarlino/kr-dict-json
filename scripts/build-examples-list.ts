#!/usr/bin/env bun
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dictDir = getArg("--dict") ?? "out/mini";
const outPath = getArg("--out") ?? "examples.txt";
const limit = Number(getArg("--limit") ?? "15000");
const minChunk = Number(getArg("--min-chunk") ?? "2");
const maxChunk = Number(getArg("--max-chunk") ?? "9");
const source = getArg("--source") ?? "mini";

if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`Invalid --limit value: ${limit}`);
  process.exit(1);
}
if (!Number.isFinite(minChunk) || !Number.isFinite(maxChunk) || minChunk <= 0 || maxChunk <= 0) {
  console.error(`Invalid --min-chunk/--max-chunk values: ${minChunk}, ${maxChunk}`);
  process.exit(1);
}

const dirPath = path.resolve(dictDir);
const files =
  source === "mini"
    ? readdirSync(dirPath)
        .filter((f) => {
          const match = /^mini-(\d{3})\.json$/.exec(f);
          if (!match) return false;
          const idx = Number(match[1]);
          return idx >= minChunk && idx <= maxChunk;
        })
        .sort()
    : readdirSync(dirPath)
        .filter((f) => f.endsWith(".json") && f !== "attribute-summary.json")
        .sort();

const selected: { text: string; len: number }[] = [];
let maxLen = -1;

for (const file of files) {
  const filePath = path.join(dirPath, file);
  let data: unknown[];
  try {
    data = readJson<unknown[]>(filePath);
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    continue;
  }

  for (const entry of data) {
    const candidate = pickFirstEligibleExample(entry);
    if (!candidate) continue;

    const len = Array.from(candidate).length;
    if (selected.length < limit) {
      selected.push({ text: candidate, len });
      if (len > maxLen) maxLen = len;
    } else if (len < maxLen) {
      const idx = indexOfMax(selected);
      if (idx >= 0) {
        selected[idx] = { text: candidate, len };
        maxLen = maxLength(selected);
      }
    }
  }
}

selected.sort((a, b) => a.len - b.len || a.text.localeCompare(b.text, "ko"));

const lines: string[] = [];
const seen = new Set<string>();
for (const item of selected) {
  if (seen.has(item.text)) continue;
  seen.add(item.text);
  lines.push(item.text);
}
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Wrote ${lines.length} examples to ${outPath}`);

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function isEligible(text: string) {
  if (!text) return false;
  const words = text.split(" ").filter(Boolean);
  if (words.length < 3) return false;
  const length = Array.from(text).length;
  if (length < 9 || length > 18) return false;
  if (text.includes("(") || text.includes(")")) return false;
  return true;
}

function pickFirstEligibleExample(entry: unknown) {
  const examples = extractExamples(entry);
  for (const example of examples) {
    const cleaned = stripTrailingPeriods(example.trim());
    if (!cleaned) continue;
    if (!isEligible(cleaned)) continue;
    return cleaned;
  }
  return null;
}

function stripTrailingPeriods(text: string) {
  return text.replace(/[.]+$/g, "");
}

function extractExamples(entry: unknown) {
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

  if (!entry || typeof entry !== "object") return out;
  const record = entry as Record<string, unknown>;

  if (source === "mini") {
    addExample(record.examples);
    return out;
  }

  const senses = record.senses;
  if (Array.isArray(senses)) {
    for (const sense of senses) {
      if (sense && typeof sense === "object") {
        walkExamples(sense as Record<string, unknown>, addExample);
      }
    }
  }

  const attrs = record.attrs;
  if (attrs && typeof attrs === "object") {
    const wordInfo = (attrs as Record<string, unknown>).wordInfo;
    if (wordInfo && typeof wordInfo === "object") {
      addExample((wordInfo as Record<string, unknown>).example);
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

function maxLength(items: { len: number }[]) {
  let max = -1;
  for (const item of items) {
    if (item.len > max) max = item.len;
  }
  return max;
}

function indexOfMax(items: { len: number }[]) {
  let max = -1;
  let idx = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].len > max) {
      max = items[i].len;
      idx = i;
    }
  }
  return idx;
}
