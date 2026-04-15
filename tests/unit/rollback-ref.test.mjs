// rollback-ref.test.mjs — pure resolution logic for rollback references.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRollbackRef } from "../../scripts/lib/rollback.mjs";

test("genesis resolves to op/genesis", () => {
  assert.equal(resolveRollbackRef("genesis"), "op/genesis");
});

test("bare op-id resolves to op/<id>", () => {
  assert.equal(
    resolveRollbackRef("build-20260414-001"),
    "op/build-20260414-001",
  );
});

test("pre-<op-id> resolves to pre-op/<id>", () => {
  assert.equal(
    resolveRollbackRef("pre-build-20260414-001"),
    "pre-op/build-20260414-001",
  );
});

test("already-qualified op/… refs pass through", () => {
  assert.equal(resolveRollbackRef("op/my-id"), "op/my-id");
});

test("already-qualified pre-op/… refs pass through", () => {
  assert.equal(resolveRollbackRef("pre-op/my-id"), "pre-op/my-id");
});

test("HEAD and HEAD~N pass through", () => {
  assert.equal(resolveRollbackRef("HEAD"), "HEAD");
  assert.equal(resolveRollbackRef("HEAD~1"), "HEAD~1");
  assert.equal(resolveRollbackRef("HEAD~42"), "HEAD~42");
});

test("empty/missing ref throws", () => {
  assert.throws(() => resolveRollbackRef(""), /non-empty string/);
  assert.throws(() => resolveRollbackRef(null), /non-empty string/);
  assert.throws(() => resolveRollbackRef(undefined), /non-empty string/);
});
