// assert-frontmatter.mjs — testkit helper: read a leaf, parse its
// frontmatter block, assert expected fields match.
//
// Deliberately lightweight: does not import gray-matter. The
// opening `---\n` fence, body, and closing `---\n` fence pattern
// the skill emits is stable enough that a ~10-line parser is the
// right shape for a testkit.
//
// Zero runtime deps; pure Node built-ins.

import { readFileSync } from "node:fs";

const FM_START = /^---\n/;
const FM_END = /\n---\n/;

// Parse a leaf's frontmatter block into a flat key: string-ish
// object. Only the shallow YAML shape the skill emits is
// supported. For full YAML-as-data consumers should use gray-matter
// in their own test code; this helper is for sanity checks.
export function readLeafFrontmatter(absLeafPath) {
  const raw = readFileSync(absLeafPath, "utf8");
  if (!FM_START.test(raw)) {
    throw new Error(
      `readLeafFrontmatter: ${absLeafPath} has no frontmatter block`,
    );
  }
  const afterFirst = raw.slice(4); // strip the opening ---\n
  const endMatch = FM_END.exec(afterFirst);
  if (!endMatch) {
    throw new Error(
      `readLeafFrontmatter: ${absLeafPath} has an unterminated frontmatter block`,
    );
  }
  const block = afterFirst.slice(0, endMatch.index);
  const data = {};
  let currentKey = null;
  let currentList = null;
  for (const line of block.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const listMatch = /^\s+-\s*(.*)$/.exec(line);
    if (listMatch && currentKey) {
      if (!currentList) {
        currentList = [];
        data[currentKey] = currentList;
      }
      currentList.push(unquote(listMatch[1].trim()));
      continue;
    }
    const kv = /^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i.exec(line);
    if (!kv) continue;
    currentKey = kv[1];
    currentList = null;
    const val = kv[2].trim();
    if (val === "" || val === "[]") {
      data[currentKey] = val === "[]" ? [] : "";
    } else if (val.startsWith("[") && val.endsWith("]")) {
      data[currentKey] = val
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else {
      data[currentKey] = unquote(val);
    }
  }
  return data;
}

function unquote(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// Compare actual frontmatter to an expected subset. Only fields
// named in `expected` are checked; extra fields in the leaf are
// allowed. Arrays compare element-wise as strings.
//
// Throws an Error when any mismatch is found. Returns the parsed
// frontmatter object on success.
export function assertFrontmatterShape(absLeafPath, expected) {
  const data = readLeafFrontmatter(absLeafPath);
  const mismatches = [];
  for (const [key, want] of Object.entries(expected ?? {})) {
    const got = data[key];
    if (Array.isArray(want)) {
      if (!Array.isArray(got)) {
        mismatches.push(`${key}: expected array, got ${JSON.stringify(got)}`);
        continue;
      }
      if (got.length !== want.length || got.some((v, i) => String(v) !== String(want[i]))) {
        mismatches.push(
          `${key}: expected [${want.join(", ")}], got [${got.join(", ")}]`,
        );
      }
      continue;
    }
    if (String(got) !== String(want)) {
      mismatches.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `assertFrontmatterShape failed for ${absLeafPath}:\n  - ` +
        mismatches.join("\n  - "),
    );
  }
  return data;
}
