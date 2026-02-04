#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type SentenceResult = {
  sentence: string;
  dictForms?: string[];
  error?: string;
};

type RankItem = {
  word: string;
  count: number;
};

const args = process.argv.slice(2);
const inDir = getArg("--in-dir") ?? "out/mini-dictform";
const outFile = getArg("--out") ?? "out/mini-dictform-rank.json";

const inPath = path.resolve(inDir);
const files = readdirSync(inPath)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error(`No .json files found in ${inPath}`);
  process.exit(1);
}

const counts = new Map<string, number>();

for (const file of files) {
  const filePath = path.join(inPath, file);
  let data: SentenceResult[];
  try {
    data = readJson<SentenceResult[]>(filePath);
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    continue;
  }

  for (const row of data) {
    if (!row.dictForms) continue;
    for (const word of row.dictForms) {
      if (!word) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
}

const ranked: RankItem[] = Array.from(counts.entries())
  .map(([word, count]) => ({ word, count }))
  .sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.word.localeCompare(b.word);
  });

writeFileSync(path.resolve(outFile), JSON.stringify(ranked, null, 2));

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}
