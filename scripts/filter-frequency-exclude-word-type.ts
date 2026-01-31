#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Entry = {
  term?: string;
  attrs?: Record<string, unknown>;
};

type TargetsByInitial = Map<string, Set<string>>;

type WordInfo = {
  word?: string | string[];
  word_type?: string | string[];
};

type DefCheck = {
  hasNumeric: boolean;
  idx1Loan: boolean;
  idx2Loan: boolean;
  fallbackLoans: boolean[];
};

const args = process.argv.slice(2);
const freqPath = getArg("--freq") ?? "frequency.json";
const dictDir = getArg("--dict") ?? "out/by-initial";
const outPath = getArg("--out") ?? "frequency.json";
const targetType = getArg("--type") ?? "외래어";

const freqList = readJson<string[]>(freqPath);
if (!Array.isArray(freqList) || freqList.length === 0) {
  console.error("frequency.json is empty or invalid.");
  process.exit(1);
}

const targetsByInitial: TargetsByInitial = new Map();
for (const term of freqList) {
  const normalized = normalize(term);
  if (!normalized) continue;
  const initial = firstChar(normalized);
  if (!initial) continue;
  const set = targetsByInitial.get(initial) ?? new Set<string>();
  set.add(normalized);
  targetsByInitial.set(initial, set);
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

const foreignSet = new Set<string>();

for (const [initial, targets] of targetsByInitial) {
  const fileList = filesByInitial.get(initial);
  if (!fileList) continue;

  const checks = new Map<string, DefCheck>();

  for (const filePath of fileList) {
    let data: Entry[];
    try {
      data = readJson<Entry[]>(filePath);
    } catch (err) {
      console.error(`Failed to parse ${filePath}:`, err);
      continue;
    }

    for (const entry of data) {
      const wordInfo = getWordInfo(entry);
      if (!wordInfo) continue;
      const wordType = wordInfo.word_type;
      const isLoan = hasWordType(wordType, targetType);
      const primary = getPrimaryWord(entry, wordInfo);
      const defIndex = primary ? extractIndex(primary) : null;

      const candidates = collectCandidates(entry, wordInfo);
      const seen = new Set<string>();
      for (const cand of candidates) {
        const norm = normalize(cand);
        if (!norm || !targets.has(norm) || seen.has(norm)) continue;
        seen.add(norm);

        const check =
          checks.get(norm) ?? { hasNumeric: false, idx1Loan: false, idx2Loan: false, fallbackLoans: [] };

        if (defIndex != null) {
          check.hasNumeric = true;
          if (defIndex === 1 && isLoan) check.idx1Loan = true;
          if (defIndex === 2 && isLoan) check.idx2Loan = true;
        } else if (!check.hasNumeric && check.fallbackLoans.length < 2) {
          check.fallbackLoans.push(isLoan);
        }

        checks.set(norm, check);
      }
    }
  }

  for (const [term, check] of checks) {
    if (check.hasNumeric) {
      if (check.idx1Loan || check.idx2Loan) {
        foreignSet.add(term);
      }
    } else if (check.fallbackLoans[0] || check.fallbackLoans[1]) {
      foreignSet.add(term);
    }
  }
}

const filtered = freqList.filter((term) => {
  const norm = normalize(term);
  return !foreignSet.has(norm);
});

writeFileSync(outPath, JSON.stringify(filtered, null, 2) + "\n");
console.log(
  `Removed ${freqList.length - filtered.length} terms where def #1 or #2 has word_type=${targetType}`,
);
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

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function getWordInfo(entry: Entry): WordInfo | null {
  const attrs = entry.attrs;
  if (!attrs || typeof attrs !== "object") return null;
  const wordInfo = (attrs as Record<string, unknown>).wordInfo;
  if (!wordInfo || typeof wordInfo !== "object") return null;
  return wordInfo as WordInfo;
}

function hasWordType(wordType: WordInfo["word_type"], target: string) {
  if (!wordType) return false;
  if (typeof wordType === "string") return wordType === target;
  if (Array.isArray(wordType)) return wordType.includes(target);
  return false;
}

function getPrimaryWord(entry: Entry, wordInfo: WordInfo) {
  if (typeof entry.term === "string" && entry.term) return entry.term;
  const word = wordInfo.word;
  if (typeof word === "string") return word;
  if (Array.isArray(word) && word.length > 0) return String(word[0]);
  return null;
}

function extractIndex(value: string) {
  const match = value.match(/(\d+)$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function collectCandidates(entry: Entry, wordInfo: WordInfo) {
  const out: string[] = [];
  if (entry.term) out.push(entry.term);
  const word = wordInfo.word;
  if (typeof word === "string") out.push(word);
  if (Array.isArray(word)) out.push(...word);
  return out;
}
