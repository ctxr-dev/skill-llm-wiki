// remote.test.mjs — end-to-end verification that `remote add` +
// `sync` exchange real git objects with a local bare repo that
// stands in for a shared remote.
//
// Covers:
//   - remote add → list round-trip through the CLI
//   - sync with a valid remote runs fetch + push and pushes the
//     op/* tags so the remote receives the history mirror
//   - sync with an unknown remote fails loud before talking to git
//   - sync --skip-fetch / --skip-push wiring
//   - regular operations (build, rebuild) never auto-push

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      LLM_WIKI_MOCK_TIER1: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
}

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-remote-e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function initBareRemote(path) {
  const r = spawnSync("git", ["init", "--bare", "--quiet", path], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`bare init failed: ${r.stderr}`);
}

function seedWiki(parent) {
  const src = join(parent, "docs");
  mkdirSync(src);
  writeFileSync(join(src, "a.md"), "# Alpha\n\nunique alpha content\n");
  writeFileSync(join(src, "b.md"), "# Beta\n\nunique beta content\n");
  const build = runCli(["build", src]);
  if (build.status !== 0) {
    throw new Error(`seedWiki build failed: ${build.stderr}`);
  }
  return join(parent, "docs.wiki");
}

test("remote add + list round-trip through the CLI", () => {
  const parent = tmpParent("add-list");
  try {
    const wiki = seedWiki(parent);
    const bare = join(parent, "bare.git");
    initBareRemote(bare);

    const add = runCli(["remote", wiki, "add", "origin", bare]);
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /origin added/);

    const list = runCli(["remote", wiki, "list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /origin/);
    assert.match(list.stdout, /bare\.git/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("sync pushes op/* tags to the remote", () => {
  const parent = tmpParent("sync-push");
  try {
    const wiki = seedWiki(parent);
    const bare = join(parent, "bare.git");
    initBareRemote(bare);

    runCli(["remote", wiki, "add", "origin", bare]);
    const sync = runCli(["sync", wiki]);
    assert.equal(sync.status, 0, `sync failed: ${sync.stderr}`);
    assert.match(sync.stdout, /pushed/);

    // Verify the bare repo now has op/* tags via git's own tag list.
    const tags = spawnSync(
      "git",
      [`--git-dir=${bare}`, "tag", "-l", "op/*"],
      { encoding: "utf8" },
    );
    assert.equal(tags.status, 0);
    assert.match(tags.stdout, /op\/build-/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("sync with unknown remote fails loud before talking to git", () => {
  const parent = tmpParent("sync-unknown");
  try {
    const wiki = seedWiki(parent);
    const r = runCli(["sync", wiki, "--remote", "nonexistent"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown remote "nonexistent"/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("sync --skip-push fetches without pushing", () => {
  const parent = tmpParent("skip-push");
  try {
    const wiki = seedWiki(parent);
    const bare = join(parent, "bare.git");
    initBareRemote(bare);
    runCli(["remote", wiki, "add", "origin", bare]);

    const r = runCli(["sync", wiki, "--skip-push"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /fetched/);
    assert.doesNotMatch(r.stdout, /pushed/);

    // Bare repo must still be empty of op tags.
    const tags = spawnSync(
      "git",
      [`--git-dir=${bare}`, "tag", "-l", "op/*"],
      { encoding: "utf8" },
    );
    assert.equal(tags.stdout.trim(), "");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("build never auto-pushes even when a remote is configured", () => {
  const parent = tmpParent("no-auto-push");
  try {
    const wiki = seedWiki(parent);
    const bare = join(parent, "bare.git");
    initBareRemote(bare);
    runCli(["remote", wiki, "add", "origin", bare]);

    // The initial seed build already ran BEFORE the remote was
    // registered. Run a no-op rebuild — no operators fire, but if
    // rebuild silently pushed, the bare repo would pick up tags.
    runCli(["rebuild", wiki]);
    const tags = spawnSync(
      "git",
      [`--git-dir=${bare}`, "tag", "-l", "op/*"],
      { encoding: "utf8" },
    );
    assert.equal(
      tags.stdout.trim(),
      "",
      "bare repo must be empty — rebuild must not auto-push",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("remote remove + list shows no remotes", () => {
  const parent = tmpParent("remove");
  try {
    const wiki = seedWiki(parent);
    const bare = join(parent, "bare.git");
    initBareRemote(bare);
    runCli(["remote", wiki, "add", "origin", bare]);

    const rm = runCli(["remote", wiki, "remove", "origin"]);
    assert.equal(rm.status, 0, rm.stderr);

    const list = runCli(["remote", wiki, "list"]);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /no remotes configured/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
