// default-sibling-naming.test.mjs — the new `<source>.wiki` naming rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultSiblingPath } from "../../scripts/lib/paths.mjs";

test("basic relative path", () => {
  assert.equal(defaultSiblingPath("./docs"), resolve("./docs.wiki"));
});

test("trailing slash is normalised", () => {
  assert.equal(defaultSiblingPath("./docs/"), resolve("./docs.wiki"));
});

test("absolute path", () => {
  const abs = join(tmpdir(), "fluffy");
  assert.equal(defaultSiblingPath(abs), `${abs}.wiki`);
});

test("cwd-as-source uses basename of cwd", () => {
  const sibling = defaultSiblingPath(".");
  const expected = resolve(".") + ".wiki";
  // basename(resolve(".")) is the cwd's own name — resolve(".") gives
  // the absolute cwd, so the sibling is `/abs/cwd.wiki`.
  assert.equal(sibling, expected);
});

test("multi-segment path preserves parent", () => {
  const abs = join(tmpdir(), "alice", "projects", "docs");
  assert.equal(defaultSiblingPath(abs), `${abs}.wiki`);
});

test("result never contains .llmwiki.vN anywhere", () => {
  const samples = ["./docs", "/tmp/a", "../rel/path"];
  for (const s of samples) {
    assert.ok(
      !/\.llmwiki\.v\d+/.test(defaultSiblingPath(s)),
      `sibling for ${s} must not use legacy versioned naming`,
    );
  }
});
