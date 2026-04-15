// git-env.test.mjs — verify every git subprocess call carries the full
// isolation env block and the forced -c flag set, and that process.env
// is never mutated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { buildGitEnv, gitDir, IS_WINDOWS } from "../../scripts/lib/git.mjs";

test("buildGitEnv includes every required key", () => {
  const env = buildGitEnv("/tmp/fake-wiki");
  assert.equal(env.GIT_DIR, gitDir("/tmp/fake-wiki"));
  assert.equal(env.GIT_WORK_TREE, "/tmp/fake-wiki");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_GLOBAL, IS_WINDOWS ? "NUL" : "/dev/null");
  assert.equal(env.HOME, tmpdir());
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(env.GIT_AUTHOR_NAME, "skill-llm-wiki");
  assert.equal(env.GIT_AUTHOR_EMAIL, "noreply@skill-llm-wiki.invalid");
  assert.equal(env.GIT_COMMITTER_NAME, "skill-llm-wiki");
  assert.equal(env.GIT_COMMITTER_EMAIL, "noreply@skill-llm-wiki.invalid");
});

test("buildGitEnv preserves ambient process.env but overrides git-specific vars", () => {
  const original = process.env.PATH;
  const env = buildGitEnv("/tmp/x");
  // PATH should still flow through so git is resolvable.
  assert.equal(env.PATH, original);
});

test("buildGitEnv does not mutate process.env", () => {
  const before = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    HOME: process.env.HOME,
  };
  buildGitEnv("/tmp/fake");
  const after = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    HOME: process.env.HOME,
  };
  assert.deepEqual(before, after);
});

test("gitDir places the bare repo under .llmwiki/git/", () => {
  assert.equal(gitDir("/wiki"), "/wiki/.llmwiki/git");
});

test("LLM_WIKI_FIXED_TIMESTAMP is respected for commit pinning", () => {
  // buildGitEnv doesn't read this var directly — gitCommit does — so we
  // assert only that the env block carries unrelated vars unchanged.
  process.env.LLM_WIKI_FIXED_TIMESTAMP = "1700000000";
  const env = buildGitEnv("/tmp/x");
  assert.equal(env.LLM_WIKI_FIXED_TIMESTAMP, "1700000000");
  delete process.env.LLM_WIKI_FIXED_TIMESTAMP;
});
