#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  term?: string;
  attrs?: Record<string, unknown>;
};

type FreqItem = {
  term: string;
  normalized: string;
  initial: string;
};

const args = process.argv.slice(2);
const freqPath = getArg("--freq") ?? "freq.txt";
const dictDir = getArg("--dict") ?? "out/by-initial";
const outPath = getArg("--out") ?? "frequency.json";

const freqLines = readFileSync(freqPath, "utf8").split(/\r?\n/);
const freqItems: FreqItem[] = [];

for (const line of freqLines) {
  const raw = line.trim();
  if (!raw) continue;
  const m = raw.match(/^\s*\d+\.\s*(.+)$/);
  const term = (m ? m[1] : raw).trim();
  if (!term) continue;
  const normalized = normalize(term);
  if (!normalized) continue;
  const initial = firstChar(normalized);
  if (!initial) continue;
  freqItems.push({ term, normalized, initial });
}

if (freqItems.length === 0) {
  console.error("No valid terms found in freq file.");
  writeFileSync(outPath, "[]\n");
  process.exit(1);
}

const targetsByInitial = new Map<string, Set<string>>();
for (const item of freqItems) {
  const set = targetsByInitial.get(item.initial) ?? new Set<string>();
  set.add(item.normalized);
  targetsByInitial.set(item.initial, set);
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

const found = new Set<string>();

for (const [initial, targets] of targetsByInitial) {
  const fileList = filesByInitial.get(initial);
  if (!fileList || fileList.length === 0) continue;

  for (const filePath of fileList) {
    let data: Entry[];
    try {
      const raw = readFileSync(filePath, "utf8");
      data = JSON.parse(raw) as Entry[];
    } catch (err) {
      console.error(`Failed to parse ${filePath}:`, err);
      continue;
    }

    for (const entry of data) {
      const candidates = new Set<string>();
      if (entry.term) candidates.add(entry.term);
      if (entry.attrs) collectStrings(entry.attrs, candidates);
      for (const candidate of candidates) {
        const norm = normalize(candidate);
        if (norm && targets.has(norm)) {
          found.add(norm);
        }
      }
    }
  }
}

const filtered = freqItems
  .filter((item) => found.has(item.normalized))
  .map((item) => item.term);

writeFileSync(outPath, JSON.stringify(filtered, null, 2) + "\n");
console.log(`Wrote ${filtered.length} terms to ${outPath}`);

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

function collectStrings(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    if (value.trim()) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStrings(v, out);
    }
  }
}
