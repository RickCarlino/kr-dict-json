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

type SentenceItem = {
  sentence: string;
  words: string[];
  firstIndex: number;
};

type Candidate = {
  item: SentenceItem;
  unknown: string[];
};

type OutputItem = {
  sequence: number;
  sentence: string;
  newWords: string[];
  allWords: string[];
};

const args = process.argv.slice(2);
const inDir = getArg("--in-dir") ?? "out/mini-dictform";
const rankPath = getArg("--rank") ?? "out/mini-dictform-rank.json";
const outFile = getArg("--out") ?? "out/mini-learning-order.json";
const topRaw = getArg("--top") ?? "25";

const topN = Number(topRaw);
if (!Number.isFinite(topN) || topN < 0) {
  console.error(`Invalid --top value: ${topRaw}`);
  process.exit(1);
}

const known = new Set<string>(loadTopWords(rankPath, topN));
const items = loadSentences(inDir);

let remaining = items.slice();
let sequence = 1;
const output: OutputItem[] = [];

while (remaining.length > 0) {
  const candidates: Candidate[] = [];
  const zeros: Candidate[] = [];
  const ones: Candidate[] = [];
  let minUnknown = Infinity;

  for (const item of remaining) {
    const unknown = item.words.filter((w) => !known.has(w));
    const candidate = { item, unknown };
    candidates.push(candidate);

    if (unknown.length === 0) {
      zeros.push(candidate);
      continue;
    }
    if (unknown.length === 1) {
      ones.push(candidate);
      continue;
    }
    if (unknown.length < minUnknown) minUnknown = unknown.length;
  }

  if (zeros.length > 0) {
    zeros.sort(byFirstIndex);
    const zeroSet = new Set<string>();
    for (const candidate of zeros) {
      output.push({
        sequence,
        sentence: candidate.item.sentence,
        newWords: [],
        allWords: candidate.item.words.slice(),
      });
      sequence += 1;
      zeroSet.add(candidate.item.sentence);
    }
    remaining = remaining.filter((item) => !zeroSet.has(item.sentence));
    continue;
  }

  const wordCounts = buildWordCounts(candidates);

  let pick: Candidate | null = null;
  if (ones.length > 0) {
    pick = pickBest(ones, (c) => wordCounts.get(c.unknown[0]) ?? 0);
  } else {
    const minCandidates = candidates.filter((c) => c.unknown.length === minUnknown);
    pick = pickBest(minCandidates, (c) => sumWordCounts(c.unknown, wordCounts));
  }

  if (!pick) break;

  for (const word of pick.unknown) known.add(word);
  output.push({
    sequence,
    sentence: pick.item.sentence,
    newWords: pick.unknown.slice(),
    allWords: pick.item.words.slice(),
  });
  sequence += 1;

  remaining = remaining.filter((item) => item !== pick!.item);
}

writeFileSync(path.resolve(outFile), JSON.stringify(output, null, 2));

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function readJson<T>(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function loadTopWords(rankFile: string, top: number) {
  if (top === 0) return [];
  const data = readJson<RankItem[]>(path.resolve(rankFile));
  return data.slice(0, top).map((row) => row.word).filter(Boolean);
}

function loadSentences(dir: string) {
  const dirPath = path.resolve(dir);
  const files = readdirSync(dirPath)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`No .json files found in ${dirPath}`);
    process.exit(1);
  }

  const map = new Map<string, { words: Set<string>; firstIndex: number }>();
  let index = 0;

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    let data: SentenceResult[];
    try {
      data = readJson<SentenceResult[]>(filePath);
    } catch (err) {
      console.error(`Failed to parse ${filePath}:`, err);
      continue;
    }

    for (const row of data) {
      const sentence = typeof row.sentence === "string" ? row.sentence.trim() : "";
      if (!sentence) continue;
      if (!Array.isArray(row.dictForms)) continue;

      const uniqueWords = new Set(row.dictForms.filter((w) => typeof w === "string" && w.trim()));
      if (uniqueWords.size === 0) continue;

      let entry = map.get(sentence);
      if (!entry) {
        entry = { words: new Set(), firstIndex: index };
        map.set(sentence, entry);
        index += 1;
      }

      for (const word of uniqueWords) entry.words.add(word);
    }
  }

  const items: SentenceItem[] = [];
  for (const [sentence, entry] of map.entries()) {
    items.push({
      sentence,
      words: Array.from(entry.words),
      firstIndex: entry.firstIndex,
    });
  }

  items.sort(byFirstIndex);
  return items;
}

function buildWordCounts(candidates: Candidate[]) {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const word of candidate.unknown) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

function sumWordCounts(words: string[], counts: Map<string, number>) {
  let total = 0;
  for (const word of words) total += counts.get(word) ?? 0;
  return total;
}

function pickBest(candidates: Candidate[], scoreFn: (c: Candidate) => number) {
  let best: Candidate | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const score = scoreFn(candidate);
    if (!best || score > bestScore) {
      best = candidate;
      bestScore = score;
      continue;
    }
    if (score === bestScore && compareCandidate(candidate, best) < 0) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function compareCandidate(a: Candidate, b: Candidate) {
  if (a.item.firstIndex !== b.item.firstIndex) {
    return a.item.firstIndex - b.item.firstIndex;
  }
  return a.item.sentence.localeCompare(b.item.sentence);
}

function byFirstIndex(a: Candidate | SentenceItem, b: Candidate | SentenceItem) {
  const aIndex = "item" in a ? a.item.firstIndex : a.firstIndex;
  const bIndex = "item" in b ? b.item.firstIndex : b.firstIndex;
  if (aIndex !== bIndex) return aIndex - bIndex;
  const aSentence = "item" in a ? a.item.sentence : a.sentence;
  const bSentence = "item" in b ? b.item.sentence : b.sentence;
  return aSentence.localeCompare(bSentence);
}
