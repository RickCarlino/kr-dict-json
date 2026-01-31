#!/usr/bin/env bun
import { createReadStream, appendFileSync, mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sax from "sax";

type Source = "krdict" | "opendict" | "stdict";

type EntryOut = {
  term: string;
  definitions: string[];
  source: Source;
  attrs?: Record<string, unknown>;
  senses?: Record<string, unknown>[];
};

type Summary = {
  krdict: {
    featAtt: Set<string>;
    xmlAttrNames: Set<string>;
  };
  opendict: {
    wordInfoTags: Set<string>;
    senseInfoTags: Set<string>;
  };
  stdict: {
    wordInfoTags: Set<string>;
    senseInfoTags: Set<string>;
  };
};

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "out");
const BY_INITIAL_DIR = path.join(OUT_DIR, "by-initial");
const ATTRIBUTE_SUMMARY_PATH = path.join(OUT_DIR, "attribute-summary.json");

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="));
const onlySet = onlyArg
  ? new Set(
      onlyArg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
  : null;
const clean = !args.includes("--no-clean");

if (clean) {
  rmSync(BY_INITIAL_DIR, { recursive: true, force: true });
}
mkdirSync(BY_INITIAL_DIR, { recursive: true });

const summary: Summary = {
  krdict: { featAtt: new Set(), xmlAttrNames: new Set() },
  opendict: { wordInfoTags: new Set(), senseInfoTags: new Set() },
  stdict: { wordInfoTags: new Set(), senseInfoTags: new Set() },
};

class ShardedWriter {
  private buffers = new Map<string, string>();
  private touched = new Set<string>();
  constructor(private outDir: string, private maxBufferChars = 1_000_000) {}

  write(term: string, entry: EntryOut) {
    const key = shardKey(term);
    const filePath = path.join(this.outDir, `${key}.json`);
    const prefix = this.touched.has(filePath) ? ",\n" : "[\n";
    this.touched.add(filePath);

    const json = JSON.stringify(entry);
    const next = (this.buffers.get(filePath) ?? "") + prefix + json;
    this.buffers.set(filePath, next);

    if (next.length >= this.maxBufferChars) {
      this.flush(filePath);
    }
  }

  flush(filePath: string) {
    const buf = this.buffers.get(filePath);
    if (buf && buf.length > 0) {
      appendFileSync(filePath, buf);
      this.buffers.set(filePath, "");
    }
  }

  finalize() {
    for (const filePath of this.buffers.keys()) {
      this.flush(filePath);
    }
    for (const filePath of this.touched) {
      appendFileSync(filePath, "\n]\n");
    }
  }
}

const writer = new ShardedWriter(BY_INITIAL_DIR);

const krdictDirs = ["krdict"];
const opendictDirs = ["opendict"];
const stdictDirs = ["stdict"];

async function main() {
  if (!onlySet || onlySet.has("krdict")) {
    await parseDir(krdictDirs, "krdict");
  }
  if (!onlySet || onlySet.has("opendict")) {
    await parseDir(opendictDirs, "opendict");
  }
  if (!onlySet || onlySet.has("stdict")) {
    await parseDir(stdictDirs, "stdict");
  }

  writer.finalize();

  const summaryOut = {
    krdict: {
      featAtt: sorted(summary.krdict.featAtt),
      xmlAttrNames: sorted(summary.krdict.xmlAttrNames),
    },
    opendict: {
      wordInfoTags: sorted(summary.opendict.wordInfoTags),
      senseInfoTags: sorted(summary.opendict.senseInfoTags),
    },
    stdict: {
      wordInfoTags: sorted(summary.stdict.wordInfoTags),
      senseInfoTags: sorted(summary.stdict.senseInfoTags),
    },
  };
  writeFileSync(ATTRIBUTE_SUMMARY_PATH, JSON.stringify(summaryOut, null, 2) + "\n");

  console.log("Done. Output:");
  console.log(`- ${BY_INITIAL_DIR}`);
  console.log(`- ${ATTRIBUTE_SUMMARY_PATH}`);
}

async function parseDir(dirs: string[], source: Source) {
  for (const dir of dirs) {
    const absDir = path.join(ROOT, dir);
    const files = listXmlFiles(absDir);
    for (const filePath of files) {
      console.log(`[${source}] ${path.relative(ROOT, filePath)}`);
      if (source === "krdict") {
        await parseKrdictFile(filePath);
      } else if (source === "opendict") {
        await parseItemFile(filePath, "opendict");
      } else if (source === "stdict") {
        await parseItemFile(filePath, "stdict");
      }
    }
  }
}

function listXmlFiles(dir: string) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".xml"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

function shardKey(term: string) {
  const trimmed = term.trim();
  if (!trimmed) return "_";
  const first = Array.from(trimmed)[0] ?? "_";
  if (first === "/" || first === "\\" || first === "\u0000") return "_";
  return first;
}

function sorted(set: Set<string>) {
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function textValue(raw: string) {
  return raw.replace(/\s+/g, " ").trim();
}

function getAttr(node: sax.Tag, name: string) {
  const value = (node.attributes as Record<string, unknown>)[name];
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value && "value" in value) {
    return String((value as { value: unknown }).value);
  }
  return String(value);
}

async function parseKrdictFile(filePath: string) {
  return new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, { lowercase: true, trim: false });

    let entry: EntryOut | null = null;
    let entryAttrs: Record<string, string> = {};
    let pronunciations: Record<string, string>[] = [];
    let currentWordForm: Record<string, string> | null = null;
    let currentSense: Record<string, unknown> | null = null;
    let inLemma = false;
    let senseDepth = 0;

    parser.on("opentag", (node: sax.Tag) => {
      const tag = node.name;

      for (const attrName of Object.keys(node.attributes ?? {})) {
        summary.krdict.xmlAttrNames.add(attrName);
      }

      if (tag === "lexicalentry") {
        entry = {
          term: "",
          definitions: [],
          source: "krdict",
        };
        entryAttrs = {};
        pronunciations = [];

        const att = getAttr(node, "att");
        const val = getAttr(node, "val");
        if (att && val != null) {
          entryAttrs[att] = String(val);
        }
        return;
      }

      if (!entry) return;

      if (tag === "lemma") {
        inLemma = true;
        return;
      }
      if (tag === "wordform") {
        currentWordForm = {};
        return;
      }
      if (tag === "sense") {
        senseDepth += 1;
        if (senseDepth === 1) {
          currentSense = {};
          const att = getAttr(node, "att");
          const val = getAttr(node, "val");
          if (att && val != null) {
            currentSense[att] = String(val);
          }
        }
        return;
      }

      if (tag === "feat") {
        const att = getAttr(node, "att");
        const val = getAttr(node, "val");
        if (!att || val == null) return;

        summary.krdict.featAtt.add(att);

        const attLower = att.toLowerCase();
        const value = String(val);

        if (currentWordForm) {
          currentWordForm[att] = value;
          return;
        }

        if (senseDepth > 0 && currentSense) {
          if (attLower === "definition") {
            entry.definitions.push(value);
            addField(currentSense, "definition", value);
          } else if (attLower === "example") {
            addField(currentSense, "example", value);
          } else {
            addField(currentSense, att, value);
          }
          return;
        }

        entryAttrs[att] = value;
        if (!entry.term && inLemma && attLower === "writtenform") {
          entry.term = value;
        }
      }
    });

    parser.on("closetag", (name: string) => {
      if (name === "lemma") {
        inLemma = false;
        return;
      }

      if (name === "wordform") {
        if (currentWordForm && Object.keys(currentWordForm).length > 0) {
          pronunciations.push(currentWordForm);
        }
        currentWordForm = null;
        return;
      }

      if (name === "sense") {
        if (currentSense && Object.keys(currentSense).length > 0 && entry) {
          entry.senses ??= [];
          entry.senses.push(currentSense);
        }
        currentSense = null;
        senseDepth = Math.max(0, senseDepth - 1);
        return;
      }

      if (name === "lexicalentry") {
        if (entry) {
          if (Object.keys(entryAttrs).length > 0) {
            entry.attrs = { ...(entry.attrs ?? {}), entry: entryAttrs };
          }
          if (pronunciations.length > 0) {
            entry.attrs = { ...(entry.attrs ?? {}), pronunciations };
          }
          if (!entry.term) {
            const fallback = entryAttrs.writtenForm ?? entryAttrs.writtenform;
            if (fallback) entry.term = fallback;
          }
          if (entry.term) {
            entry.definitions = dedupe(entry.definitions);
            writer.write(entry.term, entry);
          }
        }
        entry = null;
        entryAttrs = {};
        pronunciations = [];
        currentWordForm = null;
        currentSense = null;
        inLemma = false;
        senseDepth = 0;
      }
    });

    parser.on("error", (err: Error) => {
      reject(err);
    });
    parser.on("end", () => resolve());

    createReadStream(filePath).pipe(parser);
  });
}

async function parseItemFile(filePath: string, source: "opendict" | "stdict") {
  return new Promise<void>((resolve, reject) => {
    const parser = sax.createStream(true, { lowercase: true, trim: false });

    const wordInfoTag = source === "opendict" ? "wordinfo" : "word_info";
    const senseInfoTag = source === "opendict" ? "senseinfo" : "sense_info";

    const wordContainerTags = new Set(
      source === "opendict"
        ? ["wordinfo", "pronunciation_info", "conju_info", "conjugation_info"]
        : ["word_info", "pronunciation_info", "pos_info", "comm_pattern_info"],
    );

    const senseContainerTags = new Set(
      source === "opendict"
        ? ["senseinfo", "cat_info", "example_info", "relation_info"]
        : ["sense_info", "sense_grammar_info", "cat_info", "example_info"],
    );

    const tagStack: { name: string; text: string }[] = [];
    let entry: EntryOut | null = null;
    let wordInfoDepth = 0;
    let senseInfoDepth = 0;
    let wordInfoAttrs: Record<string, unknown> = {};
    let currentSense: Record<string, unknown> | null = null;

    parser.on("opentag", (node: sax.Tag) => {
      tagStack.push({ name: node.name, text: "" });

      if (node.name === "item") {
        entry = { term: "", definitions: [], source };
        wordInfoAttrs = {};
        return;
      }

      if (node.name === wordInfoTag) {
        wordInfoDepth += 1;
        return;
      }

      if (node.name === senseInfoTag) {
        senseInfoDepth += 1;
        if (senseInfoDepth === 1) {
          currentSense = {};
        }
      }
    });

    parser.on("text", (text: string) => {
      if (tagStack.length > 0) {
        tagStack[tagStack.length - 1].text += text;
      }
    });

    parser.on("cdata", (text: string) => {
      if (tagStack.length > 0) {
        tagStack[tagStack.length - 1].text += text;
      }
    });

    parser.on("closetag", (name: string) => {
      const node = tagStack.pop();
      if (!node || !entry) return;

      const tag = node.name;
      const text = textValue(node.text);
      const inWordInfo = wordInfoDepth > 0;
      const inSenseInfo = senseInfoDepth > 0;

      if (text) {
        if (inWordInfo) {
          if (tag === "word" && !entry.term) {
            entry.term = text;
          }
          if (!wordContainerTags.has(tag)) {
            addField(wordInfoAttrs, tag, text);
            summary[source].wordInfoTags.add(tag);
          }
        }

        if (inSenseInfo && currentSense) {
          if (tag === "definition") {
            entry.definitions.push(text);
          }
          if (!senseContainerTags.has(tag)) {
            addField(currentSense, tag, text);
            summary[source].senseInfoTags.add(tag);
          }
        }
      }

      if (tag === senseInfoTag) {
        if (senseInfoDepth === 1 && currentSense && Object.keys(currentSense).length > 0) {
          entry.senses ??= [];
          entry.senses.push(currentSense);
        }
        senseInfoDepth = Math.max(0, senseInfoDepth - 1);
        if (senseInfoDepth === 0) currentSense = null;
        return;
      }

      if (tag === wordInfoTag) {
        wordInfoDepth = Math.max(0, wordInfoDepth - 1);
        return;
      }

      if (tag === "item") {
        if (Object.keys(wordInfoAttrs).length > 0) {
          entry.attrs = { ...(entry.attrs ?? {}), wordInfo: wordInfoAttrs };
        }
        entry.definitions = dedupe(entry.definitions);
        if (entry.term) {
          writer.write(entry.term, entry);
        }
        entry = null;
      }
    });

    parser.on("error", (err: Error) => {
      reject(err);
    });
    parser.on("end", () => resolve());

    createReadStream(filePath).pipe(parser);
  });
}

function addField(obj: Record<string, unknown>, key: string, value: string) {
  if (!value) return;
  const existing = obj[key];
  if (existing == null) {
    obj[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    obj[key] = [existing, value];
  }
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
