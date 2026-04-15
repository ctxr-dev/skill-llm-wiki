// frontmatter-pollution.test.mjs — regression for D1 (prototype
// pollution via `__proto__` / `constructor` / `prototype` keys in
// adversarial YAML frontmatter).
//
// The fix in `parseMap` refuses these reserved keys and writes every
// legal key via `Object.defineProperty` so the `__proto__` setter
// cannot fire. These tests pin the contract so a future refactor that
// re-introduces the `out[key] = …` pattern fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";

test("frontmatter: __proto__ key is refused at parse time", () => {
  const raw = "---\nfocus: legal\n__proto__:\n  tainted: yes\n---\nbody\n";
  assert.throws(
    () => parseFrontmatter(raw, "<mem>"),
    /forbidden YAML key "__proto__"/,
  );
});

test("frontmatter: constructor key is refused", () => {
  const raw = "---\nfocus: legal\nconstructor:\n  tainted: yes\n---\nbody\n";
  assert.throws(
    () => parseFrontmatter(raw, "<mem>"),
    /forbidden YAML key "constructor"/,
  );
});

test("frontmatter: prototype key is refused", () => {
  const raw = "---\nprototype: tainted\n---\nbody\n";
  assert.throws(
    () => parseFrontmatter(raw, "<mem>"),
    /forbidden YAML key "prototype"/,
  );
});

test("frontmatter: legal keys parse identically to the pre-fix path", () => {
  const raw = [
    "---",
    "id: alpha",
    "type: primary",
    "focus: lawful focus string",
    "covers:",
    "  - one",
    "  - two",
    "tags: [a, b]",
    "---",
    "body",
    "",
  ].join("\n");
  const { data, body } = parseFrontmatter(raw, "<mem>");
  assert.equal(data.id, "alpha");
  assert.equal(data.type, "primary");
  assert.equal(data.focus, "lawful focus string");
  assert.deepEqual(data.covers, ["one", "two"]);
  assert.deepEqual(data.tags, ["a", "b"]);
  assert.equal(body, "body\n");
});

test("frontmatter: nested map with legal keys still parses", () => {
  const raw = [
    "---",
    "source:",
    "  path: ./foo.md",
    "  hash: sha256:abc",
    "---",
    "",
  ].join("\n");
  const { data } = parseFrontmatter(raw, "<mem>");
  assert.deepEqual(data.source, { path: "./foo.md", hash: "sha256:abc" });
});

test("frontmatter: nested __proto__ inside a legal parent is still refused", () => {
  const raw = [
    "---",
    "source:",
    "  __proto__:",
    "    tainted: yes",
    "---",
    "",
  ].join("\n");
  assert.throws(
    () => parseFrontmatter(raw, "<mem>"),
    /forbidden YAML key "__proto__"/,
  );
});

test("frontmatter: poisoned object cannot reach Object.prototype", () => {
  // Belt-and-braces — even if a future refactor loosens the check,
  // verify the module hasn't already polluted the global prototype.
  assert.equal(({}).tainted, undefined);
  assert.equal(Object.prototype.tainted, undefined);
});
