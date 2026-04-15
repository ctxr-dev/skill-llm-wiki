// Minimal, dependency-free YAML frontmatter parser/writer.
//
// Supports exactly the subset the methodology's index.md and leaf frontmatter
// use: scalars (string/number/bool/null), block mappings, block sequences of
// scalars, block sequences of maps, nested mappings. No flow maps, no anchors,
// no multi-document streams. Deterministic roundtrip: parse → render on an
// unchanged tree yields byte-identical output modulo key ordering (which is
// fixed by a canonical key order when rendering).
//
// We ship zero runtime dependencies because `kit install` does not populate
// `node_modules` inside an installed skill directory — scripts must run with
// just Node built-ins.

import { readFileSync, writeFileSync } from "node:fs";

const FM = "---";

export function readFrontmatter(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return parseFrontmatter(raw, filePath);
}

export function parseFrontmatter(raw, filePath = "<buffer>") {
  if (!raw.startsWith(FM + "\n") && raw !== FM + "\n") {
    return { data: {}, body: raw };
  }
  const lines = raw.split("\n");
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FM) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error(`${filePath}: frontmatter opens with --- but never closes`);
  }
  const yamlLines = lines.slice(1, closeIdx);
  const bodyLines = lines.slice(closeIdx + 1);
  const data = parseYaml(yamlLines, filePath);
  return { data, body: bodyLines.join("\n") };
}

export function writeFrontmatter(filePath, data, body) {
  const yaml = renderYaml(data, 0);
  const trimmedBody = body.startsWith("\n") ? body : "\n" + body;
  writeFileSync(filePath, `${FM}\n${yaml}${FM}${trimmedBody}`, "utf8");
}

export function renderFrontmatter(data, body = "") {
  const yaml = renderYaml(data, 0);
  const trimmedBody = body.startsWith("\n") ? body : "\n" + body;
  return `${FM}\n${yaml}${FM}${trimmedBody}`;
}

// ─── Parser ──────────────────────────────────────────────────────────────

class Parser {
  constructor(lines, filePath) {
    this.lines = lines;
    this.pos = 0;
    this.filePath = filePath;
  }

  peek() {
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos];
      if (raw.trim() === "" || raw.trimStart().startsWith("#")) {
        this.pos++;
        continue;
      }
      const indent = raw.length - raw.trimStart().length;
      return { raw, indent, text: raw.slice(indent) };
    }
    return null;
  }

  advance() {
    this.pos++;
  }

  error(msg, line) {
    throw new Error(`${this.filePath}:${this.pos + 1}: ${msg} — "${line ?? ""}"`);
  }
}

function parseYaml(lines, filePath) {
  const p = new Parser(lines, filePath);
  return parseMap(p, 0);
}

// Keys that can poison the parsed object's prototype. These are refused
// at parse time so adversarial frontmatter (e.g. from a shared wiki a
// user received from a third party) cannot plant properties on
// Object.prototype or swap the instance's [[Prototype]] via the
// `__proto__` setter. See `tests/unit/frontmatter-pollution.test.mjs`.
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function safeAssign(out, key, value, p, tok) {
  if (POLLUTION_KEYS.has(key)) {
    p.error(`forbidden YAML key "${key}"`, tok?.raw ?? key);
  }
  // Defence in depth: always write via defineProperty so the __proto__
  // setter cannot fire even if the key check above is ever loosened.
  Object.defineProperty(out, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function parseMap(p, baseIndent) {
  const out = {};
  while (true) {
    const tok = p.peek();
    if (!tok) return out;
    if (tok.indent < baseIndent) return out;
    if (tok.indent > baseIndent) {
      p.error("unexpected indent", tok.raw);
    }
    const { text } = tok;
    const colon = findKeyColon(text);
    if (colon === -1) p.error("expected key:", tok.raw);
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    p.advance();

    if (rest === "|" || rest === ">") {
      safeAssign(out, key, parseBlockScalar(p, baseIndent, rest === "|"), p, tok);
      continue;
    }
    if (rest !== "") {
      safeAssign(out, key, parseScalarInline(rest), p, tok);
      continue;
    }

    // Nested structure — peek indent to decide.
    const next = p.peek();
    if (!next || next.indent <= baseIndent) {
      safeAssign(out, key, null, p, tok);
      continue;
    }
    if (next.text.startsWith("- ") || next.text === "-") {
      safeAssign(out, key, parseSeq(p, next.indent), p, tok);
    } else {
      safeAssign(out, key, parseMap(p, next.indent), p, tok);
    }
  }
}

function parseSeq(p, baseIndent) {
  const out = [];
  while (true) {
    const tok = p.peek();
    if (!tok) return out;
    if (tok.indent < baseIndent) return out;
    if (tok.indent > baseIndent) p.error("unexpected indent in sequence", tok.raw);
    if (!tok.text.startsWith("-")) return out;

    // Item starts at baseIndent with `- `. The rest of the line is either
    // empty, a scalar, or a first key of an inline map.
    const afterDash = tok.text === "-" ? "" : tok.text.slice(2);
    p.advance();

    if (afterDash === "") {
      // Nested content under a bare `-`
      const next = p.peek();
      if (next && next.indent > baseIndent) {
        if (next.text.startsWith("- ")) {
          out.push(parseSeq(p, next.indent));
        } else {
          out.push(parseMap(p, next.indent));
        }
      } else {
        out.push(null);
      }
      continue;
    }

    const colon = findKeyColon(afterDash);
    if (colon === -1) {
      out.push(parseScalarInline(afterDash));
      continue;
    }

    // `- key: value` possibly followed by more keys at indent baseIndent+2
    const firstKey = afterDash.slice(0, colon).trim();
    const firstRest = afterDash.slice(colon + 1).trim();
    const item = {};

    if (firstRest === "|" || firstRest === ">") {
      item[firstKey] = parseBlockScalar(p, baseIndent + 2, firstRest === "|");
    } else if (firstRest !== "") {
      item[firstKey] = parseScalarInline(firstRest);
    } else {
      // Nested structure under first key
      const nested = p.peek();
      if (nested && nested.indent > baseIndent + 2) {
        if (nested.text.startsWith("- ")) {
          item[firstKey] = parseSeq(p, nested.indent);
        } else {
          item[firstKey] = parseMap(p, nested.indent);
        }
      } else if (nested && nested.indent === baseIndent + 2) {
        // First key had nested sub-map at +2 (legal when firstRest is empty)
        if (nested.text.startsWith("- ")) {
          item[firstKey] = parseSeq(p, nested.indent);
        } else {
          item[firstKey] = parseMap(p, nested.indent);
        }
      } else {
        item[firstKey] = null;
      }
    }

    // Additional keys at baseIndent+2
    while (true) {
      const cont = p.peek();
      if (!cont) break;
      if (cont.indent < baseIndent + 2) break;
      if (cont.indent > baseIndent + 2) break;
      if (cont.text.startsWith("- ")) break;
      const subColon = findKeyColon(cont.text);
      if (subColon === -1) break;
      const subKey = cont.text.slice(0, subColon).trim();
      const subRest = cont.text.slice(subColon + 1).trim();
      p.advance();
      if (subRest === "") {
        const nested2 = p.peek();
        if (nested2 && nested2.indent > baseIndent + 2) {
          if (nested2.text.startsWith("- ")) {
            item[subKey] = parseSeq(p, nested2.indent);
          } else {
            item[subKey] = parseMap(p, nested2.indent);
          }
        } else {
          item[subKey] = null;
        }
      } else if (subRest === "|" || subRest === ">") {
        item[subKey] = parseBlockScalar(p, baseIndent + 2, subRest === "|");
      } else {
        item[subKey] = parseScalarInline(subRest);
      }
    }

    out.push(item);
  }
}

function parseBlockScalar(p, baseIndent, literal) {
  const collected = [];
  while (p.pos < p.lines.length) {
    const raw = p.lines[p.pos];
    if (raw.trim() === "") {
      collected.push("");
      p.pos++;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= baseIndent) break;
    collected.push(raw.slice(baseIndent + 2));
    p.pos++;
  }
  // Trim trailing empty lines
  while (collected.length > 0 && collected[collected.length - 1] === "") {
    collected.pop();
  }
  return literal ? collected.join("\n") : collected.join(" ").trim();
}

function parseScalarInline(raw) {
  const s = raw.trim();
  if (s === "") return null;
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner).map((x) => parseScalarInline(x));
  }
  return s;
}

function splitFlow(inner) {
  // Split on commas that are not inside quotes.
  const out = [];
  let depth = 0;
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (const c of inner) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if ((c === "[" || c === "{") && !inSingle && !inDouble) depth++;
    else if ((c === "]" || c === "}") && !inSingle && !inDouble) depth--;
    if (c === "," && !inSingle && !inDouble && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function findKeyColon(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble) {
      if (i === text.length - 1) return i;
      if (text[i + 1] === " " || text[i + 1] === "\t") return i;
    }
  }
  return -1;
}

// ─── Renderer ────────────────────────────────────────────────────────────

function renderYaml(data, indent) {
  if (data == null || typeof data !== "object") return "";
  let out = "";
  for (const key of Object.keys(data)) {
    out += renderKey(key, data[key], indent);
  }
  return out;
}

function renderKey(key, val, indent) {
  const pad = "  ".repeat(indent);
  if (val === null || val === undefined) return `${pad}${key}: null\n`;
  if (typeof val === "boolean" || typeof val === "number") {
    return `${pad}${key}: ${val}\n`;
  }
  if (typeof val === "string") {
    if (val.includes("\n")) {
      const childPad = "  ".repeat(indent + 1);
      const lines = val.split("\n");
      return `${pad}${key}: |\n${lines.map((l) => (l === "" ? "" : childPad + l)).join("\n")}\n`;
    }
    return `${pad}${key}: ${renderScalar(val)}\n`;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return `${pad}${key}: []\n`;
    let out = `${pad}${key}:\n`;
    for (const item of val) {
      out += renderSeqItem(item, indent + 1);
    }
    return out;
  }
  // Plain object
  const keys = Object.keys(val);
  if (keys.length === 0) return `${pad}${key}: {}\n`;
  let out = `${pad}${key}:\n`;
  for (const k of keys) {
    out += renderKey(k, val[k], indent + 1);
  }
  return out;
}

function renderSeqItem(item, indent) {
  const pad = "  ".repeat(indent);
  if (item === null || item === undefined) return `${pad}- null\n`;
  if (typeof item === "boolean" || typeof item === "number") {
    return `${pad}- ${item}\n`;
  }
  if (typeof item === "string") {
    if (item.includes("\n")) {
      // Rare in our frontmatter; fall back to scalar-with-escapes
      return `${pad}- ${renderScalar(item.replace(/\n/g, "\\n"))}\n`;
    }
    return `${pad}- ${renderScalar(item)}\n`;
  }
  if (Array.isArray(item)) {
    // Nested sequence inside a sequence — rare; recursive emission
    let out = `${pad}-\n`;
    for (const inner of item) out += renderSeqItem(inner, indent + 1);
    return out;
  }
  // Map item
  const keys = Object.keys(item);
  if (keys.length === 0) return `${pad}- {}\n`;
  const firstKey = keys[0];
  const firstVal = item[firstKey];
  let out = "";
  // Emit first key inline with the dash
  if (
    firstVal === null ||
    typeof firstVal === "boolean" ||
    typeof firstVal === "number" ||
    (typeof firstVal === "string" && !firstVal.includes("\n"))
  ) {
    out += `${pad}- ${firstKey}: ${firstVal === null ? "null" : typeof firstVal === "string" ? renderScalar(firstVal) : firstVal}\n`;
  } else {
    // Non-scalar first value: emit on separate line
    out += `${pad}-\n`;
    out += renderKey(firstKey, firstVal, indent + 1);
    for (let i = 1; i < keys.length; i++) {
      out += renderKey(keys[i], item[keys[i]], indent + 1);
    }
    return out;
  }
  // Subsequent keys at indent+1
  for (let i = 1; i < keys.length; i++) {
    out += renderKey(keys[i], item[keys[i]], indent + 1);
  }
  return out;
}

function renderScalar(v) {
  if (typeof v !== "string") return String(v);
  if (v === "") return '""';
  if (v === "null" || v === "true" || v === "false" || v === "~") return `"${v}"`;
  if (/^-?\d+(\.\d+)?$/.test(v)) return `"${v}"`;
  if (/[:#\[\]{}&*!|>'"`%@\t]/.test(v)) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (/^\s|\s$/.test(v) || /^[-?]/.test(v)) {
    return `"${v}"`;
  }
  return v;
}
