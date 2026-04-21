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
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
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

test("--quality-mode deterministic => byte-identical tree SHAs across runs (cluster path included)", async () => {
  // The companion test above uses LLM_WIKI_SKIP_CLUSTER_NEST=1 to skip
  // the cluster-detection path. Deterministic mode's whole contract is
  // that the cluster path is ALSO byte-reproducible — zero Tier 2
  // calls, zero LLM responses, deterministic slug + purpose derivation
  // from member frontmatters. This test drops the cluster-nest skip
  // and seeds a corpus rich enough to trigger cluster detection
  // (two 3-leaf themes), then asserts tree SHAs match across two
  // independent runs.
  const parentA = join(tmpdir(), `skill-llm-wiki-det-qm-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const parentB = join(tmpdir(), `skill-llm-wiki-det-qm-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(parentA, { recursive: true });
  mkdirSync(parentB, { recursive: true });
  try {
    const seedCorpus = (parent) => {
      const src = join(parent, "corpus");
      mkdirSync(src);
      // Two themes: caching (redis / memcached / varnish) and retry
      // budgeting (http / rpc / circuit-breaker). Both themes have the
      // 3-leaf minimum cluster size, and the frontmatters carry
      // distinguishing activation keywords + tags so cluster detection
      // fires at a sensible threshold.
      const leaves = [
        { id: "redis-cache", theme: "caching", f: "redis lru eviction",
          covers: ["lru cache", "eviction policy"], tags: ["cache", "redis"] },
        { id: "memcached-cache", theme: "caching", f: "memcached slab allocation",
          covers: ["slab allocation", "key prefixing"], tags: ["cache", "memcached"] },
        { id: "varnish-cache", theme: "caching", f: "varnish edge cache topology",
          covers: ["edge cache", "vcl rules"], tags: ["cache", "varnish"] },
        { id: "http-retry", theme: "retries", f: "http retry budget exponential backoff",
          covers: ["retry budget", "exponential backoff"], tags: ["retries", "http"] },
        { id: "rpc-retry", theme: "retries", f: "rpc retry deadline propagation",
          covers: ["deadline propagation", "retry budget"], tags: ["retries", "rpc"] },
        { id: "circuit-breaker", theme: "retries", f: "circuit breaker half-open probing",
          covers: ["half-open probe", "retry budget"], tags: ["retries", "breaker"] },
      ];
      for (const leaf of leaves) {
        const fm =
          "---\n" +
          `id: ${leaf.id}\n` +
          "type: primary\n" +
          "depth_role: leaf\n" +
          `focus: ${leaf.f}\n` +
          `covers: ${JSON.stringify(leaf.covers)}\n` +
          `tags: ${JSON.stringify(leaf.tags)}\n` +
          "activation:\n" +
          `  keyword_matches: ${JSON.stringify(leaf.tags)}\n` +
          "---\n\n" +
          `# ${leaf.id}\n\n${leaf.f} detail for routing discrimination.\n`;
        writeFileSync(join(src, `${leaf.id}.md`), fm);
      }
    };
    seedCorpus(parentA);
    seedCorpus(parentB);

    const run = (parent) =>
      spawnSync("node", [
        CLI,
        "build",
        join(parent, "corpus"),
        "--quality-mode",
        "deterministic",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          LLM_WIKI_NO_PROMPT: "1",
          LLM_WIKI_MOCK_TIER1: "1",
          LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
          // Explicitly set SKIP_CLUSTER_NEST=0 to override any
          // ambient value inherited from process.env. The whole point
          // of THIS test is that the cluster-nest path is deterministic
          // under `--quality-mode deterministic`, so a dev or CI env
          // that sets SKIP_CLUSTER_NEST=1 must NOT silently bypass the
          // code under test and let the assertion pass vacuously.
          LLM_WIKI_SKIP_CLUSTER_NEST: "0",
        },
      });

    const rA = run(parentA);
    assert.equal(rA.status, 0, `build A failed: ${rA.stderr}`);
    const rB = run(parentB);
    assert.equal(rB.status, 0, `build B failed: ${rB.stderr}`);
    const wikiA = join(parentA, "corpus.wiki");
    const wikiB = join(parentB, "corpus.wiki");
    const treeA = gitRun(wikiA, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    const treeB = gitRun(wikiB, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    assert.match(treeA, /^[a-f0-9]{40}$/);
    assert.match(treeB, /^[a-f0-9]{40}$/);
    assert.equal(
      treeA,
      treeB,
      "deterministic quality mode must produce byte-identical tree SHAs even with cluster detection in frame",
    );

    // Audit-trail contract: every NEST entry landed in deterministic
    // mode must record `tier_used: 0` and `confidence_band:
    // "deterministic-math"` (not the legacy hardcoded `tier_used: 2`
    // / `"math-gated"` pair, which would misleadingly suggest Tier 2
    // was consulted). Tooling that filters decisions.yaml by
    // tier_used to reason about sub-agent costs must see the real
    // zero here.
    const { readDecisions } = await import(
      "../../scripts/lib/decision-log.mjs"
    );
    const nestEntries = readDecisions(wikiA).filter(
      (e) => e.operator === "NEST",
    );
    // Hard-assert at least one NEST entry was produced. Without this
    // check, the test would pass vacuously if the cluster-nest path
    // never fired (e.g. a regression makes no clusters detectable, or
    // a refactor silently skips the branch), defeating the whole
    // point of an audit-trail coverage test. The 6-leaf two-theme
    // seed corpus is designed so the cluster detector produces at
    // least one math candidate that auto-approves into a NEST under
    // deterministic mode.
    assert.ok(
      nestEntries.length > 0,
      "expected deterministic cluster-nest to fire and emit at least one NEST audit entry; if this fails, either the seed corpus no longer triggers clustering or the deterministic branch regressed",
    );
    for (const e of nestEntries) {
      assert.equal(
        e.tier_used,
        0,
        `deterministic NEST entry for ${e.sources?.join(",")} must record tier_used=0 (got ${e.tier_used})`,
      );
      assert.equal(
        e.confidence_band,
        "deterministic-math",
        `deterministic NEST entry for ${e.sources?.join(",")} must carry confidence_band="deterministic-math" (got ${e.confidence_band})`,
      );
    }
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
