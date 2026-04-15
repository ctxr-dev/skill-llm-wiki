// provenance.mjs — byte-range traceability from source files to wiki
// leaves, with a loud LOSS-01 invariant.
//
// Git tracks file-level transitions (via rename detection). It does NOT
// track "which bytes of source file X became which bytes of wiki leaf Y"
// — especially important for the DECOMPOSE / NEST operators which split
// one source into several leaves. `<wiki>/.llmwiki/provenance.yaml`
// fills that gap as a semantic layer on top of git.
//
// Schema:
//
//   version: 1
//   corpus:
//     root: /abs/path/to/source
//     root_hash: sha256:...
//     pre_commit: <sha of pre-op/<first-op-id> in the private git>
//     ingested_at: 2026-04-14T19:53:00Z
//   targets:
//     api/hello.md:
//       sources:
//         - source_path: api/hello.md
//           source_pre_hash: sha256:...
//           source_size: 4900
//           byte_range: [0, 4821]
//           disposition: preserved
//       discarded_ranges:
//         - source_path: api/hello.md
//           byte_range: [4821, 4900]
//           reason: "trailing whitespace"
//
// Keyed by target so Build can append one entry per drafted leaf. For
// LOSS-01 verification we compute the reverse mapping on demand. For
// incremental refresh (Phase 4+ extend), the corpus entry gives us the
// source path + hash to compare against the current filesystem state.
//
// This module is pure: it reads and writes YAML through hand-rolled
// emitters (same pattern as history.mjs) so we add no dependency and
// the file stays deterministic across runs.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function provenancePath(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "provenance.yaml");
}

// In-memory document shape — identical to the serialised YAML but
// using JS objects for mutation. Load on first access, flush on every
// mutation.
function emptyDoc() {
  return {
    version: 1,
    corpus: null,
    targets: {},
  };
}

export function readProvenance(wikiRoot) {
  const path = provenancePath(wikiRoot);
  if (!existsSync(path)) return emptyDoc();
  const raw = readFileSync(path, "utf8");
  return parseYaml(raw);
}

// Atomic write via temp-file + rename, same paranoia as op-log append.
export function writeProvenance(wikiRoot, doc) {
  const path = provenancePath(wikiRoot);
  mkdirSync(dirname(path), { recursive: true });
  const body = emitYaml(doc);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

// Record the corpus identity AND reset the targets map. Called once
// per operation, before any source entries are logged. `startCorpus`
// explicitly discards any prior targets because a new operation's
// provenance is a fresh document — the prior run's entries reference
// a pre-op commit that is no longer the current one, so carrying
// them forward would produce cross-op bleed and false LOSS-01
// failures on stale entries.
//
// `pre_commit` is the sha of the pre-op tag captured in the private
// git — that sha pins source file sizes even if the user edits the
// source mid-operation.
export function startCorpus(
  wikiRoot,
  { root, root_hash, pre_commit, ingested_at },
) {
  const doc = emptyDoc();
  doc.corpus = {
    root,
    root_hash: root_hash || null,
    pre_commit: pre_commit || null,
    ingested_at: ingested_at || new Date().toISOString(),
  };
  writeProvenance(wikiRoot, doc);
  return doc;
}

// Record a single source → target mapping. `byteRange` is [startInclusive,
// endExclusive]; `disposition` must be one of preserved/split/merged/transformed.
// Idempotent by (target, source_path, byte_range): a duplicate call appends
// only if no existing source entry has the same triple.
const VALID_DISPOSITIONS = new Set([
  "preserved",
  "split",
  "merged",
  "transformed",
]);

export function recordSource(
  wikiRoot,
  target,
  {
    source_path,
    source_pre_hash,
    source_size,
    byte_range,
    disposition = "preserved",
  },
) {
  if (!target || typeof target !== "string") {
    throw new Error("recordSource: target must be a non-empty string");
  }
  if (!source_path || typeof source_path !== "string") {
    throw new Error("recordSource: source_path must be a non-empty string");
  }
  if (!Array.isArray(byte_range) || byte_range.length !== 2) {
    throw new Error(
      "recordSource: byte_range must be [startInclusive, endExclusive]",
    );
  }
  const [start, end] = byte_range;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    throw new Error(
      `recordSource: invalid byte_range [${start}, ${end}] ` +
        "(start must be ≥ 0, end must be strictly greater than start, " +
        "both must be safe integers)",
    );
  }
  if (typeof source_size === "number") {
    if (!Number.isSafeInteger(source_size) || source_size < 0) {
      throw new Error(
        `recordSource: invalid source_size ${source_size} ` +
          "(must be a non-negative safe integer)",
      );
    }
    if (end > source_size) {
      throw new Error(
        `recordSource: byte_range end ${end} exceeds source_size ${source_size}`,
      );
    }
  }
  if (!VALID_DISPOSITIONS.has(disposition)) {
    throw new Error(
      `recordSource: unknown disposition "${disposition}" (valid: ${[...VALID_DISPOSITIONS].join(", ")})`,
    );
  }
  const doc = readProvenance(wikiRoot);
  if (!doc.targets[target]) {
    doc.targets[target] = { sources: [], discarded_ranges: [] };
  }
  const entry = doc.targets[target];
  const duplicate = entry.sources.find(
    (s) =>
      s.source_path === source_path &&
      s.byte_range[0] === start &&
      s.byte_range[1] === end,
  );
  if (!duplicate) {
    entry.sources.push({
      source_path,
      source_pre_hash: source_pre_hash || null,
      source_size: source_size ?? null,
      byte_range: [start, end],
      disposition,
    });
  }
  writeProvenance(wikiRoot, doc);
}

// Record a byte range that was deliberately discarded (boilerplate,
// whitespace, license header that appears in every source, etc.). The
// `reason` string is mandatory so the audit trail is meaningful.
export function recordDiscarded(
  wikiRoot,
  source_path,
  byte_range,
  reason,
) {
  if (!reason || typeof reason !== "string") {
    throw new Error("recordDiscarded: reason must be a non-empty string");
  }
  if (!Array.isArray(byte_range) || byte_range.length !== 2) {
    throw new Error("recordDiscarded: byte_range must be [start, end]");
  }
  const [ds, de] = byte_range;
  if (
    !Number.isSafeInteger(ds) ||
    !Number.isSafeInteger(de) ||
    ds < 0 ||
    de <= ds
  ) {
    throw new Error(
      `recordDiscarded: invalid byte_range [${ds}, ${de}] ` +
        "(start must be ≥ 0, end must be strictly greater than start)",
    );
  }
  // Discarded ranges are tracked against a `_discarded` virtual target
  // so LOSS-01 can iterate them uniformly with real targets.
  const doc = readProvenance(wikiRoot);
  if (!doc.targets._discarded) {
    doc.targets._discarded = { sources: [], discarded_ranges: [] };
  }
  const dup = doc.targets._discarded.discarded_ranges.find(
    (d) =>
      d.source_path === source_path &&
      d.byte_range[0] === byte_range[0] &&
      d.byte_range[1] === byte_range[1],
  );
  if (!dup) {
    doc.targets._discarded.discarded_ranges.push({
      source_path,
      byte_range: [byte_range[0], byte_range[1]],
      reason,
    });
  }
  writeProvenance(wikiRoot, doc);
}

// Verify that every source byte is accounted for across every target
// that references it, plus any explicitly-discarded ranges. Returns
// { ok, uncovered, overlaps } — `uncovered` lists source paths with
// gaps, `overlaps` lists source paths where two targets claim the
// same byte range. A healthy provenance manifest has both arrays empty.
//
// `lookupSourceSize` is an injected function `(source_path) => number`
// so callers can read sizes either from the pre-op git commit (via
// `gitCatFileSize`) or from the filesystem directly (tests).
export function verifyCoverage(wikiRoot, lookupSourceSize) {
  if (typeof lookupSourceSize !== "function") {
    throw new Error(
      "verifyCoverage: lookupSourceSize must be a function(source_path) → number",
    );
  }
  const doc = readProvenance(wikiRoot);
  // Build the reverse index: source_path → [{ byte_range, target }...]
  const sourceIndex = new Map();
  for (const [target, entry] of Object.entries(doc.targets)) {
    for (const s of entry.sources || []) {
      if (!sourceIndex.has(s.source_path)) sourceIndex.set(s.source_path, []);
      sourceIndex.get(s.source_path).push({
        byte_range: s.byte_range,
        target,
        kind: "preserved",
      });
    }
    for (const d of entry.discarded_ranges || []) {
      if (!sourceIndex.has(d.source_path)) sourceIndex.set(d.source_path, []);
      sourceIndex.get(d.source_path).push({
        byte_range: d.byte_range,
        target,
        kind: "discarded",
      });
    }
  }
  const uncovered = [];
  const overlaps = [];
  const outOfBounds = [];
  for (const [source_path, ranges] of sourceIndex) {
    const size = lookupSourceSize(source_path);
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
      uncovered.push({
        source_path,
        reason: `lookupSourceSize returned ${size}; source size unknown`,
      });
      continue;
    }
    // Any range that extends past `size` is a provenance bug: it
    // claims bytes that do not exist in the source. Report as
    // out-of-bounds and do NOT advance the cursor past `size` so the
    // gap/tail machinery keeps working meaningfully.
    const sorted = [...ranges].sort(
      (a, b) => a.byte_range[0] - b.byte_range[0],
    );
    let cursor = 0;
    for (const r of sorted) {
      const [s, e] = r.byte_range;
      if (e > size) {
        outOfBounds.push({
          source_path,
          byte_range: [s, e],
          source_size: size,
          target: r.target,
          reason: "range end exceeds source_size",
        });
      }
      if (s < cursor) {
        overlaps.push({ source_path, byte_range: [s, e], target: r.target });
        continue;
      }
      if (s > cursor) {
        uncovered.push({
          source_path,
          byte_range: [cursor, s],
          reason: "gap",
        });
      }
      // Clamp the cursor to `size` so a range that overshoots doesn't
      // poison subsequent gap checks with a bogus cursor value.
      cursor = Math.min(size, Math.max(cursor, e));
    }
    if (cursor < size) {
      uncovered.push({
        source_path,
        byte_range: [cursor, size],
        reason: "tail not covered",
      });
    }
  }
  return {
    ok:
      uncovered.length === 0 &&
      overlaps.length === 0 &&
      outOfBounds.length === 0,
    uncovered,
    overlaps,
    out_of_bounds: outOfBounds,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Hand-rolled YAML emitter / parser. Same philosophy as history.mjs:
// the schema is fixed, a full YAML dep is overkill, determinism > DWIM.
// Supports only the shapes this module writes. Round-trip-safe tested in
// tests/unit/provenance.test.mjs.
// ──────────────────────────────────────────────────────────────────────

function needsQuoting(value) {
  if (value === "") return true;
  if (/[:#{}\[\],&*!|>'"%@`\n\r\t]/.test(value)) return true;
  if (/^[- ?]/.test(value)) return true;
  if (/^-?\d+$/.test(value)) return true;
  if (value === "true" || value === "false" || value === "null") return true;
  return false;
}

function escapeQuoted(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      throw new Error(
        `provenance emitter: control character U+${c.toString(16).padStart(4, "0")} not round-trip-safe`,
      );
    }
  }
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += ch;
    }
  }
  out += '"';
  return out;
}

function emitScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    if (needsQuoting(value)) return escapeQuoted(value);
    return value;
  }
  throw new Error(`provenance emitter: unsupported scalar ${typeof value}`);
}

function emitFlowArrayOfInts(arr) {
  return "[" + arr.map((n) => emitScalar(n)).join(", ") + "]";
}

function emitYaml(doc) {
  const lines = [];
  lines.push("# skill-llm-wiki provenance manifest (version 1)");
  lines.push("version: 1");
  if (doc.corpus) {
    lines.push("corpus:");
    lines.push(`  root: ${emitScalar(doc.corpus.root)}`);
    lines.push(`  root_hash: ${emitScalar(doc.corpus.root_hash)}`);
    lines.push(`  pre_commit: ${emitScalar(doc.corpus.pre_commit)}`);
    lines.push(`  ingested_at: ${emitScalar(doc.corpus.ingested_at)}`);
  } else {
    lines.push("corpus: null");
  }
  lines.push("targets:");
  const targetKeys = Object.keys(doc.targets).sort();
  if (targetKeys.length === 0) {
    lines.push("  {}");
  }
  for (const target of targetKeys) {
    const entry = doc.targets[target];
    lines.push(`  ${emitScalar(target)}:`);
    lines.push("    sources:");
    if ((entry.sources || []).length === 0) {
      lines.push("      []");
    }
    for (const s of entry.sources || []) {
      lines.push(`      - source_path: ${emitScalar(s.source_path)}`);
      lines.push(`        source_pre_hash: ${emitScalar(s.source_pre_hash)}`);
      lines.push(`        source_size: ${emitScalar(s.source_size)}`);
      lines.push(`        byte_range: ${emitFlowArrayOfInts(s.byte_range)}`);
      lines.push(`        disposition: ${emitScalar(s.disposition)}`);
    }
    lines.push("    discarded_ranges:");
    if ((entry.discarded_ranges || []).length === 0) {
      lines.push("      []");
    }
    for (const d of entry.discarded_ranges || []) {
      lines.push(`      - source_path: ${emitScalar(d.source_path)}`);
      lines.push(`        byte_range: ${emitFlowArrayOfInts(d.byte_range)}`);
      lines.push(`        reason: ${emitScalar(d.reason)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function unescapeQuoted(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      switch (next) {
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        default:
          out += next;
      }
      i++;
    } else {
      out += body[i];
    }
  }
  return out;
}

function parseValue(raw) {
  if (raw === "null" || raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `provenance parser: integer ${raw} is not a safe JavaScript integer`,
      );
    }
    return n;
  }
  // Quote symmetry: both ends must be quoted or neither. An
  // asymmetric quote is a hand-edit error and we refuse to pretend
  // the raw string is what the author meant.
  const startsQ = raw.startsWith('"');
  const endsQ = raw.endsWith('"');
  if (startsQ !== endsQ) {
    throw new Error(`provenance parser: unbalanced quote in value: ${raw}`);
  }
  if (startsQ && endsQ) {
    if (raw.length < 2) {
      throw new Error(`provenance parser: lone quote: ${raw}`);
    }
    return unescapeQuoted(raw.slice(1, -1));
  }
  return raw;
}

function parseFlowIntArray(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (inner.trim() === "") return [];
  return inner.split(",").map((s) => {
    const trimmed = s.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error(
        `provenance parser: non-integer in flow array: ${raw}`,
      );
    }
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `provenance parser: integer ${trimmed} is not a safe JavaScript integer`,
      );
    }
    return n;
  });
}

// Strip every comment line and every empty line before parsing.
// Comments are anywhere; the emitter only writes them at the header,
// but a hand-edit might add more. Removing them uniformly prevents
// the state machine from getting confused by a mid-document `#` line
// (previous bug: the machine only stripped comments at the top,
// letting a mid-doc comment silently zero the document).
function preprocess(raw) {
  return raw
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !/^\s*#/.test(l));
}

function parseYaml(raw) {
  const doc = emptyDoc();
  const lines = preprocess(raw);
  let i = 0;

  // version — required
  if (i >= lines.length || !lines[i].startsWith("version:")) {
    throw new Error("provenance parser: missing `version:` at top of document");
  }
  doc.version = parseValue(lines[i].slice("version:".length).trim());
  i++;

  // corpus — required (value may be `null`)
  if (i >= lines.length || !lines[i].startsWith("corpus:")) {
    throw new Error("provenance parser: missing `corpus:` after version");
  }
  const corpusRest = lines[i].slice("corpus:".length).trim();
  i++;
  if (corpusRest === "null") {
    doc.corpus = null;
  } else if (corpusRest === "") {
    doc.corpus = {};
    while (i < lines.length && /^  \w+:/.test(lines[i])) {
      const m = /^  (\w+):\s*(.*)$/.exec(lines[i]);
      if (!m) {
        throw new Error(
          `provenance parser: unrecognised corpus line: ${lines[i]}`,
        );
      }
      doc.corpus[m[1]] = parseValue(m[2]);
      i++;
    }
  } else {
    throw new Error(
      `provenance parser: corpus: must be followed by null or a block, got "${corpusRest}"`,
    );
  }

  // targets — required
  if (i >= lines.length || !lines[i].startsWith("targets:")) {
    throw new Error("provenance parser: missing `targets:` after corpus");
  }
  i++;
  // Empty targets sentinel — {} on its own indented line.
  if (i < lines.length && lines[i].trim() === "{}") {
    i++;
    if (i < lines.length) {
      throw new Error(
        `provenance parser: trailing content after empty targets: ${lines[i]}`,
      );
    }
    return doc;
  }

  while (i < lines.length) {
    // Each target: `  <quoted-or-bare>:`
    const m = /^  (\S.*?):\s*$/.exec(lines[i]);
    if (!m) {
      throw new Error(
        `provenance parser: expected target key at line ${i + 1}, got: ${lines[i]}`,
      );
    }
    const targetName = parseValue(m[1]);
    i++;
    const entry = { sources: [], discarded_ranges: [] };
    doc.targets[targetName] = entry;
    // A target carries exactly two sub-keys in this order: sources:
    // and discarded_ranges:. Both are required but either may be
    // empty (rendered as `[]`). We loop until we encounter a line
    // that isn't indented to the target's child level.
    while (i < lines.length && lines[i].startsWith("    ")) {
      const trimmed = lines[i].trim();
      if (trimmed === "sources:") {
        i++;
        const consumed = parseSourcesOrDiscarded(lines, i);
        entry.sources = consumed.items;
        i = consumed.nextI;
        continue;
      }
      if (trimmed === "discarded_ranges:") {
        i++;
        const consumed = parseSourcesOrDiscarded(lines, i);
        entry.discarded_ranges = consumed.items;
        i = consumed.nextI;
        continue;
      }
      throw new Error(
        `provenance parser: unknown target field at line ${i + 1}: ${lines[i]}`,
      );
    }
  }
  return doc;
}

// Parse a list of `      - key: value\n` blocks starting at lines[i].
// Returns { items, nextI } so the caller can advance its own cursor.
function parseSourcesOrDiscarded(lines, startI) {
  const out = [];
  let i = startI;
  // Empty-list sentinel.
  if (i < lines.length && lines[i].trim() === "[]") {
    return { items: out, nextI: i + 1 };
  }
  while (i < lines.length) {
    const line = lines[i];
    // Item starter: `      - source_path: <value>`
    if (/^ {6}- (\w+):/.test(line)) {
      const item = {};
      const m = /^ {6}- (\w+):\s*(.*)$/.exec(line);
      item[m[1]] = parseValue(m[2]);
      i++;
      while (i < lines.length && /^ {8}(\w+):/.test(lines[i])) {
        const m2 = /^ {8}(\w+):\s*(.*)$/.exec(lines[i]);
        const key = m2[1];
        const raw = m2[2];
        if (key === "byte_range") {
          item[key] = parseFlowIntArray(raw);
        } else {
          item[key] = parseValue(raw);
        }
        i++;
      }
      out.push(item);
      continue;
    }
    break;
  }
  return { items: out, nextI: i };
}
