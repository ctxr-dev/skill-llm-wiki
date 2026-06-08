// layout-config.test.mjs — the pin grammar (one-of matchers), the fnmatch
// glob (incl. character classes), and the tree validator's empty-category
// silence. These lock the behaviours raised in the Copilot review of the
// --layout-config build-driver feature.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLayoutConfig,
  compilePins,
  validateTreeAgainstLayout,
} from "../../scripts/lib/layout-config.mjs";

function freshDir(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-layout-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Write a layout.yaml from a taxonomy spec and load it. `policy` optional.
function loadFrom(tag, taxonomy, policy) {
  const dir = freshDir(tag);
  const path = join(dir, "layout.yaml");
  const lines = ["layout_version: 1"];
  if (policy) {
    lines.push("policy:");
    for (const [k, v] of Object.entries(policy)) lines.push(`  ${k}: ${v}`);
  }
  lines.push("taxonomy:");
  for (const cat of taxonomy) {
    lines.push(`  - id: ${cat.id}`);
    lines.push("    pin:");
    for (const rule of cat.pin) {
      const parts = Object.entries(rule).map(([k, v]) => `${k}: "${v}"`);
      lines.push(`      - { ${parts.join(", ")} }`);
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return loadLayoutConfig(path);
}

// ── Pin grammar: exactly one matcher per rule ────────────────────────

test("loadLayoutConfig rejects a pin rule with multiple matchers", () => {
  assert.throws(
    () => loadFrom("multi", [{ id: "sec", pin: [{ id: "sec-x", id_prefix: "sec-" }] }]),
    /has 2 matchers \(id, id_prefix\); use exactly one/,
  );
});

test("loadLayoutConfig rejects a pin rule with all three matchers", () => {
  assert.throws(
    () => loadFrom("triple", [{ id: "sec", pin: [{ id: "a", id_prefix: "b", id_glob: "c*" }] }]),
    /has 3 matchers .* use exactly one/,
  );
});

test("loadLayoutConfig rejects a pin rule with zero matchers", () => {
  assert.throws(
    () => loadFrom("zero", [{ id: "sec", pin: [{ purpose: "noise" }] }]),
    /needs one of id \/ id_prefix \/ id_glob/,
  );
});

test("loadLayoutConfig accepts single-matcher rules of each kind", () => {
  const cfg = loadFrom("single", [
    { id: "exact", pin: [{ id: "lang-python" }] },
    { id: "byprefix", pin: [{ id_prefix: "sec-" }] },
    { id: "byglob", pin: [{ id_glob: "fw-*" }] },
  ]);
  const pinFor = compilePins(cfg);
  assert.equal(pinFor("lang-python").category, "exact");
  assert.equal(pinFor("sec-xss").category, "byprefix");
  assert.equal(pinFor("fw-django").category, "byglob");
  assert.equal(pinFor("unmatched"), null);
});

// ── fnmatch glob: `*`, `?`, and character classes ────────────────────

test("id_glob honours * and ? like fnmatch", () => {
  const cfg = loadFrom("star", [{ id: "c", pin: [{ id_glob: "lang-?y*" }] }]);
  const pinFor = compilePins(cfg);
  assert.equal(pinFor("lang-python").category, "c"); // ? = p, * = thon
  assert.equal(pinFor("lang-ruby"), null); // 2nd char 'u' != 'y'
});

test("id_glob honours a character-class range [a-z]", () => {
  const cfg = loadFrom("range", [{ id: "c", pin: [{ id_glob: "sec-[a-c]*" }] }]);
  const pinFor = compilePins(cfg);
  assert.equal(pinFor("sec-auth").category, "c"); // a ∈ [a-c]
  assert.equal(pinFor("sec-csrf").category, "c"); // c ∈ [a-c]
  assert.equal(pinFor("sec-xss"), null); // x ∉ [a-c]
});

test("id_glob honours a negated character class [!...]", () => {
  const cfg = loadFrom("neg", [{ id: "c", pin: [{ id_glob: "[!l]ang-*" }] }]);
  const pinFor = compilePins(cfg);
  assert.equal(pinFor("fang-x").category, "c"); // f != l
  assert.equal(pinFor("lang-python"), null); // l is excluded
});

test("id_glob treats an unterminated [ as a literal", () => {
  const cfg = loadFrom("litbracket", [{ id: "c", pin: [{ id_glob: "weird[id" }] }]);
  const pinFor = compilePins(cfg);
  assert.equal(pinFor("weird[id").category, "c");
  assert.equal(pinFor("weirdxid"), null);
});

// ── Tree validator: empty categories are not flagged ─────────────────

test("validateTreeAgainstLayout does not flag a category with no leaf", () => {
  const cfg = loadFrom(
    "empty",
    [
      { id: "security", pin: [{ id_prefix: "sec-" }] },
      { id: "performance", pin: [{ id_prefix: "perf-" }] },
    ],
    { unpinned: "reject", max_depth: 2, fanout_hard_max: 50 },
  );
  // A wiki that only carries a security leaf — performance is empty.
  const wiki = freshDir("emptywiki");
  mkdirSync(join(wiki, "security"), { recursive: true });
  writeFileSync(
    join(wiki, "security", "sec-xss.md"),
    "---\nid: sec-xss\n---\nbody\n",
  );
  writeFileSync(join(wiki, "index.md"), "# root\n");
  const findings = validateTreeAgainstLayout(wiki, cfg);
  assert.equal(
    findings.length,
    0,
    `expected no findings, got: ${JSON.stringify(findings)}`,
  );
});

test("validateTreeAgainstLayout flags a misplaced leaf", () => {
  const cfg = loadFrom(
    "misplaced",
    [
      { id: "security", pin: [{ id_prefix: "sec-" }] },
      { id: "performance", pin: [{ id_prefix: "perf-" }] },
    ],
    { unpinned: "reject", max_depth: 2, fanout_hard_max: 50 },
  );
  const wiki = freshDir("misplacedwiki");
  mkdirSync(join(wiki, "performance"), { recursive: true });
  // sec-xss pinned to security but sitting under performance.
  writeFileSync(
    join(wiki, "performance", "sec-xss.md"),
    "---\nid: sec-xss\n---\nbody\n",
  );
  const findings = validateTreeAgainstLayout(wiki, cfg);
  const pin = findings.find((f) => f.code === "LAYOUT-PIN");
  assert.ok(pin, `expected a LAYOUT-PIN finding, got: ${JSON.stringify(findings)}`);
});
