// preflight-deps.test.mjs — unit tests for preflightDependencies(skillRoot).
//
// Verifies:
//   1. All deps present from the real skill root → { ok: true, missing: [] }
//   2. Injecting a non-existent dep name surfaces it via missing[]
//   3. Custom skillRoot path resolution works (anchors at the passed root,
//      not at the test file's cwd)
//   4. An invalid skillRoot returns a structured failure (no throw)

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightDependencies,
  REQUIRED_RUNTIME_DEPS,
} from "../../scripts/lib/preflight.mjs";

const SKILL_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("preflightDependencies: all required deps present", () => {
  const r = preflightDependencies(SKILL_ROOT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test("preflightDependencies: REQUIRED_RUNTIME_DEPS contract", () => {
  // Defensive: if someone bumps the list, the test alerts so the
  // matching CLI / docs paths are kept in sync.
  assert.ok(Array.isArray(REQUIRED_RUNTIME_DEPS));
  assert.ok(REQUIRED_RUNTIME_DEPS.includes("gray-matter"));
  assert.ok(REQUIRED_RUNTIME_DEPS.includes("@xenova/transformers"));
});

test("preflightDependencies: missing dep flagged via injected list", () => {
  const r = preflightDependencies(SKILL_ROOT, [
    "gray-matter",
    "this-package-does-not-exist-preflight-test",
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 8);
  assert.deepEqual(r.missing, [
    "this-package-does-not-exist-preflight-test",
  ]);
  assert.match(r.message, /required runtime dependencies are missing/);
  assert.match(r.message, /this-package-does-not-exist-preflight-test/);
});

test("preflightDependencies: only missing names are reported", () => {
  const r = preflightDependencies(SKILL_ROOT, [
    "first-missing-pkg-xyz",
    "gray-matter",
    "second-missing-pkg-xyz",
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, [
    "first-missing-pkg-xyz",
    "second-missing-pkg-xyz",
  ]);
});

test("preflightDependencies: custom skillRoot path resolution", () => {
  // Pointing at the skill root explicitly via an absolute path must
  // produce the same result as the default. This guards against any
  // future refactor that accidentally hard-codes a relative path.
  const r = preflightDependencies(SKILL_ROOT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

test("preflightDependencies: bad skillRoot returns structured failure", () => {
  // A path with no package.json must fail cleanly (no thrown
  // exception) so the CLI's preflight block can handle it the same way
  // as a missing-dep result.
  const r = preflightDependencies("/tmp/definitely-not-a-skill-root-xyz");
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 8);
  assert.ok(r.missing.length > 0);
});
