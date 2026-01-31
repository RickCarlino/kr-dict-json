#!/usr/bin/env bun
import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

type ChunkWriter = {
  canFit: (json: string) => boolean;
  add: (json: string) => number;
  finalize: () => void;
  hasEntries: () => boolean;
  entryCount: () => number;
};

const args = process.argv.slice(2);
const dirArg = getArg("--dir") ?? "out/by-initial";
const outArg = getArg("--out") ?? dirArg;
const maxArg = getArg("--max");
const maxBytes = maxArg ? Number(maxArg) : 1_000_000;
const onlyArg = getArg("--only");
const onlySet = onlyArg
  ? new Set(
      onlyArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
const dedupe = !args.includes("--no-dedupe");
const removeOriginal = args.includes("--remove-original");
const dryRun = args.includes("--dry-run");

if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
  throw new Error(`Invalid --max value: ${maxArg}`);
}

const inDir = path.resolve(dirArg);
const outDir = path.resolve(outArg);
mkdirSync(outDir, { recursive: true });

const files = readdirSync(inDir, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json"))
  .map((e) => path.join(inDir, e.name))
  .sort();

let splitCount = 0;
for (const filePath of files) {
  const base = path.basename(filePath, ".json");
  if (base === "attribute-summary") continue;
  if (/\d{3}$/.test(base)) continue; // skip already chunked
  if (onlySet && !onlySet.has(base)) continue;

  const size = statSync(filePath).size;
  if (size <= maxBytes) continue;

  console.log(`Splitting ${path.relative(process.cwd(), filePath)} (${formatBytes(size)})`);
  const chunkTotal = await splitFile(filePath, base, outDir, maxBytes, dryRun);
  if (chunkTotal > 0) splitCount += 1;

  if (removeOriginal && !dryRun) {
    unlinkSync(filePath);
  }
}

console.log(`Done. Files split: ${splitCount}`);

function getArg(name: string) {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

async function splitFile(
  filePath: string,
  base: string,
  outDir: string,
  maxBytes: number,
  dryRun: boolean,
) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let chunkIndex = 1;
  let chunk = createChunkWriter(base, chunkIndex, outDir, maxBytes, dryRun);
  let totalChunks = 0;
  const seen = dedupe ? new Set<string>() : null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[" || trimmed === "]") continue;

    const jsonLine = trimmed.endsWith(",") ? trimmed.slice(0, -1).trim() : trimmed;
    if (!jsonLine) continue;
    if (seen) {
      if (seen.has(jsonLine)) continue;
      seen.add(jsonLine);
    }

    if (!chunk.canFit(jsonLine) && chunk.hasEntries()) {
      chunk.finalize();
      totalChunks += 1;
      chunkIndex += 1;
      chunk = createChunkWriter(base, chunkIndex, outDir, maxBytes, dryRun);
    }

    if (!chunk.canFit(jsonLine) && !chunk.hasEntries()) {
      const entryBytes = Buffer.byteLength(jsonLine);
      console.warn(
        `  warning: single entry exceeds max (${formatBytes(entryBytes)} > ${formatBytes(maxBytes)})`,
      );
    }

    chunk.add(jsonLine);
  }

  if (chunk.hasEntries()) {
    chunk.finalize();
    totalChunks += 1;
  }

  return totalChunks;
}

function createChunkWriter(
  base: string,
  index: number,
  outDir: string,
  maxBytes: number,
  dryRun: boolean,
): ChunkWriter {
  const indexStr = String(index).padStart(3, "0");
  const outPath = path.join(outDir, `${base}${indexStr}.json`);
  const opening = "[\n";
  const closing = "\n]\n";
  const closingBytes = Buffer.byteLength(closing);

  const parts: string[] = [opening];
  let bytes = Buffer.byteLength(opening);
  let first = true;
  let count = 0;

  const canFit = (json: string) => {
    const entryBytes = Buffer.byteLength((first ? "" : ",\n") + json);
    return bytes + entryBytes + closingBytes <= maxBytes;
  };

  const add = (json: string) => {
    const prefix = first ? "" : ",\n";
    const entryStr = prefix + json;
    const entryBytes = Buffer.byteLength(entryStr);
    parts.push(entryStr);
    bytes += entryBytes;
    first = false;
    count += 1;
    return entryBytes;
  };

  const finalize = () => {
    if (count === 0) return;
    parts.push(closing);
    const content = parts.join("");
    if (!dryRun) {
      writeFileSync(outPath, content);
    }
    console.log(`  -> ${path.relative(process.cwd(), outPath)} (${formatBytes(Buffer.byteLength(content))})`);
  };

  return {
    canFit,
    add,
    finalize,
    hasEntries: () => count > 0,
    entryCount: () => count,
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
