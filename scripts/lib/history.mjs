// history.mjs — the operation log at <wiki>/.llmwiki/op-log.yaml.
//
// Append-only. One record per top-level operation (Build, Extend, Rebuild,
// Fix, Join, Rollback, Migrate). The log lives alongside the private git
// repo but is not a commit — it's a simple YAML file the skill owns and
// treats as an audit trail. Later phases (history subcommand, decision log
// lookups, Fix's AUTO class) read this file to reason about prior ops.
//
// We intentionally hand-roll the YAML serialization. The log shape is
// fixed and simple, so a full YAML dependency would be overkill and could
// reintroduce non-determinism.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function opLogPath(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "op-log.yaml");
}

// The schema each record must satisfy. Extra keys are allowed and
// preserved verbatim on round-trip (in case a later phase wants to stash
// per-op metadata without an interface change).
const REQUIRED_FIELDS = [
  "op_id",
  "operation",
  "layout_mode",
  "started",
  "finished",
  "base_commit",
  "final_commit",
  "summary",
];

function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("op-log entry must be an object");
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) {
      throw new Error(`op-log entry missing required field "${f}"`);
    }
  }
}

// Hand-rolled minimal YAML emitter. Supports only the record shape we
// write here — strings, numbers, booleans, and arrays of primitives.
// Nested objects are NOT supported: the parser below cannot round-trip
// them and this file deliberately keeps both sides of the codec in
// lockstep. If a future phase needs nested metadata, extend both the
// emitter AND the parser AND add a round-trip property test.
//
// Strings are aggressively quoted whenever they could be misread as a
// YAML scalar (reserved punctuation, boolean-ish literals, or anything
// that parses as a number). The companion `parseValue` below recognises
// the same quoting rule.
function needsQuoting(value) {
  if (value === "") return true;
  if (/[:#{}\[\],&*!|>'"%@`\n\r\t]/.test(value)) return true;
  if (/^[- ?]/.test(value)) return true;
  // Number-ish, boolean-ish, null-ish literals MUST be quoted so they
  // round-trip as strings through parseValue.
  if (/^-?\d+$/.test(value)) return true;
  if (value === "true" || value === "false" || value === "null") return true;
  return false;
}

// Escape a string for the quoted-scalar form. Handles backslash, double
// quote, newline, carriage return, and tab — which is every hazard the
// single-line YAML form can produce. Other control characters (U+0000..
// U+001F except \n \r \t) are rejected loudly because we have no
// round-trip-safe escape for them and silently dropping them would
// corrupt the audit trail.
function escapeQuoted(value) {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      throw new Error(
        `op-log emitter: control character U+${c.toString(16).padStart(4, "0")} ` +
          "is not round-trip-safe; strip it before logging",
      );
    }
  }
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
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
  throw new Error(`op-log emitter: unsupported scalar type ${typeof value}`);
}

function emitEntry(entry) {
  const lines = [];
  lines.push("- op_id: " + emitScalar(entry.op_id));
  const ordered = [
    "operation",
    "layout_mode",
    "started",
    "finished",
    "base_commit",
    "final_commit",
    "summary",
  ];
  for (const k of ordered) {
    lines.push(`  ${k}: ${emitScalar(entry[k])}`);
  }
  // Extra keys preserved in sorted order for determinism.
  const known = new Set(["op_id", ...ordered]);
  const extras = Object.keys(entry)
    .filter((k) => !known.has(k))
    .sort();
  for (const k of extras) {
    const v = entry[k];
    if (Array.isArray(v)) {
      lines.push(`  ${k}:`);
      for (const item of v) {
        lines.push(`    - ${emitScalar(item)}`);
      }
    } else if (v && typeof v === "object") {
      // Nested objects are intentionally not supported — see the big
      // comment on `needsQuoting` above. Callers must flatten first.
      throw new Error(
        `op-log emitter: nested object extras not supported for key "${k}". ` +
          "Flatten the object or serialise it as a single string value.",
      );
    } else {
      lines.push(`  ${k}: ${emitScalar(v)}`);
    }
  }
  return lines.join("\n");
}

// Append an entry. Creates the file (and the .llmwiki/ directory) if
// needed. Atomic: writes to a sibling temp file then renames, so a SIGKILL
// mid-append leaves either the old file intact or the new file complete,
// never a truncated in-between state. Append-only audit logs deserve the
// paranoia because we cannot recover from corruption once it's written.
export function appendOpLog(wikiRoot, entry) {
  validateEntry(entry);
  const path = opLogPath(wikiRoot);
  mkdirSync(dirname(path), { recursive: true });
  const block = emitEntry(entry) + "\n";
  let payload;
  if (!existsSync(path)) {
    payload =
      "# skill-llm-wiki operation log — append-only audit trail\n" + block;
  } else {
    const existing = readFileSync(path, "utf8");
    const prefix = existing.endsWith("\n") ? existing : existing + "\n";
    payload = prefix + block;
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

// Parse the log file into an array of entry objects. Hand-rolled parser
// that accepts what emitEntry emits; anything else is a hard error. The
// contract is "this file is owned by the skill" — if it looks wrong, we
// want to know, not paper over it.
//
// A new entry begins at any line matching `- <key>: <value>` (the list-item
// dash). This is independent of which key appears first, so extending the
// emitter with new ordered fields does NOT break the parser.
const ENTRY_START_RE = /^- (\w+):\s*(.*)$/;
const INDENTED_KEY_RE = /^  (\w+):\s*(.*)$/;
const INDENTED_LIST_RE = /^    - (.*)$/;

// Defence-in-depth against __proto__ / constructor key poisoning in the
// parsed op-log. The op-log file is produced by the skill itself, so
// this is belt-and-braces for a future attacker who might slip a
// crafted entry in via a manual edit or a corrupted sync.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertSafeKey(key, lineIndex) {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new Error(
      `op-log: forbidden key "${key}" at line ${lineIndex + 1}`,
    );
  }
}

export function readOpLog(wikiRoot) {
  const path = opLogPath(wikiRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const entries = [];
  let current = null;
  let currentListKey = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" || line.startsWith("#")) continue;
    const entryMatch = ENTRY_START_RE.exec(line);
    if (entryMatch) {
      if (current) entries.push(current);
      current = {};
      const [, key, rest] = entryMatch;
      assertSafeKey(key, i);
      if (rest === "") {
        current[key] = [];
        currentListKey = key;
      } else {
        current[key] = parseValue(rest);
        currentListKey = null;
      }
      continue;
    }
    if (!current) {
      throw new Error(`op-log: stray line at ${i + 1}: ${line}`);
    }
    const listMatch = INDENTED_LIST_RE.exec(line);
    if (listMatch && currentListKey) {
      if (!Array.isArray(current[currentListKey])) {
        current[currentListKey] = [];
      }
      current[currentListKey].push(parseValue(listMatch[1]));
      continue;
    }
    const m = INDENTED_KEY_RE.exec(line);
    if (!m) {
      throw new Error(`op-log: unrecognised line at ${i + 1}: ${line}`);
    }
    const key = m[1];
    const rest = m[2];
    assertSafeKey(key, i);
    if (rest === "") {
      // Parent of an array (next lines start `    - `). Nested-object
      // extras are explicitly unsupported on the emit side.
      current[key] = [];
      currentListKey = key;
    } else {
      current[key] = parseValue(rest);
      currentListKey = null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

// Char-by-char unescape so the parser consumes exactly one escape
// sequence at a time and cannot be confused by `\\n` (backslash followed
// by the letter n) versus `\n` (actual newline). Mirrors escapeQuoted.
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
          // Unknown escape sequence — pass through the following char
          // verbatim. This is lenient by design so the parser survives
          // format extensions without hard failure.
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
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return unescapeQuoted(raw.slice(1, -1));
  }
  return raw;
}

// Find an entry by op_id or by rollback-style "pre-<op-id>" shorthand.
// Returns null when no match is found.
export function findOpByRef(wikiRoot, ref) {
  const entries = readOpLog(wikiRoot);
  const opId = ref.startsWith("pre-") ? ref.slice(4) : ref;
  return entries.find((e) => e.op_id === opId) ?? null;
}
