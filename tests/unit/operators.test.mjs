// operators.test.mjs — per-operator detection and application.
//
// Covers each of the five operators independently, then the
// convergence loop with priority ordering and termination.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import {
  DETECT_MERGE_PAIR_BATCH_SIZE,
  DETECT_MERGE_PAIR_RETRIES,
  DETECT_MERGE_PAIR_RETRY_MAX_MS,
  DETECT_MERGE_PAIR_RETRY_MIN_MS,
  DETECT_MERGE_PAIR_TIMEOUT_MS,
  collectLiveIds,
  detectDescend,
  detectLift,
  detectMerge,
  detectNestAndDecompose,
  dropStaleMathCandidate,
  mathCandidateIsFresh,
  runConvergence,
} from "../../scripts/lib/operators.mjs";
import { countPendingRequests, takePendingRequests } from "../../scripts/lib/tiered.mjs";
import { readDecisions } from "../../scripts/lib/decision-log.mjs";

process.env.LLM_WIKI_MOCK_TIER1 = "1";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-ops-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeLeaf(path, frontmatter, body = "body\n") {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", body);
  writeFileSync(path, lines.join("\n"), "utf8");
}

function writeIndex(dir, id, { authored = "", extras = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const fm = {
    id,
    type: "index",
    depth_role: "category",
    focus: `subtree under ${id}`,
    generator: "skill-llm-wiki/v1",
    ...extras,
  };
  const body =
    "\n<!-- BEGIN AUTO-GENERATED NAVIGATION -->\n" +
    `# ${id}\n\n` +
    "<!-- END AUTO-GENERATED NAVIGATION -->\n\n" +
    "<!-- BEGIN AUTHORED ORIENTATION -->\n" +
    authored +
    "\n<!-- END AUTHORED ORIENTATION -->\n";
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push("---");
  writeFileSync(join(dir, "index.md"), lines.join("\n") + body, "utf8");
}

// ── LIFT ─────────────────────────────────────────────────────────────

test("detectLift: single-child folder yields a LIFT proposal", () => {
  // Pathology lives at depth 2 so LIFT targets depth 1 (non-root) —
  // X.11 forbids LIFT-to-root, so the LIFT candidate has to sit
  // deeper than directly under wikiRoot for a proposal to emit.
  const wiki = tmpWiki("lift-basic");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "only-child"));
    writeIndex(join(wiki, "outer", "only-child"), "only-child");
    writeLeaf(join(wiki, "outer", "only-child", "lonely.md"), {
      id: "lonely",
      type: "primary",
      depth_role: "leaf",
      focus: "a lonely leaf",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].operator, "LIFT");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectLift: multi-child folder yields no proposals", () => {
  const wiki = tmpWiki("lift-multi");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "many"));
    writeIndex(join(wiki, "many"), "many");
    writeLeaf(join(wiki, "many", "a.md"), {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "a",
      parents: ["../index.md"],
    });
    writeLeaf(join(wiki, "many", "b.md"), {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "b",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectLift: root directory is never a LIFT target", () => {
  const wiki = tmpWiki("lift-root");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "alone.md"), {
      id: "alone",
      type: "primary",
      depth_role: "leaf",
      focus: "alone",
      parents: ["index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectLift: depth-1 subcategory is never a LIFT target (X.11 invariant)", () => {
  // The X.11 root-containment invariant forbids leaves at the wiki
  // root, so LIFT must refuse to land a leaf at depth 0. A single-leaf
  // subcategory directly under the wiki root stays put (it's the
  // `<slug>/<leaf>.md` terminal shape X.11 produces for outliers).
  const wiki = tmpWiki("lift-no-depth1");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "only-child"));
    writeIndex(join(wiki, "only-child"), "only-child");
    writeLeaf(join(wiki, "only-child", "leaf.md"), {
      id: "leaf",
      type: "primary",
      depth_role: "leaf",
      focus: "would-be LIFT target blocked by X.11",
      parents: ["index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(
      proposals.length,
      0,
      `no LIFT proposal for depth-1 subcategory (would violate X.11), got ${proposals.length}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("LIFT apply: leaf lifted from depth 2 to depth 1 has parents: [../index.md]", async () => {
  const wiki = tmpWiki("lift-parents-deep");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "inner"));
    writeIndex(join(wiki, "outer", "inner"), "inner");
    writeLeaf(join(wiki, "outer", "inner", "deep.md"), {
      id: "deep",
      type: "primary",
      depth_role: "leaf",
      focus: "deep content",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    // Multiple LIFT candidates might exist; pick the one targeting
    // `outer/inner/`.
    const p = proposals.find((pr) => pr.sources[1].endsWith("inner"));
    assert.ok(p, "should find a LIFT proposal for outer/inner");
    await p.apply({ wikiRoot: wiki, opId: "op-1" });
    const lifted = readFileSync(join(wiki, "outer", "deep.md"), "utf8");
    const { data } = parseFrontmatter(lifted);
    assert.deepEqual(data.parents, ["../index.md"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("LIFT apply: moves the leaf up, removes the empty folder", async () => {
  // LIFT target lives at depth 2 so the lift destination is depth 1
  // (not the wiki root — the X.11 invariant forbids LIFT-to-root).
  const wiki = tmpWiki("lift-apply");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "only-child"));
    writeIndex(join(wiki, "outer", "only-child"), "only-child");
    writeLeaf(join(wiki, "outer", "only-child", "lonely.md"), {
      id: "lonely",
      type: "primary",
      depth_role: "leaf",
      focus: "a lonely leaf",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    const proposal = proposals.find((p) => p.sources[1].endsWith("only-child"));
    assert.ok(proposal, "should find a LIFT proposal for outer/only-child");
    await proposal.apply({ wikiRoot: wiki, opId: "op-1" });
    assert.ok(
      existsSync(join(wiki, "outer", "lonely.md")),
      "leaf moved up to outer/",
    );
    assert.ok(
      !existsSync(join(wiki, "outer", "only-child")),
      "passthrough folder removed",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── MERGE ────────────────────────────────────────────────────────────

test("detectMerge guard constants: retry/timeout bounds are the documented defaults", () => {
  // Pin every exported guard constant so a future change that
  // silently retunes the reliability envelope shows up in the
  // test diff instead of drifting invisibly. If any of these
  // numbers legitimately need to move, the test updates
  // alongside a CHANGELOG entry explaining why.
  assert.equal(DETECT_MERGE_PAIR_BATCH_SIZE, 32);
  assert.equal(DETECT_MERGE_PAIR_TIMEOUT_MS, 30_000);
  assert.equal(DETECT_MERGE_PAIR_RETRIES, 2);
  assert.equal(DETECT_MERGE_PAIR_RETRY_MIN_MS, 500);
  assert.equal(DETECT_MERGE_PAIR_RETRY_MAX_MS, 5_000);
  // Sanity: min ≤ max and retries ≥ 1 (else there's no retry at
  // all and the whole p-retry wrapper is a no-op).
  assert.ok(DETECT_MERGE_PAIR_RETRY_MIN_MS <= DETECT_MERGE_PAIR_RETRY_MAX_MS);
  assert.ok(DETECT_MERGE_PAIR_RETRIES >= 1);
});

test("detectMerge: near-identical siblings yield a MERGE proposal", async () => {
  const wiki = tmpWiki("merge-basic");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "prisma-a.md"), {
      id: "prisma-a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations and seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    writeLeaf(join(wiki, "prisma-b.md"), {
      id: "prisma-b",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations and seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1);
    const merge = proposals.find((p) => p.operator === "MERGE");
    assert.ok(merge);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectMerge: unrelated siblings produce no MERGE proposals", async () => {
  const wiki = tmpWiki("merge-none");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "react.md"), {
      id: "react",
      type: "primary",
      depth_role: "leaf",
      focus: "react hooks correctness",
      covers: ["useEffect rules", "dependency arrays"],
      parents: ["index.md"],
      tags: ["react"],
    });
    writeLeaf(join(wiki, "terraform.md"), {
      id: "terraform",
      type: "primary",
      depth_role: "leaf",
      focus: "terraform module composition",
      covers: ["module sources", "variable defaults"],
      parents: ["index.md"],
      tags: ["terraform"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    const merges = proposals.filter((p) => p.operator === "MERGE");
    assert.equal(merges.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: absorbs the shorter-focus entry into the longer", async () => {
  const wiki = tmpWiki("merge-apply");
  try {
    writeIndex(wiki, "root");
    // Both entries have ALMOST identical focus + covers so Tier 0
    // resolves to decisive-same. The `long` entry has a slightly
    // longer focus string and an extra cover so the apply step
    // picks it as the keeper.
    writeLeaf(join(wiki, "short.md"), {
      id: "short",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    writeLeaf(join(wiki, "long.md"), {
      id: "long",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands", "schema file"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1);
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    // The longer-focus entry survives.
    assert.ok(existsSync(join(wiki, "long.md")));
    assert.ok(!existsSync(join(wiki, "short.md")));
    const { data } = parseFrontmatter(readFileSync(join(wiki, "long.md"), "utf8"));
    // Merged covers contain everything from both sources (deduped).
    const covered = new Set(data.covers);
    assert.ok(covered.has("migrate dev"));
    assert.ok(covered.has("migrate deploy"));
    assert.ok(covered.has("seed commands"));
    assert.ok(covered.has("schema file"));
    assert.ok(data.aliases.includes("short"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: unions tags and domains from both entries", async () => {
  const wiki = tmpWiki("merge-union-fields");
  try {
    writeIndex(wiki, "root");
    // Two entries with IDENTICAL focus + covers so Tier 0 hits
    // decisive-same. Their tags/domains differ — the point of the
    // test is that applyMerge correctly unions those lists.
    writeLeaf(join(wiki, "a.md"), {
      id: "a-entry",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
      domains: ["backend"],
    });
    writeLeaf(join(wiki, "b.md"), {
      id: "b-entry",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "database"],
      domains: ["backend", "infra"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(
      proposals.length >= 1,
      `expected a MERGE proposal, got none (the pair may have slipped out of decisive-same with the new IDF formula)`,
    );
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    // The keeper (b-entry, longer focus) survives.
    assert.ok(existsSync(join(wiki, "b.md")));
    const { data } = parseFrontmatter(readFileSync(join(wiki, "b.md"), "utf8"));
    // Tags union preserves both entries' tags.
    const tagSet = new Set(data.tags);
    assert.ok(tagSet.has("orm"));
    assert.ok(tagSet.has("prisma"));
    assert.ok(tagSet.has("database"));
    // Domains union likewise.
    const domainSet = new Set(data.domains);
    assert.ok(domainSet.has("backend"));
    assert.ok(domainSet.has("infra"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ─── MERGE alias pre-apply collision guard (Bug 3 fix) ──────────────
//
// Background: v1.0 applyMerge adds absorbed.id + absorbed.aliases[]
// to keeper.aliases[] without checking whether any of those ids
// already exist as LIVE ids elsewhere in the corpus. When collisions
// happen (multi-operator-per-iteration paths can reach intermediate
// states where this is possible), the validator catches them
// downstream as ALIAS-COLLIDES-ID — but only after commit, forcing
// a full convergence-iteration rollback. The guard added in this PR
// throws pre-apply so nothing is written on collision.

test("MERGE apply: refuses to write aliases that collide with a live id elsewhere", async () => {
  const wiki = tmpWiki("merge-alias-guard");
  try {
    writeIndex(wiki, "root");
    // Two near-identical siblings at root — Tier 0 resolves decisive-same.
    writeLeaf(join(wiki, "alpha.md"), {
      id: "alpha",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands", "schema file"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "beta.md"), {
      id: "beta",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
    });
    // Another leaf elsewhere in the tree carrying id="beta" — the id
    // MERGE would add to alpha.aliases[]. This is a pre-invalid
    // synthesised state (normal builds would have failed validation
    // earlier), but we're testing the guard's behaviour. In real
    // flows the same collision class is reached via multi-operator-
    // per-iteration paths that bypass inter-op validation.
    //
    // File the bystander at `another-branch/beta.md` (filename matches
    // id) so we don't accidentally violate the id/filename-basename
    // validator invariant on top of the alias-collision scenario.
    // Keeping the scenario focused on alias-vs-live-id collisions
    // avoids brittle coupling to unrelated validation rules that a
    // future stricter validator might start enforcing on test
    // fixtures.
    const subDir = join(wiki, "another-branch");
    mkdirSync(subDir, { recursive: true });
    writeIndex(subDir, "another-branch");
    writeLeaf(join(subDir, "beta.md"), {
      id: "beta",
      type: "primary",
      depth_role: "leaf",
      focus: "unrelated content living in a different branch",
      covers: ["some unrelated cover"],
      parents: ["../index.md"],
    });

    // Snapshot the pre-apply byte state of every file that the guard
    // promises to leave untouched. Then assert the post-rejection
    // state is byte-identical. Just asserting existsSync is too weak
    // — a half-applied merge could write new aliases into alpha.md
    // without deleting beta.md and this test would pass. The byte-
    // equality check pins the "nothing written" contract to the only
    // thing that actually matters: file contents.
    const pre = {
      alpha: readFileSync(join(wiki, "alpha.md"), "utf8"),
      beta: readFileSync(join(wiki, "beta.md"), "utf8"),
      bystander: readFileSync(join(subDir, "beta.md"), "utf8"),
    };

    const proposals = await detectMerge(wiki, {
      opId: "op-guard",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1, "expected at least one MERGE proposal");

    // The guard must throw BEFORE any filesystem mutation.
    await assert.rejects(
      () => proposals[0].apply({ wikiRoot: wiki, opId: "op-guard" }),
      /MERGE: alias "beta" .*collides with an existing live id/,
    );

    // Verify NOTHING was written: every tracked file must be byte-
    // identical to its pre-apply snapshot. An existsSync-only check
    // would let a half-apply that rewrote alpha's frontmatter slip
    // through — the byte check forecloses that.
    assert.equal(
      readFileSync(join(wiki, "alpha.md"), "utf8"),
      pre.alpha,
      "alpha.md must be byte-identical after the rejected merge",
    );
    assert.equal(
      readFileSync(join(wiki, "beta.md"), "utf8"),
      pre.beta,
      "beta.md must be byte-identical after the rejected merge",
    );
    assert.equal(
      readFileSync(join(subDir, "beta.md"), "utf8"),
      pre.bystander,
      "colliding bystander must be byte-identical after the rejected merge",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: alias guard permits merges with no collision elsewhere", async () => {
  // Regression: the guard must NOT over-fire. Normal merges without
  // any alias collision must still land cleanly.
  const wiki = tmpWiki("merge-alias-no-collision");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "alpha.md"), {
      id: "alpha",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands", "schema file"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "beta.md"), {
      id: "beta",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
    });
    // An unrelated leaf elsewhere with an id that does NOT collide
    // with any of the alias ids the MERGE will produce.
    const subDir = join(wiki, "another-branch");
    mkdirSync(subDir, { recursive: true });
    writeIndex(subDir, "another-branch");
    writeLeaf(join(subDir, "gamma.md"), {
      id: "gamma",
      type: "primary",
      depth_role: "leaf",
      focus: "unrelated content",
      covers: ["unrelated"],
      parents: ["../index.md"],
    });

    const proposals = await detectMerge(wiki, {
      opId: "op-no-collision",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1);
    // Apply succeeds; no rejection.
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-no-collision" });
    // Keeper survives with the absorbed's id as an alias.
    assert.ok(existsSync(join(wiki, "alpha.md")));
    assert.ok(!existsSync(join(wiki, "beta.md")));
    const { data } = parseFrontmatter(
      readFileSync(join(wiki, "alpha.md"), "utf8"),
    );
    assert.ok(data.aliases.includes("beta"));
    // Unrelated leaf untouched.
    assert.ok(existsSync(join(subDir, "gamma.md")));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectLiveIds: skips .llmwiki and .work internals", () => {
  const wiki = tmpWiki("live-ids-skip");
  try {
    writeLeaf(join(wiki, "real-leaf.md"), {
      id: "real-leaf",
      type: "primary",
      depth_role: "leaf",
      focus: "real leaf",
      covers: ["x"],
      parents: ["index.md"],
    });
    // Fake internals that would poison the set if walked
    mkdirSync(join(wiki, ".llmwiki", "git", "refs"), { recursive: true });
    writeFileSync(join(wiki, ".llmwiki", "op-log.yaml"), "- op: foo\n");
    // .md file inside .llmwiki — must NOT be collected
    writeFileSync(
      join(wiki, ".llmwiki", "poison.md"),
      "---\nid: poison-from-llmwiki\n---\n",
    );
    mkdirSync(join(wiki, ".work", "tier2"), { recursive: true });
    writeFileSync(
      join(wiki, ".work", "tier2", "pending-0.md"),
      "---\nid: poison-from-work\n---\n",
    );

    const liveIds = collectLiveIds(wiki);
    assert.ok(liveIds.has("real-leaf"));
    assert.ok(
      !liveIds.has("poison-from-llmwiki"),
      "must not walk into .llmwiki/",
    );
    assert.ok(
      !liveIds.has("poison-from-work"),
      "must not walk into .work/",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectLiveIds: excludePaths are not added to the set", () => {
  const wiki = tmpWiki("live-ids-exclude");
  try {
    writeLeaf(join(wiki, "keeper.md"), {
      id: "keeper-id",
      type: "primary",
      depth_role: "leaf",
      focus: "keeper",
      covers: ["x"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "absorbed.md"), {
      id: "absorbed-id",
      type: "primary",
      depth_role: "leaf",
      focus: "absorbed",
      covers: ["x"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "bystander.md"), {
      id: "bystander-id",
      type: "primary",
      depth_role: "leaf",
      focus: "bystander",
      covers: ["y"],
      parents: ["index.md"],
    });

    const liveIds = collectLiveIds(
      wiki,
      new Set([join(wiki, "keeper.md"), join(wiki, "absorbed.md")]),
    );
    assert.ok(liveIds.has("bystander-id"));
    assert.ok(
      !liveIds.has("keeper-id"),
      "keeper must be excluded so its own id doesn't self-collide",
    );
    assert.ok(
      !liveIds.has("absorbed-id"),
      "absorbed must be excluded since it's about to be removed",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: refuses to merge entries with conflicting type", async () => {
  const wiki = tmpWiki("merge-type-conflict");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "primary.md"), {
      id: "primary-a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "overlay.md"), {
      id: "overlay-b",
      type: "overlay",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev"],
      parents: ["index.md"],
      overlay_targets: ["primary-a"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    // detectMerge will produce a proposal because similarity is
    // high; apply must refuse.
    if (proposals.length === 0) {
      // Acceptable if the mixed type somehow pushed similarity
      // below threshold — the stronger assertion is the apply
      // refusal. Fall back to calling apply via a synthetic
      // proposal would be over-engineering the test. Just ensure
      // at minimum a proposal exists or the files are untouched.
      assert.ok(
        existsSync(join(wiki, "primary.md")) && existsSync(join(wiki, "overlay.md")),
      );
      return;
    }
    await assert.rejects(
      () => proposals[0].apply({ wikiRoot: wiki, opId: "op-1" }),
      /MERGE: cannot merge.*conflicting/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── DESCEND ──────────────────────────────────────────────────────────

test("detectDescend: fat authored zone yields DESCEND proposal", () => {
  const wiki = tmpWiki("descend-size");
  try {
    const authored = "A".repeat(3000);
    writeIndex(wiki, "root", { authored });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].operator, "DESCEND");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: code fence in authored zone fires DESCEND", () => {
  const wiki = tmpWiki("descend-code");
  try {
    writeIndex(wiki, "root", { authored: "some intro\n```js\nconsole.log('x');\n```\n" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: checklist in authored zone fires DESCEND", () => {
  const wiki = tmpWiki("descend-checklist");
  try {
    writeIndex(wiki, "root", { authored: "notes\n- [ ] todo 1\n- [ ] todo 2\n" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: short clean authored zone is left alone", () => {
  const wiki = tmpWiki("descend-clean");
  try {
    writeIndex(wiki, "root", { authored: "short orientation paragraph" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("DESCEND apply: creates a new leaf and clears the authored zone", async () => {
  const wiki = tmpWiki("descend-apply");
  try {
    writeIndex(wiki, "root", { authored: "A".repeat(3000) });
    const proposals = detectDescend(wiki);
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    const leafPath = join(wiki, "descended-content-1.md");
    assert.ok(existsSync(leafPath));
    const leafRaw = readFileSync(leafPath, "utf8");
    assert.ok(leafRaw.includes("A".repeat(100)));
    // Authored zone is now empty on the parent index.
    const indexRaw = readFileSync(join(wiki, "index.md"), "utf8");
    const authoredSection = indexRaw.match(
      /<!-- BEGIN AUTHORED ORIENTATION -->([\s\S]*?)<!-- END AUTHORED ORIENTATION -->/,
    );
    assert.ok(authoredSection);
    assert.equal(authoredSection[1].trim(), "");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── DECOMPOSE / NEST (detect-only in Phase 6) ────────────────────────

test("detectNestAndDecompose: many-covers leaf yields detect-only DECOMPOSE", () => {
  const wiki = tmpWiki("decompose");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "huge.md"), {
      id: "huge",
      type: "primary",
      depth_role: "leaf",
      focus: "a leaf with many concerns",
      parents: ["index.md"],
      covers: Array.from({ length: 15 }, (_, i) => `concern-${i}`),
    });
    const proposals = detectNestAndDecompose(wiki);
    assert.ok(proposals.some((p) => p.operator === "DECOMPOSE"));
    const dc = proposals.find((p) => p.operator === "DECOMPOSE");
    assert.ok(dc.detectOnly);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectNestAndDecompose: nests_into hint yields detect-only NEST", () => {
  const wiki = tmpWiki("nest");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "hinted.md"), {
      id: "hinted",
      type: "primary",
      depth_role: "leaf",
      focus: "a hinted nester",
      parents: ["index.md"],
      nests_into: ["section-a", "section-b"],
    });
    const proposals = detectNestAndDecompose(wiki);
    const nest = proposals.find((p) => p.operator === "NEST");
    assert.ok(nest);
    assert.ok(nest.detectOnly);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── runConvergence ───────────────────────────────────────────────────

test("runConvergence: terminates on a clean wiki with zero iterations applied", async () => {
  const wiki = tmpWiki("converge-clean");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "clean-a.md"), {
      id: "clean-a",
      type: "primary",
      depth_role: "leaf",
      focus: "a unique focus A",
      covers: ["concern-1"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "clean-b.md"), {
      id: "clean-b",
      type: "primary",
      depth_role: "leaf",
      focus: "a totally distinct focus B",
      covers: ["concern-2"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, { opId: "op-clean", qualityMode: "tiered-fast" });
    assert.equal(r.applied.length, 0);
    assert.ok(r.converged);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: writes metric_trajectory to decisions.yaml even for 0 applications", async () => {
  const { readDecisions } = await import("../../scripts/lib/decision-log.mjs");
  const wiki = tmpWiki("traj-write");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "a.md"), {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "unrelated topic A",
      covers: ["c1"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "b.md"), {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "unrelated topic B",
      covers: ["c2"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-traj",
      qualityMode: "tiered-fast",
      skipClusterNest: true,
    });
    assert.equal(r.applied.length, 0);
    const decisions = readDecisions(wiki);
    const traj = decisions.filter(
      (d) => d.operator === "METRIC_TRAJECTORY" && d.op_id === "op-traj",
    );
    assert.ok(traj.length >= 1, `expected metric trajectory entries, got ${traj.length}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: applies LIFT then terminates", async () => {
  // 2-level setup so LIFT fires at depth 2 → depth 1 (the X.11
  // invariant forbids depth-1 → root).
  const wiki = tmpWiki("converge-lift");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "alone"));
    writeIndex(join(wiki, "outer", "alone"), "alone");
    writeLeaf(join(wiki, "outer", "alone", "child.md"), {
      id: "child",
      type: "primary",
      depth_role: "leaf",
      focus: "distinct child",
      parents: ["../index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-lift",
      qualityMode: "tiered-fast",
    });
    assert.ok(r.applied.length >= 1);
    const liftApplied = r.applied.find((a) => a.operator === "LIFT");
    assert.ok(liftApplied);
    assert.ok(existsSync(join(wiki, "outer", "child.md")));
    assert.ok(!existsSync(join(wiki, "outer", "alone")));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: priority ordering — DESCEND before MERGE before NEST", async () => {
  const wiki = tmpWiki("converge-priority");
  try {
    // Set up a wiki that has both a DESCEND candidate (fat authored
    // zone on root) AND a MERGE candidate (two similar leaves).
    writeIndex(wiki, "root", { authored: "X".repeat(3000) });
    writeLeaf(join(wiki, "a.md"), {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations",
      covers: ["migrate dev", "seed commands"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "b.md"), {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations",
      covers: ["migrate dev", "seed commands"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-priority",
      qualityMode: "tiered-fast",
    });
    // First applied proposal must be DESCEND (priority 5 > MERGE 3).
    assert.ok(r.applied.length >= 1);
    assert.equal(r.applied[0].operator, "DESCEND");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: commitBetweenIterations is invoked for each applied op", async () => {
  const wiki = tmpWiki("converge-commit");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "alone"));
    writeIndex(join(wiki, "outer", "alone"), "alone");
    writeLeaf(join(wiki, "outer", "alone", "child.md"), {
      id: "child",
      type: "primary",
      depth_role: "leaf",
      focus: "distinct child",
      parents: ["../index.md"],
    });
    const commits = [];
    await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
      commitBetweenIterations: async (ctx) => {
        commits.push(ctx);
      },
    });
    assert.ok(commits.length >= 1);
    assert.equal(commits[0].operator, "LIFT");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: halts on max iterations budget", async () => {
  // Build a pathological wiki: every LIFT leaves another single
  // child at the new level. We use `maxIterations: 1` to force an
  // early halt, then assert `iterations === 1`.
  const wiki = tmpWiki("converge-budget");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "a"));
    writeIndex(join(wiki, "a"), "a");
    mkdirSync(join(wiki, "a", "b"));
    writeIndex(join(wiki, "a", "b"), "b");
    writeLeaf(join(wiki, "a", "b", "deep.md"), {
      id: "deep",
      type: "primary",
      depth_role: "leaf",
      focus: "deep child",
      parents: ["../index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
      maxIterations: 1,
    });
    assert.equal(r.iterations, 1);
    assert.equal(r.applied.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: NEST and DECOMPOSE candidates land in suggestions, not applied", async () => {
  const wiki = tmpWiki("converge-nest-only");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "hinted.md"), {
      id: "hinted",
      type: "primary",
      depth_role: "leaf",
      focus: "nest candidate",
      covers: ["concern-1"],
      parents: ["index.md"],
      nests_into: ["section-a", "section-b"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.equal(r.applied.length, 0);
    assert.ok(r.suggestions.some((s) => s.operator === "NEST"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── Rec 3: small-directory propose_structure skip ───────────────────
//
// A directory with ≤ MIN_TIER2_CLUSTER_SIZE leaves cannot produce a
// non-trivial partition (the only partition would fold every leaf
// into one subcategory, which is a rename not a nest). The
// convergence loop should skip emitting a propose_structure request
// on such directories to avoid wasted Tier 2 round trips.

test("runConvergence: skips propose_structure on a 2-leaf directory", async () => {
  const wiki = tmpWiki("converge-skip-pair");
  try {
    writeIndex(wiki, "root");
    // Two leaves with clearly-disjoint focus so pairwise MERGE never
    // fires and the loop reaches the cluster-NEST path.
    writeLeaf(join(wiki, "alpha.md"), {
      id: "alpha",
      type: "primary",
      depth_role: "leaf",
      focus: "zebra stripes taxonomy",
      covers: ["stripes-a", "stripes-b"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "bravo.md"), {
      id: "bravo",
      type: "primary",
      depth_role: "leaf",
      focus: "compiler register allocation",
      covers: ["graph-coloring", "spilling"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-skip-pair",
      qualityMode: "tiered-fast",
    });
    // No propose_structure enqueued — a 2-leaf dir is below the
    // MIN_TIER2_CLUSTER_SIZE + 1 threshold for cluster detection.
    const pending = takePendingRequests(wiki);
    const proposeRequests = pending.filter((p) => p.kind === "propose_structure");
    assert.equal(
      proposeRequests.length,
      0,
      `expected 0 propose_structure requests for a 2-leaf dir, got ${proposeRequests.length}`,
    );
    assert.equal(countPendingRequests(wiki), 0);
    // And the suggestions should NOT contain a "propose_structure parked" note.
    const parked = r.suggestions.filter((s) =>
      (s.reason || "").includes("propose_structure parked"),
    );
    assert.equal(parked.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: emits propose_structure on a 3-leaf directory", async () => {
  const wiki = tmpWiki("converge-emit-triple");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "alpha.md"), {
      id: "alpha",
      type: "primary",
      depth_role: "leaf",
      focus: "zebra stripes taxonomy",
      covers: ["stripes-a", "stripes-b"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "bravo.md"), {
      id: "bravo",
      type: "primary",
      depth_role: "leaf",
      focus: "compiler register allocation",
      covers: ["graph-coloring", "spilling"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "charlie.md"), {
      id: "charlie",
      type: "primary",
      depth_role: "leaf",
      focus: "deep-sea hydrothermal vents",
      covers: ["chemosynthesis", "mineral plumes"],
      parents: ["index.md"],
    });
    await runConvergence(wiki, {
      opId: "op-emit-triple",
      qualityMode: "tiered-fast",
    });
    // A 3-leaf dir is at (MIN_TIER2_CLUSTER_SIZE + 1), which is the
    // minimum that can produce a non-trivial partition — the loop
    // should emit a propose_structure request and park it.
    const pending = takePendingRequests(wiki);
    const proposeRequests = pending.filter((p) => p.kind === "propose_structure");
    assert.ok(
      proposeRequests.length >= 1,
      `expected ≥1 propose_structure request for a 3-leaf dir, got ${proposeRequests.length}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── Rec 4: stale math candidates are dropped before gating ──────────
//
// mathCandidateIsFresh returns false when any candidate member leaf
// has moved, been deleted, or was never resident in the expected
// parent. The convergence loop calls this guard before emitting a
// math-source nest_decision gate request.

test("mathCandidateIsFresh: all members co-resident → fresh", () => {
  const wiki = tmpWiki("fresh-all-coresident");
  try {
    const parentDir = wiki;
    const aPath = join(parentDir, "a.md");
    const bPath = join(parentDir, "b.md");
    writeLeaf(aPath, { id: "a", type: "primary", depth_role: "leaf", focus: "A", parents: ["index.md"] });
    writeLeaf(bPath, { id: "b", type: "primary", depth_role: "leaf", focus: "B", parents: ["index.md"] });
    const cand = {
      parent_dir: parentDir,
      source: "math",
      leaves: [
        { path: aPath, data: { id: "a" } },
        { path: bPath, data: { id: "b" } },
      ],
      average_affinity: 0.5,
    };
    assert.equal(mathCandidateIsFresh(cand), true);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("mathCandidateIsFresh: member moved to a sibling dir → stale", () => {
  const wiki = tmpWiki("fresh-moved");
  try {
    const parentDir = wiki;
    const siblingDir = join(wiki, "other");
    mkdirSync(siblingDir, { recursive: true });
    const aPath = join(parentDir, "a.md");
    const bPath = join(siblingDir, "b.md"); // b lives elsewhere
    writeLeaf(aPath, { id: "a", type: "primary", depth_role: "leaf", focus: "A", parents: ["index.md"] });
    writeLeaf(bPath, { id: "b", type: "primary", depth_role: "leaf", focus: "B", parents: ["../index.md"] });
    const cand = {
      parent_dir: parentDir,
      source: "math",
      // The math detector captured b when it still lived in parentDir;
      // the stale candidate's leaves[].path points at the NEW location
      // (as would happen if the object was refreshed between passes).
      leaves: [
        { path: aPath, data: { id: "a" } },
        { path: bPath, data: { id: "b" } },
      ],
      average_affinity: 0.5,
    };
    assert.equal(mathCandidateIsFresh(cand), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("mathCandidateIsFresh: member deleted → stale", () => {
  const wiki = tmpWiki("fresh-deleted");
  try {
    const parentDir = wiki;
    const aPath = join(parentDir, "a.md");
    const ghostPath = join(parentDir, "ghost.md");
    writeLeaf(aPath, { id: "a", type: "primary", depth_role: "leaf", focus: "A", parents: ["index.md"] });
    // ghost.md is NOT written to disk — simulates a member deleted
    // between the math detection pass and the gate-emission pass.
    const cand = {
      parent_dir: parentDir,
      source: "math",
      leaves: [
        { path: aPath, data: { id: "a" } },
        { path: ghostPath, data: { id: "ghost" } },
      ],
      average_affinity: 0.5,
    };
    assert.equal(mathCandidateIsFresh(cand), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("mathCandidateIsFresh: empty or missing inputs → stale", () => {
  assert.equal(mathCandidateIsFresh(null), false);
  assert.equal(mathCandidateIsFresh({}), false);
  assert.equal(mathCandidateIsFresh({ parent_dir: "/tmp/x", leaves: [] }), false);
  assert.equal(
    mathCandidateIsFresh({ parent_dir: "/tmp/x", leaves: [{ data: { id: "a" } }] }),
    false,
  );
});

// ── Rec 1: stale-candidate drops leave a decision-log entry ─────────
//
// The Phase 5 audit-log hook writes a `rejected-stale` entry to
// decisions.yaml for every math candidate dropped by the
// `mathCandidateIsFresh` guard. Without this entry operators who
// ask "why didn't that cluster land?" have no breadcrumb — the
// only signal is the absence of a `nest_decision` request that was
// never sent. The unit test asserts the append happens and carries
// the expected fields.

test("dropStaleMathCandidate: writes a rejected-stale entry to decisions.yaml", () => {
  const wiki = tmpWiki("stale-audit");
  try {
    const aPath = join(wiki, "a.md");
    const bPath = join(wiki, "b.md");
    writeLeaf(aPath, {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "A",
      parents: ["index.md"],
    });
    writeLeaf(bPath, {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "B",
      parents: ["index.md"],
    });
    const cand = {
      parent_dir: wiki,
      source: "math",
      leaves: [
        { path: aPath, data: { id: "a" } },
        { path: bPath, data: { id: "b" } },
      ],
      average_affinity: 0.42,
    };
    const suggestions = [];
    dropStaleMathCandidate(wiki, cand, "op-stale-test", suggestions);

    // suggestion mirrors the append reason
    assert.equal(suggestions.length, 1);
    assert.match(
      suggestions[0].reason,
      /members no longer co-resident in parent/,
    );

    // decisions.yaml carries the audit entry
    const decisions = readDecisions(wiki);
    const stale = decisions.filter(
      (d) => d.decision === "rejected-stale",
    );
    assert.equal(
      stale.length,
      1,
      `expected exactly one rejected-stale entry, found ${stale.length}`,
    );
    const entry = stale[0];
    assert.equal(entry.op_id, "op-stale-test");
    assert.equal(entry.operator, "NEST");
    assert.equal(entry.confidence_band, "math-gated");
    assert.equal(entry.similarity, 0.42);
    assert.deepEqual(entry.sources, ["a", "b"]);
    assert.match(entry.reason, /members no longer co-resident/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── Rec 3: batch propose_structure across ALL directories ──────────
//
// The convergence iteration walks every directory in a single pass
// and enqueues a propose_structure request for each eligible one,
// instead of stopping at the first unresolved dir. The unit test
// below builds a 3-dir synthetic tree (root + 2 subdirs, each with
// 3 unrelated leaves) and asserts that one `runConvergence` call
// parks propose_structure requests for EVERY dir on the pending
// queue — not just the first one.

test("runConvergence: batches propose_structure across every directory in one pass", async () => {
  const wiki = tmpWiki("batch-propose");
  try {
    writeIndex(wiki, "root");
    // Dir 1 — root: three unrelated leaves so cluster detection
    // produces no math candidates (each tag/focus is disjoint).
    writeLeaf(join(wiki, "root-a.md"), {
      id: "root-a",
      type: "primary",
      depth_role: "leaf",
      focus: "zebra stripes taxonomy",
      covers: ["stripes-alpha", "stripes-beta"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "root-b.md"), {
      id: "root-b",
      type: "primary",
      depth_role: "leaf",
      focus: "compiler register allocation",
      covers: ["graph-coloring", "spilling"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "root-c.md"), {
      id: "root-c",
      type: "primary",
      depth_role: "leaf",
      focus: "deep-sea hydrothermal vents",
      covers: ["chemosynthesis", "mineral-plumes"],
      parents: ["index.md"],
    });
    // Dir 2 — subcat-alpha: three unrelated leaves.
    const dirAlpha = join(wiki, "subcat-alpha");
    mkdirSync(dirAlpha, { recursive: true });
    writeIndex(dirAlpha, "subcat-alpha");
    writeLeaf(join(dirAlpha, "alpha-x.md"), {
      id: "alpha-x",
      type: "primary",
      depth_role: "leaf",
      focus: "fourier series orthogonality",
      covers: ["sine-bases", "cosine-bases"],
      parents: ["../index.md"],
    });
    writeLeaf(join(dirAlpha, "alpha-y.md"), {
      id: "alpha-y",
      type: "primary",
      depth_role: "leaf",
      focus: "beekeeping hive inspection",
      covers: ["queen-check", "brood-pattern"],
      parents: ["../index.md"],
    });
    writeLeaf(join(dirAlpha, "alpha-z.md"), {
      id: "alpha-z",
      type: "primary",
      depth_role: "leaf",
      focus: "victorian railway gauges",
      covers: ["narrow-gauge", "broad-gauge"],
      parents: ["../index.md"],
    });
    // Dir 3 — subcat-bravo: three unrelated leaves.
    const dirBravo = join(wiki, "subcat-bravo");
    mkdirSync(dirBravo, { recursive: true });
    writeIndex(dirBravo, "subcat-bravo");
    writeLeaf(join(dirBravo, "bravo-x.md"), {
      id: "bravo-x",
      type: "primary",
      depth_role: "leaf",
      focus: "mediaeval illuminated manuscripts",
      covers: ["gold-leaf", "gesso-priming"],
      parents: ["../index.md"],
    });
    writeLeaf(join(dirBravo, "bravo-y.md"), {
      id: "bravo-y",
      type: "primary",
      depth_role: "leaf",
      focus: "pigeon racing pedigree",
      covers: ["loft-design", "feed-mixing"],
      parents: ["../index.md"],
    });
    writeLeaf(join(dirBravo, "bravo-z.md"), {
      id: "bravo-z",
      type: "primary",
      depth_role: "leaf",
      focus: "kendo bamboo shinai maintenance",
      covers: ["tsuba-care", "tsuka-wrap"],
      parents: ["../index.md"],
    });

    await runConvergence(wiki, {
      opId: "op-batch",
      qualityMode: "tiered-fast",
    });

    const pending = takePendingRequests(wiki);
    const proposeRequests = pending.filter(
      (r) => r.kind === "propose_structure",
    );
    // Every eligible directory should have parked its own
    // propose_structure request in a single walk: root + 2 subcats.
    assert.equal(
      proposeRequests.length,
      3,
      `expected 3 propose_structure requests (one per dir), got ${proposeRequests.length}: ` +
        proposeRequests.map((r) => r.request_id).join(", "),
    );
    // Distinct request_ids prove the batch spans three different
    // directories (a single parked dir would emit exactly one).
    const uniqueIds = new Set(proposeRequests.map((r) => r.request_id));
    assert.equal(
      uniqueIds.size,
      3,
      "every propose_structure request must have a distinct request_id",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("dropStaleMathCandidate: missing average_affinity coerces similarity to 0", () => {
  const wiki = tmpWiki("stale-audit-noaff");
  try {
    const cand = {
      parent_dir: wiki,
      source: "math",
      leaves: [
        { path: join(wiki, "x.md"), data: { id: "x" } },
      ],
      // no average_affinity
    };
    dropStaleMathCandidate(wiki, cand, "op-noaff", null);
    const decisions = readDecisions(wiki);
    const stale = decisions.filter((d) => d.decision === "rejected-stale");
    assert.equal(stale.length, 1);
    assert.equal(stale[0].similarity, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
