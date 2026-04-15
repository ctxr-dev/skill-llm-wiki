// preflight.test.mjs — test the Node and git preflight checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightNode, preflightGit } from "../../scripts/lib/preflight.mjs";

test("preflightNode accepts current Node (≥ 18)", () => {
  const r = preflightNode();
  assert.equal(r.ok, true);
  assert.ok(r.version.major >= 18);
});

test("preflightGit succeeds in a dev environment (git present, ≥ 2.25)", () => {
  const r = preflightGit();
  assert.equal(r.ok, true);
  assert.ok(r.version.major >= 2);
});
