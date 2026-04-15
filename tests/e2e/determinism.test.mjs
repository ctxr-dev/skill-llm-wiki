// determinism.test.mjs — prove that a fixed timestamp yields byte-identical
// commit SHAs across runs. This is the load-bearing test for the promise
// that `skill-llm-wiki build` is reproducible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { preOpSnapshot } from "../../scripts/lib/snapshot.mjs";
import { gitHeadSha, gitRun } from "../../scripts/lib/git.mjs";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

function runCliFixed(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      LLM_WIKI_MOCK_TIER1: "1",
      LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
      ...(opts.env || {}),
    },
  });
}

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-det-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function seed(wiki) {
  writeFileSync(join(wiki, "a.md"), "# a\n\nalpha\n");
  writeFileSync(join(wiki, "b.md"), "# b\n\nbeta\n");
}

test("same inputs + LLM_WIKI_FIXED_TIMESTAMP => byte-identical commit SHAs", () => {
  const originalTs = process.env.LLM_WIKI_FIXED_TIMESTAMP;
  process.env.LLM_WIKI_FIXED_TIMESTAMP = "1700000000";
  const wikiA = tmpWiki("a");
  const wikiB = tmpWiki("b");
  try {
    seed(wikiA);
    seed(wikiB);
    preOpSnapshot(wikiA, "det-op");
    preOpSnapshot(wikiB, "det-op");
    const shaA = gitHeadSha(wikiA);
    const shaB = gitHeadSha(wikiB);
    assert.ok(shaA, "wiki A has HEAD");
    assert.ok(shaB, "wiki B has HEAD");
    assert.equal(
      shaA,
      shaB,
      "same inputs + fixed timestamp must produce identical commit SHAs",
    );
  } finally {
    if (originalTs === undefined) {
      delete process.env.LLM_WIKI_FIXED_TIMESTAMP;
    } else {
      process.env.LLM_WIKI_FIXED_TIMESTAMP = originalTs;
    }
    rmSync(wikiA, { recursive: true, force: true });
    rmSync(wikiB, { recursive: true, force: true });
  }
});

test("full build with LLM_WIKI_FIXED_TIMESTAMP => byte-identical HEAD commit AND tree SHAs across runs", () => {
  // Under LLM_WIKI_FIXED_TIMESTAMP, `newOpId` (cli.mjs:244) replaces
  // the random component with the literal string "deterministic", so
  // two builds of the same source corpus produce identical op-ids,
  // identical commit objects, and identical tree objects. Both the
  // commit SHA and the tree SHA are asserted here.
  //
  // A regression that reintroduces wall-clock drift anywhere in the
  // pipeline — random ordering, ambient-clock fields in tracked
  // files, per-run entropy in frontmatter, etc. — fails both
  // assertions loudly.
  const parentA = join(tmpdir(), `skill-llm-wiki-det-full-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const parentB = join(tmpdir(), `skill-llm-wiki-det-full-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(parentA, { recursive: true });
  mkdirSync(parentB, { recursive: true });
  try {
    for (const parent of [parentA, parentB]) {
      const src = join(parent, "corpus");
      mkdirSync(src);
      writeFileSync(join(src, "alpha.md"), "# Alpha\n\nalpha content unique xyzzy\n");
      writeFileSync(join(src, "beta.md"), "# Beta\n\nbeta content unique foobar\n");
    }
    const rA = runCliFixed(["build", join(parentA, "corpus")]);
    assert.equal(rA.status, 0, `build A failed: ${rA.stderr}`);
    const rB = runCliFixed(["build", join(parentB, "corpus")]);
    assert.equal(rB.status, 0, `build B failed: ${rB.stderr}`);
    const wikiA = join(parentA, "corpus.wiki");
    const wikiB = join(parentB, "corpus.wiki");
    const commitA = gitRun(wikiA, ["rev-parse", "HEAD"]).stdout.trim();
    const commitB = gitRun(wikiB, ["rev-parse", "HEAD"]).stdout.trim();
    const treeA = gitRun(wikiA, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const treeB = gitRun(wikiB, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    assert.match(commitA, /^[a-f0-9]{40}$/);
    assert.match(commitB, /^[a-f0-9]{40}$/);
    assert.match(treeA, /^[a-f0-9]{40}$/);
    assert.match(treeB, /^[a-f0-9]{40}$/);
    assert.equal(
      treeA,
      treeB,
      "same source + fixed timestamp must produce identical tree SHAs — a drift here means a phase is reading wall-clock state or non-deterministic ordering",
    );
    assert.equal(
      commitA,
      commitB,
      "same source + fixed timestamp must produce identical HEAD commit SHAs — a drift here means newOpId is leaking wall-clock state or a phase commit carries ambient-clock metadata",
    );
  } finally {
    rmSync(parentA, { recursive: true, force: true });
    rmSync(parentB, { recursive: true, force: true });
  }
});

test("malformed LLM_WIKI_FIXED_TIMESTAMP fails loud", () => {
  const originalTs = process.env.LLM_WIKI_FIXED_TIMESTAMP;
  process.env.LLM_WIKI_FIXED_TIMESTAMP = "not-a-number";
  const wiki = tmpWiki("bad");
  try {
    seed(wiki);
    assert.throws(
      () => preOpSnapshot(wiki, "bad-op"),
      /LLM_WIKI_FIXED_TIMESTAMP must be a positive integer/,
    );
  } finally {
    if (originalTs === undefined) {
      delete process.env.LLM_WIKI_FIXED_TIMESTAMP;
    } else {
      process.env.LLM_WIKI_FIXED_TIMESTAMP = originalTs;
    }
    rmSync(wiki, { recursive: true, force: true });
  }
});
