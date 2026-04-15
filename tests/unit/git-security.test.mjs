// git-security.test.mjs — regressions for the Phase 8 security sweep
// findings D2 (git ref flag smuggling) and D3 (GIT_* env leak from
// process.env).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGitEnv,
  gitCatFileSize,
  gitResetHard,
  gitRevParse,
  gitTag,
} from "../../scripts/lib/git.mjs";
import {
  resolveRollbackRef,
} from "../../scripts/lib/rollback.mjs";

function mkTmp(tag) {
  return mkdtempSync(join(tmpdir(), `skill-llm-wiki-sec-${tag}-`));
}

// ── D2 — ref flag smuggling ─────────────────────────────────────────

test("resolveRollbackRef: refuses refs starting with -", () => {
  assert.throws(() => resolveRollbackRef("--exec=pwned"), /must not start with '-'/);
  assert.throws(() => resolveRollbackRef("-foo"), /must not start with '-'/);
});

test("resolveRollbackRef: refuses control characters", () => {
  // Embedded newline would not normally reach resolveRollbackRef,
  // but defence in depth: reject at the gate.
  assert.throws(() => resolveRollbackRef("op/foo\nbar"), /invalid op ref body/);
});

test("resolveRollbackRef: refuses malformed pre-op body", () => {
  assert.throws(() => resolveRollbackRef("pre-op/foo$bar"), /invalid pre-op ref body/);
});

test("resolveRollbackRef: accepts valid HEAD forms and bare op-ids", () => {
  assert.equal(resolveRollbackRef("HEAD"), "HEAD");
  assert.equal(resolveRollbackRef("HEAD~3"), "HEAD~3");
  assert.equal(resolveRollbackRef("HEAD^"), "HEAD^");
  assert.equal(resolveRollbackRef("genesis"), "op/genesis");
  assert.equal(resolveRollbackRef("build-20260101-abc"), "op/build-20260101-abc");
  assert.equal(
    resolveRollbackRef("pre-build-20260101-abc"),
    "pre-op/build-20260101-abc",
  );
});

test("gitRevParse: refuses refs starting with -", () => {
  const dir = mkTmp("revparse");
  try {
    assert.throws(
      () => gitRevParse(dir, "--help"),
      /refs starting with '-' are refused/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitResetHard: refuses refs starting with -", () => {
  const dir = mkTmp("reset");
  try {
    assert.throws(
      () => gitResetHard(dir, "--exec=evil"),
      /refs starting with '-' are refused/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitTag: refuses tagName or commitRef starting with -", () => {
  const dir = mkTmp("tag");
  try {
    assert.throws(
      () => gitTag(dir, "--evil", "HEAD"),
      /refs starting with '-' are refused/,
    );
    assert.throws(
      () => gitTag(dir, "legit", "--exec=evil"),
      /refs starting with '-' are refused/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitCatFileSize: refuses specs starting with -", () => {
  const dir = mkTmp("catfile");
  try {
    assert.throws(
      () => gitCatFileSize(dir, "--long"),
      /refs starting with '-' are refused/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D3 — GIT_* env leak ─────────────────────────────────────────────

test("buildGitEnv: strips inherited GIT_* from process.env", () => {
  const originalGitDir = process.env.GIT_DIR;
  const originalAltObj = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const originalAuthorDate = process.env.GIT_AUTHOR_DATE;
  const originalSshAskpass = process.env.SSH_ASKPASS;
  process.env.GIT_DIR = "/tmp/attacker-dir";
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = "/tmp/attacker-objs";
  process.env.GIT_AUTHOR_DATE = "1999-01-01T00:00:00Z";
  process.env.SSH_ASKPASS = "/tmp/attacker-askpass";
  try {
    const fakeWiki = join(tmpdir(), "fake-wiki");
    const env = buildGitEnv(fakeWiki);
    // The skill's own overrides must win.
    assert.equal(env.GIT_DIR, join(fakeWiki, ".llmwiki", "git"));
    // The alternate-object-dirs key must have been dropped entirely
    // (the skill never sets it, so its presence would mean leakage).
    assert.equal(
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      undefined,
      "GIT_ALTERNATE_OBJECT_DIRECTORIES must not leak from parent env",
    );
    // GIT_AUTHOR_DATE was unset by the sanitiser; the skill only sets
    // it explicitly when LLM_WIKI_FIXED_TIMESTAMP is present.
    assert.equal(env.GIT_AUTHOR_DATE, undefined);
    // SSH_ASKPASS must be stripped so a GUI askpass cannot interact.
    assert.equal(env.SSH_ASKPASS, undefined);
    // Non-GIT env vars are preserved (PATH must survive).
    assert.ok(env.PATH);
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalAltObj === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = originalAltObj;
    if (originalAuthorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = originalAuthorDate;
    if (originalSshAskpass === undefined) delete process.env.SSH_ASKPASS;
    else process.env.SSH_ASKPASS = originalSshAskpass;
  }
});

test("buildGitEnv: does not mutate process.env", () => {
  const before = JSON.stringify(process.env);
  buildGitEnv(join(tmpdir(), "fake-wiki"));
  const after = JSON.stringify(process.env);
  assert.equal(after, before, "buildGitEnv must not mutate process.env");
});
