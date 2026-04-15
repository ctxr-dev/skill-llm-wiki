// hidden-git-commands.test.mjs — exercise every hidden-git subcommand
// against a freshly-built wiki: diff, log, show, blame, reflog, history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function runCli(args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, LLM_WIKI_NO_PROMPT: "1" },
  });
}

function seedWiki(tag) {
  const parent = join(
    tmpdir(),
    `skill-llm-wiki-hg-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(parent);
  const src = join(parent, "docs");
  mkdirSync(src);
  writeFileSync(join(src, "alpha.md"), "# Alpha\n\nfirst leaf\n");
  writeFileSync(join(src, "beta.md"), "# Beta\n\nsecond leaf\n");
  const build = runCli(["build", src]);
  if (build.status !== 0) {
    throw new Error(`seedWiki build failed: ${build.stderr}`);
  }
  return { parent, wiki: join(parent, "docs.wiki") };
}

test("log produces oneline commit history", () => {
  const { parent, wiki } = seedWiki("log");
  try {
    const r = runCli(["log", wiki]);
    assert.equal(r.status, 0, r.stderr);
    // Expect genesis, pre-op, draft-frontmatter, index-generation.
    assert.match(r.stdout, /genesis/);
    assert.match(r.stdout, /pre-op/);
    assert.match(r.stdout, /draft-frontmatter/);
    assert.match(r.stdout, /index-generation/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("log --op narrows to the commit range for a single operation", () => {
  const { parent, wiki } = seedWiki("log-op");
  try {
    // Find the build op-id from the default log output.
    const all = runCli(["log", wiki, "--format=%D", "-1"]);
    assert.equal(all.status, 0);
    const match = /tag: op\/(build-[^,\s)]+)/.exec(all.stdout);
    assert.ok(match, `could not extract op-id: ${all.stdout}`);
    const opId = match[1];

    const narrowed = runCli(["log", wiki, "--op", opId]);
    assert.equal(narrowed.status, 0, narrowed.stderr);
    // Inside the op range we expect the per-phase commits but NOT the
    // genesis commit (which lives before pre-op/<id>).
    assert.match(narrowed.stdout, /draft-frontmatter/);
    assert.match(narrowed.stdout, /index-generation/);
    assert.doesNotMatch(narrowed.stdout, /genesis/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("log --op with an unknown id exits 2 cleanly", () => {
  const { parent, wiki } = seedWiki("log-op-missing");
  try {
    const r = runCli(["log", wiki, "--op", "bogus-op-id"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /pre-op\/bogus-op-id not found/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("diff --op renders a filed stat across the whole operation", () => {
  const { parent, wiki } = seedWiki("diff-op");
  try {
    // Extract op-id from log output.
    const log = runCli(["log", wiki, "--format=%D", "-1"]);
    assert.equal(log.status, 0);
    const match = /tag: op\/(build-[^,\s)]+)/.exec(log.stdout);
    assert.ok(match, `unable to extract op-id from log: ${log.stdout}`);
    const opId = match[1];

    const r = runCli(["diff", wiki, "--op", opId, "--stat"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /index\.md/);
    assert.match(r.stdout, /alpha\.md/);
    assert.match(r.stdout, /beta\.md/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("show <ref> surfaces a specific commit", () => {
  const { parent, wiki } = seedWiki("show");
  try {
    const r = runCli(["show", wiki, "HEAD"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /commit /);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("blame on an index file points at skill-llm-wiki as the author", () => {
  const { parent, wiki } = seedWiki("blame");
  try {
    const r = runCli(["blame", wiki, join(wiki, "index.md")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /skill-llm-wiki/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("reflog lists the operation sequence", () => {
  const { parent, wiki } = seedWiki("reflog");
  try {
    const r = runCli(["reflog", wiki]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HEAD@\{\d+\}/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("history <entry-id> combines op-log and git log views", () => {
  const { parent, wiki } = seedWiki("history");
  try {
    const r = runCli(["history", wiki, "alpha"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Op-log entries mentioning alpha/);
    assert.match(r.stdout, /Git history for files matching/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("diff without --op passes through to bare git diff", () => {
  const { parent, wiki } = seedWiki("diff-bare");
  try {
    // After the build, the working tree is clean — `diff` should show
    // nothing. Exit 0.
    const r = runCli(["diff", wiki]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
