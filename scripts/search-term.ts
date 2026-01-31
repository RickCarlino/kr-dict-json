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
  console.error("Usage: bun scripts/search-term.ts <term> [--dir=out/by-initial] [--all] [--first]");
  process.exit(1);
}

const term = args[0];
const dirArg = getArg("--dir") ?? "out/by-initial";
const searchAll = args.includes("--all");
const firstOnly = args.includes("--first");

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
  console.error(`No files found for initial '${firstChar}' in ${dirPath}`);
  process.exit(1);
}

const matches: Entry[] = [];

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
    if (isMatch(entry, inputTrimmed, normalizedInput)) {
      matches.push(entry);
      if (firstOnly) {
        printMatches(matches);
        process.exit(0);
      }
    }
  }
}

printMatches(matches);
if (matches.length === 0) process.exit(2);

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

function isMatch(entry: Entry, raw: string, normalized: string) {
  const candidates = new Set<string>();
  if (entry.term) candidates.add(entry.term);
  if (entry.attrs) collectStrings(entry.attrs, candidates);

  for (const candidate of candidates) {
    if (candidate === raw) return true;
    if (normalize(candidate) === normalized) return true;
  }
  return false;
}

function printMatches(found: Entry[]) {
  if (found.length === 0) {
    console.log("[]");
    return;
  }
  console.log(JSON.stringify(found, null, 2));
}
