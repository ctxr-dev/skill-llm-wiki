import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { indexIdForDir } from "../../scripts/lib/paths.mjs";

test("indexIdForDir: root keeps its basename", () => {
  assert.equal(indexIdForDir("/w/memory.wiki", "/w/memory.wiki"), "memory.wiki");
});

test("indexIdForDir: depth-1 id equals the basename (one-level wikis stay unchanged)", () => {
  assert.equal(indexIdForDir("/w/memory.wiki", "/w/memory.wiki/knowledge"), "knowledge");
});

test("indexIdForDir: depth >= 2 id is the POSIX path relative to the wiki root", () => {
  assert.equal(
    indexIdForDir("/w/memory.wiki", "/w/memory.wiki/knowledge/billing/decision"),
    "knowledge/billing/decision",
  );
  // A recurring day-of-month no longer collides: each is a distinct path id.
  assert.equal(indexIdForDir("/w/m.wiki", join("/w/m.wiki", "daily", "2026", "05", "22")), "daily/2026/05/22");
  assert.equal(indexIdForDir("/w/m.wiki", join("/w/m.wiki", "daily", "2026", "06", "22")), "daily/2026/06/22");
});

test("indexIdForDir: a trailing-slash root resolves consistently", () => {
  assert.equal(indexIdForDir("/w/m.wiki/", "/w/m.wiki/a/b"), "a/b");
});
