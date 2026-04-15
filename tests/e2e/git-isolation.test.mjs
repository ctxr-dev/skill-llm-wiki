// git-isolation.test.mjs — ZERO TOLERANCE.
//
// Prove that running skill-llm-wiki operations inside a synthetic user git
// repository never perturbs the user's repo — even when that repo has
// hostile configuration (pre-commit hook, signing requirement, custom
// hooksPath, template, etc.). The user's .git HEAD, reflog, working-tree
// status, and any pre-commit sentinel files must be byte-identical after
// the skill runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preOpSnapshot } from "../../scripts/lib/snapshot.mjs";

function tmpDir(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-iso-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Recursive sha256 of a directory (all files sorted) — used to prove the
// user repo is untouched. Skips any `docs/.llmwiki/` subtree because that
// is legitimately our private metadata.
function dirHash(root, { skip = [] } = {}) {
  const skipSet = new Set(skip.map((s) => s.replace(/\\/g, "/")));
  const h = createHash("sha256");
  function walk(rel) {
    const full = join(root, rel);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full).sort()) {
      const sub = rel ? `${rel}/${name}` : name;
      if (skipSet.has(sub)) continue;
      const full2 = join(root, sub);
      let st;
      try {
        st = readFileSync(full2); // fails fast on directories
      } catch {
        walk(sub);
        continue;
      }
      h.update(sub);
      h.update("\0");
      h.update(st);
      h.update("\0");
    }
  }
  walk("");
  return h.digest("hex");
}

// Run a user-facing git command (no isolation env) inside a given directory.
// Helper only used to set up test fixtures and verify user-repo state —
// NOT for skill operations.
function userGit(repoPath, args) {
  const r = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `user git ${args.join(" ")} failed in ${repoPath}: ${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

function initUserRepo(tag) {
  const repo = tmpDir(tag);
  userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
  userGit(repo, ["config", "user.name", "Test User"]);
  userGit(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "README.md"), "# user repo\n");
  userGit(repo, ["add", "README.md"]);
  userGit(repo, ["commit", "-m", "initial"]);
  // Add a `docs/` subdirectory that will become the wiki target.
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "overview.md"), "# overview\n\ncontent\n");
  writeFileSync(join(repo, "docs", "guide.md"), "# guide\n\nmore\n");
  userGit(repo, ["add", "docs"]);
  userGit(repo, ["commit", "-m", "add docs"]);
  return repo;
}

test("plain user repo is byte-identical after skill snapshot", () => {
  const repo = initUserRepo("plain");
  try {
    const docs = join(repo, "docs");
    const gitDirBefore = dirHash(join(repo, ".git"));
    const headBefore = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogBefore = userGit(repo, ["reflog", "--format=%H %s"]);

    preOpSnapshot(docs, "iso-test-1");

    // Skill's private repo lives under docs/.llmwiki/ — allowed.
    assert.ok(existsSync(join(docs, ".llmwiki", "git", "HEAD")));

    const gitDirAfter = dirHash(join(repo, ".git"));
    const headAfter = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogAfter = userGit(repo, ["reflog", "--format=%H %s"]);

    assert.equal(gitDirAfter, gitDirBefore, "user .git dir must be untouched");
    assert.equal(headAfter, headBefore, "user HEAD must be unchanged");
    assert.equal(reflogAfter, reflogBefore, "user reflog must be unchanged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("hostile user repo (pre-commit hook + signing required) unaffected by skill", () => {
  const repo = initUserRepo("hostile");
  try {
    const docs = join(repo, "docs");
    const sentinelPath = join(tmpdir(), `sentinel-${Date.now()}.txt`);
    if (existsSync(sentinelPath)) rmSync(sentinelPath);

    // Install a hostile pre-commit hook into the user's .git/hooks/.
    const hookDir = join(repo, ".git", "hooks");
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(
      join(hookDir, "pre-commit"),
      `#!/bin/sh\necho "hostile hook ran" > "${sentinelPath}"\nexit 1\n`,
      { mode: 0o755 },
    );
    chmodSync(join(hookDir, "pre-commit"), 0o755);

    // Force signing on in the user's local config — if the skill leaked
    // into this config, our commit would fail for lack of a signing key.
    userGit(repo, ["config", "commit.gpgsign", "true"]);
    userGit(repo, ["config", "user.signingkey", "DEADBEEF"]);

    // Full-tree snapshots before the skill runs.
    const gitDirBefore = dirHash(join(repo, ".git"));
    const headBefore = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogBefore = userGit(repo, ["reflog", "--format=%H %s"]);

    // The skill operation must succeed despite the hostile user config.
    preOpSnapshot(docs, "iso-test-2");

    // Sentinel must NOT exist — hook must not have run.
    assert.equal(
      existsSync(sentinelPath),
      false,
      "hostile pre-commit hook must not have executed",
    );

    const gitDirAfter = dirHash(join(repo, ".git"));
    const headAfter = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogAfter = userGit(repo, ["reflog", "--format=%H %s"]);
    assert.equal(
      gitDirAfter,
      gitDirBefore,
      "user .git dir must be byte-identical despite hostile hook/signing config",
    );
    assert.equal(headAfter, headBefore, "user HEAD must be unchanged");
    assert.equal(reflogAfter, reflogBefore, "user reflog must be unchanged");

    if (existsSync(sentinelPath)) rmSync(sentinelPath);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("hostile HOME with demanding .gitconfig does not break the skill", () => {
  const repo = initUserRepo("home");
  try {
    const docs = join(repo, "docs");
    // Install a .gitconfig in a synthetic $HOME that would break any git
    // command that read it (signing required, bogus hooksPath).
    const fakeHome = tmpDir("fake-home");
    writeFileSync(
      join(fakeHome, ".gitconfig"),
      [
        "[commit]",
        "  gpgsign = true",
        "[tag]",
        "  gpgsign = true",
        "[user]",
        "  signingkey = NONEXISTENT",
        "[core]",
        "  hooksPath = /tmp/nonexistent-hooks-dir-skill-iso",
        "",
      ].join("\n"),
    );
    const gitDirBefore = dirHash(join(repo, ".git"));
    const headBefore = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogBefore = userGit(repo, ["reflog", "--format=%H %s"]);

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // The skill's buildGitEnv overrides HOME to tmpdir(), so this hostile
      // config must never be consulted. Operation succeeds.
      preOpSnapshot(docs, "iso-test-3");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }

    const gitDirAfter = dirHash(join(repo, ".git"));
    const headAfter = userGit(repo, ["rev-parse", "HEAD"]);
    const reflogAfter = userGit(repo, ["reflog", "--format=%H %s"]);
    assert.equal(
      gitDirAfter,
      gitDirBefore,
      "user .git dir must be byte-identical despite hostile HOME config",
    );
    assert.equal(headAfter, headBefore, "user HEAD must be unchanged");
    assert.equal(reflogAfter, reflogBefore, "user reflog must be unchanged");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
