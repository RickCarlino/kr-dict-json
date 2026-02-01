import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

type Task = {
  id: string;
  formality: string;
  tense: string;
  original: string;
};

type Output = {
  id: string;
  korean: string;
  english: string;
};

type Kept = Task & Output;

type Dropped = {
  id: string;
  reason: string;
  formality?: string;
  tense?: string;
  original?: string;
  korean?: string;
  english?: string;
};

const root = process.cwd();
const tasksDir = join(root, "out", "examples_rewrite_tasks");
const outputsDir = join(root, "out", "examples_rewrite_csv");

const outWithId = join(outputsDir, "examples-rewrite-with-id.csv");
const outNoId = join(outputsDir, "examples-rewrite.csv");
const outReview = join(root, "out", "examples_rewrite_review.tsv");
const outSummary = join(root, "out", "examples_rewrite_summary.json");

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

const normalizeKorean = (value: string) => {
  let text = value.trim();
  text = text.replace(/[)”’"'\]]+$/g, "");
  text = text.replace(/[.!?]+$/g, "");
  return text.trim();
};

const matchesEnding = (formality: string, tense: string, text: string) => {
  const key = formality.trim();
  const t = tense.trim();
  if (key === "해요체") {
    if (t === "present") {
      return /(?:해요|아요|어요|예요|네요|죠)$/.test(text);
    }
    if (t === "past") {
      return /(?:했어요|았어요|었어요)$/.test(text);
    }
  }
  if (key === "합니다체") {
    if (t === "present") {
      return /(?:합니다|됩니다|입니다|습니다)$/.test(text);
    }
    if (t === "past") {
      return /(?:했습니다|되었습니다|였습니다|았습니다|었습니다|됐습니다)$/.test(text);
    }
  }
  if (key === "반말") {
    if (t === "present") {
      return /(?:해|아|어|야|지|네|구나|거야)$/.test(text);
    }
    if (t === "past") {
      return /(?:했어|았어|었어|했지|했네|했구나)$/.test(text);
    }
  }
  return false;
};

const readTasks = () => {
  const taskFiles = readdirSync(tasksDir)
    .filter((file) => file.startsWith("rewrite-") && file.endsWith(".tsv"))
    .sort();
  const tasks = new Map<string, Task>();
  for (const file of taskFiles) {
    const content = readFileSync(join(tasksDir, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [id, formality, tense, original] = line.split("\t");
      if (!id || !formality || !tense || original === undefined) continue;
      tasks.set(id.trim(), {
        id: id.trim(),
        formality: formality.trim(),
        tense: tense.trim(),
        original: original.trim(),
      });
    }
  }
  return tasks;
};

const readOutputs = () => {
  const outputFiles = readdirSync(outputsDir)
    .filter((file) => file.startsWith("rewrite-") && file.endsWith(".csv"))
    .sort();
  const outputs = new Map<string, Output>();
  for (const file of outputFiles) {
    const content = readFileSync(join(outputsDir, file), "utf8");
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
  const tasks = readTasks();
  const outputs = readOutputs();
  const kept: Kept[] = [];
  const dropped: Dropped[] = [];

  for (const [id, output] of outputs.entries()) {
    const task = tasks.get(id);
    if (!task) {
      dropped.push({ id, reason: "missing_task", korean: output.korean, english: output.english });
      continue;
    }

    const korean = output.korean.trim();
    const english = output.english.trim();
    if (!korean || !english) {
      dropped.push({
        id,
        reason: "blank_output",
        formality: task.formality,
        tense: task.tense,
        original: task.original,
        korean,
        english,
      });
      continue;
    }

    const normalized = normalizeKorean(korean);
    if (normalized.endsWith("다")) {
      dropped.push({
        id,
        reason: "dictionary_ending",
        formality: task.formality,
        tense: task.tense,
        original: task.original,
        korean,
        english,
      });
      continue;
    }

    if (!matchesEnding(task.formality, task.tense, normalized)) {
      dropped.push({
        id,
        reason: "ending_mismatch",
        formality: task.formality,
        tense: task.tense,
        original: task.original,
        korean,
        english,
      });
      continue;
    }

    kept.push({
      ...task,
      korean,
      english,
    });
  }

  const present = kept.filter((row) => row.tense === "present");
  const past = kept.filter((row) => row.tense === "past");
  const target = Math.min(present.length, past.length);
  const rebalanceDrop: Dropped[] = [];

  const sortById = (a: Kept, b: Kept) => a.id.localeCompare(b.id, "en");
  const balanced = [
    ...present.sort(sortById).slice(0, target),
    ...past.sort(sortById).slice(0, target),
  ].sort(sortById);

  if (present.length !== past.length) {
    const keptIds = new Set(balanced.map((row) => row.id));
    for (const row of kept) {
      if (!keptIds.has(row.id)) {
        rebalanceDrop.push({
          id: row.id,
          reason: "rebalance",
          formality: row.formality,
          tense: row.tense,
          original: row.original,
          korean: row.korean,
          english: row.english,
        });
      }
    }
  }

  const allDropped = [...dropped, ...rebalanceDrop];

  writeFileSync(
    outWithId,
    balanced.map((row) => [row.id, row.korean, row.english].map(csvEscape).join(",")).join("\n") + "\n"
  );

  writeFileSync(
    outNoId,
    balanced.map((row) => [row.korean, row.english].map(csvEscape).join(",")).join("\n") + "\n"
  );

  const reviewLines = allDropped.map((row) => {
    const cells = [
      row.id,
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

  const summary = {
    tasks: tasks.size,
    outputs: outputs.size,
    kept: balanced.length,
    dropped: allDropped.length,
    keptPresent: balanced.filter((row) => row.tense === "present").length,
    keptPast: balanced.filter((row) => row.tense === "past").length,
    droppedByReason: allDropped.reduce<Record<string, number>>((acc, row) => {
      acc[row.reason] = (acc[row.reason] ?? 0) + 1;
      return acc;
    }, {}),
  };
  writeFileSync(outSummary, JSON.stringify(summary, null, 2) + "\n");
};

main();
