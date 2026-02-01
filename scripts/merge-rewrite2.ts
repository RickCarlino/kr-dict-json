import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

type ManifestRow = {
  id: string;
  type: "conjugate" | "translate";
  formality?: string;
  tense?: string;
  original: string;
};

type OutputRow = {
  id: string;
  korean: string;
  english: string;
};

type Dropped = {
  id: string;
  reason: string;
  type?: string;
  formality?: string;
  tense?: string;
  original?: string;
  korean?: string;
  english?: string;
};

const root = process.cwd();
const manifestPath = join(root, "out", "examples_rewrite2_manifest.tsv");
const outputsDir = join(root, "out", "examples_rewrite2_csv");
const outWithId = join(outputsDir, "examples-rewrite-with-id.csv");
const outNoId = join(outputsDir, "examples-rewrite.csv");
const outReview = join(root, "out", "examples_rewrite2_review.tsv");
const outWarnings = join(root, "out", "examples_rewrite2_warnings.tsv");
const outSummary = join(root, "out", "examples_rewrite2_summary.json");

const dictEndRegex = /다$/;

const normalizeKorean = (text: string) =>
  text.trim().replace(/[.!?]+$/g, "");

const csvEscape = (value: string) => `"${value.replace(/"/g, "\"\"")}"`;

const parseCsvLine = (line: string) => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === "\"") {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
};

const matchesEnding = (formality: string, tense: string, text: string) => {
  const normalized = normalizeKorean(text);
  const key = formality.trim();
  const t = tense.trim();
  if (key === "해요체") {
    if (t === "present") {
      return /(?:해요|아요|어요|예요|네요|죠)$/.test(normalized);
    }
    if (t === "past") {
      return /(?:했어요|았어요|었어요)$/.test(normalized);
    }
  }
  if (key === "합니다체") {
    if (t === "present") {
      return /(?:합니다|됩니다|입니다|습니다)$/.test(normalized);
    }
    if (t === "past") {
      return /(?:했습니다|되었습니다|였습니다|았습니다|었습니다|됐습니다)$/.test(normalized);
    }
  }
  if (key === "반말") {
    if (t === "present") {
      return /(?:해|아|어|야|지|네|구나|거야)$/.test(normalized);
    }
    if (t === "past") {
      return /(?:했어|았어|었어|했지|했네|했구나)$/.test(normalized);
    }
  }
  return false;
};

const readManifest = () => {
  const manifest = new Map<string, ManifestRow>();
  const content = readFileSync(manifestPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("ID\t")) continue;
    const [id, type, formality, tense, original] = line.split("\t");
    if (!id || !type || original === undefined) continue;
    manifest.set(id, {
      id,
      type: type as ManifestRow["type"],
      formality: formality || undefined,
      tense: tense || undefined,
      original,
    });
  }
  return manifest;
};

const readOutputs = (dir: string) => {
  const outputs = new Map<string, OutputRow>();
  if (!dir) return outputs;
  if (!readdirSync(dir, { withFileTypes: true }).length) return outputs;
  const files = readdirSync(dir).filter((file) => file.endsWith(".csv")).sort();
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parts = parseCsvLine(line);
      if (parts.length < 3) continue;
      const [id, korean, english] = parts;
      if (!id) continue;
      outputs.set(id.trim(), {
        id: id.trim(),
        korean: (korean ?? "").trim(),
        english: (english ?? "").trim(),
      });
    }
  }
  return outputs;
};

const main = () => {
  mkdirSync(outputsDir, { recursive: true });
  const manifest = readManifest();
  const conjugateOutputs = readOutputs(join(outputsDir, "conjugate"));
  const translateOutputs = readOutputs(join(outputsDir, "translate"));

  const kept: OutputRow[] = [];
  const dropped: Dropped[] = [];
  const warnings: Dropped[] = [];

  for (const [id, info] of manifest.entries()) {
    const source = info.type === "conjugate" ? conjugateOutputs : translateOutputs;
    const output = source.get(id);
    if (!output) {
      dropped.push({ id, reason: "missing_output", type: info.type, original: info.original });
      continue;
    }

    const english = output.english.trim();
    if (!english) {
      dropped.push({
        id,
        reason: "blank_english",
        type: info.type,
        original: info.original,
      });
      continue;
    }

    if (info.type === "translate") {
      // Keep original Korean intact, regardless of what the model returned.
      kept.push({ id, korean: info.original, english });
      continue;
    }

    const korean = output.korean.trim();
    if (!korean) {
      dropped.push({
        id,
        reason: "blank_korean",
        type: info.type,
        formality: info.formality,
        tense: info.tense,
        original: info.original,
      });
      continue;
    }

    const normalized = normalizeKorean(korean);
    if (dictEndRegex.test(normalized)) {
      const isValidFormal = info.formality && info.tense
        ? matchesEnding(info.formality, info.tense, korean)
        : false;
      if (!isValidFormal) {
        dropped.push({
          id,
          reason: "dictionary_ending",
          type: info.type,
          formality: info.formality,
          tense: info.tense,
          original: info.original,
          korean,
          english,
        });
        continue;
      }
    }

    if (info.formality && info.tense && !matchesEnding(info.formality, info.tense, korean)) {
      warnings.push({
        id,
        reason: "ending_mismatch",
        type: info.type,
        formality: info.formality,
        tense: info.tense,
        original: info.original,
        korean,
        english,
      });
    }

    kept.push({ id, korean, english });
  }

  // Keep ordering by ID (original order)
  kept.sort((a, b) => a.id.localeCompare(b.id, "en"));

  writeFileSync(
    outWithId,
    kept.map((row) => [row.id, row.korean, row.english].map(csvEscape).join(",")).join("\n") + "\n"
  );

  writeFileSync(
    outNoId,
    kept.map((row) => [row.korean, row.english].map(csvEscape).join(",")).join("\n") + "\n"
  );

  const reviewLines = dropped.map((row) => {
    const cells = [
      row.id,
      row.type ?? "",
      row.formality ?? "",
      row.tense ?? "",
      row.reason,
      (row.original ?? "").replace(/\t/g, " "),
      (row.korean ?? "").replace(/\t/g, " "),
      (row.english ?? "").replace(/\t/g, " "),
    ];
    return cells.join("\t");
  });
  writeFileSync(outReview, reviewLines.join("\n") + "\n");

  const warningLines = warnings.map((row) => {
    const cells = [
      row.id,
      row.type ?? "",
      row.formality ?? "",
      row.tense ?? "",
      row.reason,
      (row.original ?? "").replace(/\t/g, " "),
      (row.korean ?? "").replace(/\t/g, " "),
      (row.english ?? "").replace(/\t/g, " "),
    ];
    return cells.join("\t");
  });
  writeFileSync(outWarnings, warningLines.join("\n") + "\n");

  const summary = {
    total: manifest.size,
    kept: kept.length,
    dropped: dropped.length,
    droppedByReason: dropped.reduce<Record<string, number>>((acc, row) => {
      acc[row.reason] = (acc[row.reason] ?? 0) + 1;
      return acc;
    }, {}),
    warningsByReason: warnings.reduce<Record<string, number>>((acc, row) => {
      acc[row.reason] = (acc[row.reason] ?? 0) + 1;
      return acc;
    }, {}),
  };
  writeFileSync(outSummary, JSON.stringify(summary, null, 2) + "\n");
};

main();
