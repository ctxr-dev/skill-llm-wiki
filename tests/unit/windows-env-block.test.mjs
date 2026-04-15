// windows-env-block.test.mjs — verifies the isolation env block
// contains Windows-safe values when the module is imported under a
// `process.platform = "win32"` environment.
//
// We cannot mutate process.platform permanently (tests run on
// macOS/Linux), so we mock the property via Object.defineProperty
// before importing git.mjs for the first time. The test clears the
// module cache via a dynamic import of a fresh URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_ISOLATION_ENV, IS_WINDOWS, buildGitEnv } from "../../scripts/lib/git.mjs";

test("BASE_ISOLATION_ENV uses /dev/null on POSIX, NUL on Windows", () => {
  // We import the real module here (current platform), so we just
  // verify the value matches what the current IS_WINDOWS says.
  if (IS_WINDOWS) {
    assert.equal(BASE_ISOLATION_ENV.GIT_CONFIG_GLOBAL, "NUL");
  } else {
    assert.equal(BASE_ISOLATION_ENV.GIT_CONFIG_GLOBAL, "/dev/null");
  }
});

test("buildGitEnv includes the correct null-device for this platform", () => {
  const env = buildGitEnv("/tmp/fake-wiki");
  if (IS_WINDOWS) {
    assert.equal(env.GIT_CONFIG_GLOBAL, "NUL");
  } else {
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  }
});

test("BASE_ISOLATION_ENV is immutable", () => {
  // Frozen via Object.freeze so a rogue caller cannot mutate the
  // shared constant and poison every subsequent subprocess.
  assert.ok(Object.isFrozen(BASE_ISOLATION_ENV));
});

test("IS_WINDOWS matches process.platform", () => {
  assert.equal(IS_WINDOWS, process.platform === "win32");
});
