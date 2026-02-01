import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

type LineInfo = {
  id: string;
  original: string;
  isDict: boolean;
  formality?: string;
  tense?: string;
};

const root = process.cwd();
const examplesPath = join(root, "examples.txt");
const outDir = join(root, "out", "examples_rewrite2_tasks");
const conjugateDir = join(outDir, "conjugate");
const translateDir = join(outDir, "translate");
const manifestPath = join(root, "out", "examples_rewrite2_manifest.tsv");

const dictEndRegex = /다\.?$/;
const formalities = ["반말", "해요체", "합니다체"];

let seed = 42;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

const shuffle = <T>(items: T[]) => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const chunk = <T>(items: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const main = () => {
  const lines = readFileSync(examplesPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const infos: LineInfo[] = lines.map((original, idx) => {
    const id = String(idx + 1).padStart(5, "0");
    return {
      id,
      original,
      isDict: dictEndRegex.test(original),
    };
  });

  const dictLines = infos.filter((info) => info.isDict);
  const otherLines = infos.filter((info) => !info.isDict);

  const presentCount = Math.floor(dictLines.length / 2);
  const pastCount = dictLines.length - presentCount;

  const combos: Array<{ formality: string; tense: string }> = [];
  for (let i = 0; i < presentCount; i++) {
    combos.push({ formality: formalities[i % formalities.length], tense: "present" });
  }
  for (let i = 0; i < pastCount; i++) {
    combos.push({ formality: formalities[i % formalities.length], tense: "past" });
  }

  const shuffledCombos = shuffle(combos);
  dictLines.forEach((info, idx) => {
    const combo = shuffledCombos[idx];
    info.formality = combo.formality;
    info.tense = combo.tense;
  });

  mkdirSync(conjugateDir, { recursive: true });
  mkdirSync(translateDir, { recursive: true });

  const conjugateChunks = chunk(dictLines, Math.ceil(dictLines.length / 10));
  conjugateChunks.forEach((items, idx) => {
    const linesOut = ["ID\tformality\ttense\toriginal"];
    for (const item of items) {
      linesOut.push(`${item.id}\t${item.formality}\t${item.tense}\t${item.original}`);
    }
    const filename = join(conjugateDir, `conjugate-${String(idx + 1).padStart(2, "0")}.tsv`);
    writeFileSync(filename, linesOut.join("\n") + "\n");
  });

  const translateChunks = chunk(otherLines, Math.ceil(otherLines.length / 10));
  translateChunks.forEach((items, idx) => {
    const linesOut = ["ID\toriginal"];
    for (const item of items) {
      linesOut.push(`${item.id}\t${item.original}`);
    }
    const filename = join(translateDir, `translate-${String(idx + 1).padStart(2, "0")}.tsv`);
    writeFileSync(filename, linesOut.join("\n") + "\n");
  });

  const manifestLines = ["ID\ttype\tformality\ttense\toriginal"];
  for (const info of infos) {
    const type = info.isDict ? "conjugate" : "translate";
    manifestLines.push(
      [
        info.id,
        type,
        info.formality ?? "",
        info.tense ?? "",
        info.original,
      ].join("\t")
    );
  }
  writeFileSync(manifestPath, manifestLines.join("\n") + "\n");

  const summary = {
    total: infos.length,
    conjugate: dictLines.length,
    translate: otherLines.length,
    conjugateChunks: conjugateChunks.length,
    translateChunks: translateChunks.length,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
};

main();
