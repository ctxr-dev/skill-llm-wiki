// decision-log.mjs — append-only audit trail for tiered-AI decisions.
//
// Every non-trivial similarity / operator decision records:
//
//   { op_id, operator, sources[], tier_used, similarity,
//     confidence_band, decision, reason }
//
// Stored at `<wiki>/.llmwiki/decisions.yaml`. Same hand-rolled
// deterministic YAML emitter/parser pattern as history.mjs — no
// external dep. Atomic append via temp-file + rename.
//
// Claude-at-session-time reads this log when a user asks "why was
// this merged?" so the audit trail has to survive across operations
// unchanged. The log is intentionally NOT reset on rollback — if an
// op's decisions are a matter of historical record, they remain
// queryable even after the op is reset.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function decisionLogPath(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "decisions.yaml");
}

const REQUIRED_FIELDS = [
  "op_id",
  "operator",
  "sources",
  "tier_used",
  "similarity",
  "decision",
];

function validate(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("decision-log: entry must be an object");
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) {
      throw new Error(`decision-log: entry missing required field "${f}"`);
    }
  }
  if (!Array.isArray(entry.sources)) {
    throw new Error("decision-log: sources must be an array of strings");
  }
  // `Number.isFinite` rejects NaN, Infinity, and non-numbers. That's
  // exactly what we want: the audit log has no place for an
  // Infinity similarity score (the emitter would serialise it as
  // the string "Infinity" and the parser would read it back as a
  // string, silently corrupting the type).
  if (!Number.isFinite(entry.similarity)) {
    throw new Error(
      "decision-log: similarity must be a finite number (got " +
        `${entry.similarity})`,
    );
  }
  if (typeof entry.tier_used !== "number" || !Number.isInteger(entry.tier_used)) {
    throw new Error("decision-log: tier_used must be an integer");
  }
}

// Quote any string that could be misread as YAML (same rules as
// history.mjs). We intentionally keep the scalar shape identical
// to the op-log's so a future consolidation is mechanical.
function needsQuoting(value) {
  if (value === "") return true;
  if (/[:#{}\[\],&*!|>'"`\n\r\t]/.test(value)) return true;
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
        `decision-log: control character U+${c.toString(16).padStart(4, "0")} is not round-trip-safe`,
      );
    }
  }
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: out += ch;
    }
  }
  return out + '"';
}

function emitScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (needsQuoting(value)) return escapeQuoted(value);
    return value;
  }
  throw new Error(
    `decision-log: unsupported scalar type ${typeof value}`,
  );
}

function emitEntry(entry) {
  const lines = [];
  lines.push("- op_id: " + emitScalar(entry.op_id));
  lines.push("  operator: " + emitScalar(entry.operator));
  lines.push("  sources:");
  for (const s of entry.sources) {
    lines.push("    - " + emitScalar(s));
  }
  lines.push("  tier_used: " + emitScalar(entry.tier_used));
  lines.push("  similarity: " + emitScalar(entry.similarity));
  lines.push(
    "  confidence_band: " + emitScalar(entry.confidence_band ?? null),
  );
  lines.push("  decision: " + emitScalar(entry.decision));
  lines.push("  reason: " + emitScalar(entry.reason ?? null));
  return lines.join("\n");
}

// Append an entry atomically.
export function appendDecision(wikiRoot, entry) {
  validate(entry);
  const path = decisionLogPath(wikiRoot);
  mkdirSync(dirname(path), { recursive: true });
  const block = emitEntry(entry) + "\n";
  let payload;
  if (!existsSync(path)) {
    payload =
      "# skill-llm-wiki tiered-AI decision log (append-only)\n" +
      "version: 1\n" +
      "entries:\n" +
      block;
  } else {
    const existing = readFileSync(path, "utf8");
    const prefix = existing.endsWith("\n") ? existing : existing + "\n";
    payload = prefix + block;
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

// Lightweight reader — we parse only what we need for tests and the
// `skill-llm-wiki history` subcommand. Errors out loudly on any line
// the parser doesn't recognise.
export function readDecisions(wikiRoot) {
  const path = decisionLogPath(wikiRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  // Strip comments and blank lines; reject unknown headers.
  const lines = raw
    .split(/\r?\n/)
    .filter((l) => l.length > 0 && !/^\s*#/.test(l));
  const out = [];
  let i = 0;
  // Header: version + entries:
  if (i < lines.length && lines[i].startsWith("version:")) i++;
  if (i < lines.length && lines[i].trim() === "entries:") i++;
  let current = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("- op_id:")) {
      if (current) out.push(current);
      current = { op_id: parseValue(line.slice("- op_id:".length).trim()), sources: [] };
      i++;
      continue;
    }
    if (!current) {
      throw new Error(`decision-log parser: stray line at ${i + 1}: ${line}`);
    }
    const listItem = /^    - (.*)$/.exec(line);
    if (listItem) {
      current.sources.push(parseValue(listItem[1]));
      i++;
      continue;
    }
    const kv = /^  (\w+):\s*(.*)$/.exec(line);
    if (!kv) {
      throw new Error(
        `decision-log parser: unrecognised line at ${i + 1}: ${line}`,
      );
    }
    const [, key, rest] = kv;
    if (key === "sources") {
      // `sources:` alone introduces the list items; items start with `    - `.
      current.sources = [];
      i++;
      continue;
    }
    current[key] = parseValue(rest);
    i++;
  }
  if (current) out.push(current);
  return out;
}

function unescapeQuoted(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      const next = body[i + 1];
      switch (next) {
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        default: out += next;
      }
      i++;
    } else {
      out += body[i];
    }
  }
  return out;
}

// Scientific-notation friendly number regex. Matches `0.5`, `1e-10`,
// `-3.14`, `42`, `-5`. Does NOT match `Infinity`, `NaN`, or
// hexadecimal — those are either forbidden by the validator or
// expressible as unambiguous strings.
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function parseValue(raw) {
  if (raw === "null" || raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) {
      throw new Error(
        `decision-log parser: integer ${raw} is not a safe integer`,
      );
    }
    return n;
  }
  if (NUMBER_RE.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `decision-log parser: non-finite numeric value ${raw}`,
      );
    }
    return n;
  }
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return unescapeQuoted(raw.slice(1, -1));
  }
  if (raw.startsWith('"') !== raw.endsWith('"')) {
    throw new Error(`decision-log parser: unbalanced quote in: ${raw}`);
  }
  return raw;
}
