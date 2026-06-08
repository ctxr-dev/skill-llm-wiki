// layout-config.test.mjs — the pin grammar (one-of matchers), the fnmatch
// glob (incl. character classes), and the tree validator's empty-category
// silence. These lock the behaviours raised in the Copilot review of the
// --layout-config build-driver feature.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLayoutConfig,
  compilePins,
  categoryForLeaf,
  validateTreeAgainstLayout,
} from "../../scripts/lib/layout-config.mjs";

// Every temp dir is tracked so the suite cleans up after itself instead of
// leaking dirs under the OS temp folder across repeated runs.
const CREATED = [];
after(() => {
  for (const dir of CREATED) rmSync(dir, { recursive: true, force: true });
});

function freshDir(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-layout-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  CREATED.push(dir);
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

// Write a raw YAML string verbatim and load it (for parser-shape tests).
function loadRaw(tag, yamlText) {
  const dir = freshDir(tag);
  const path = join(dir, "layout.yaml");
  writeFileSync(path, yamlText);
  return loadLayoutConfig(path);
}

// ── YAML parsing: pure-YAML, not frontmatter-fenced ──────────────────

test("loadLayoutConfig parses a file that starts with a --- document marker", () => {
  const cfg = loadRaw(
    "doc-marker",
    "---\nlayout_version: 1\ntaxonomy:\n  - id: security\n    pin:\n      - id_prefix: \"sec-\"\n",
  );
  assert.equal(cfg.layout_version, 1);
  assert.equal(compilePins(cfg)("sec-xss").category, "security");
});

test("loadLayoutConfig preserves a |+ block scalar (no trailing-ws corruption)", () => {
  const cfg = loadRaw(
    "block-scalar",
    "taxonomy:\n  - id: security\n    purpose: |+\n      keep\n\n    pin:\n      - id_prefix: \"sec-\"\n",
  );
  const cat = cfg.taxonomy.find((c) => c.id === "security");
  assert.equal(cat.purpose, "keep\n\n");
});

test("loadLayoutConfig rejects a multi-document YAML stream", () => {
  assert.throws(
    () => loadRaw("multidoc", "taxonomy:\n  - id: a\n    pin: [{id_prefix: \"a-\"}]\n---\nb: 2\n"),
    /failed to parse YAML/,
  );
});

// ── categoryForLeaf id resolution: data.id / .id / source_path ───────

test("categoryForLeaf resolves a parsed-frontmatter shape via data.id", () => {
  const cfg = loadFrom("data-id", [{ id: "security", pin: [{ id_prefix: "sec-" }] }]);
  // The shape parseFrontmatter returns: { data: {...}, body }.
  assert.equal(categoryForLeaf(cfg, { data: { id: "sec-xss" }, body: "x" }), "security");
});

test("categoryForLeaf resolves a flat candidate via .id", () => {
  const cfg = loadFrom("flat-id", [{ id: "security", pin: [{ id_prefix: "sec-" }] }]);
  assert.equal(categoryForLeaf(cfg, { id: "sec-xss" }), "security");
});

test("categoryForLeaf falls back to the source filename stem", () => {
  const cfg = loadFrom("src-path", [{ id: "security", pin: [{ id_prefix: "sec-" }] }]);
  assert.equal(categoryForLeaf(cfg, { source_path: "/a/b/sec-xss.md" }), "security");
});

test("categoryForLeaf prefers data.id over a stale source_path stem", () => {
  const cfg = loadFrom("prefer-data", [
    { id: "security", pin: [{ id_prefix: "sec-" }] },
    { id: "performance", pin: [{ id_prefix: "perf-" }] },
  ]);
  // data.id wins even when the file path would route elsewhere.
  assert.equal(
    categoryForLeaf(cfg, { data: { id: "sec-xss" }, source_path: "/x/perf-slow.md" }),
    "security",
  );
});

test("categoryForLeaf returns null for an unmatched id", () => {
  const cfg = loadFrom("nohit", [{ id: "security", pin: [{ id_prefix: "sec-" }] }]);
  assert.equal(categoryForLeaf(cfg, { data: { id: "lang-python" } }), null);
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
