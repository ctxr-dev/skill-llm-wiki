// interactive-review.test.mjs — exercises `runReviewCycle` end to
// end against a real wiki with real per-iteration commits.
//
// We set up a LIFT-eligible structure on top of an already-built
// wiki, run a second operator-convergence pass directly (via
// `runConvergence`), and then drive `runReviewCycle` with a
// scripted `promptFn` that returns approve / abort / drop
// decisions without touching stdin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  REVIEW_ABORT,
  REVIEW_APPROVE,
  runReviewCycle,
} from "../../scripts/commands/review.mjs";
import { preOpSnapshot } from "../../scripts/lib/snapshot.mjs";
import { runConvergence } from "../../scripts/lib/operators.mjs";
import {
  gitCommit,
  gitHeadSha,
  gitRefExists,
  gitRevParse,
  gitRunChecked,
  gitWorkingTreeClean,
} from "../../scripts/lib/git.mjs";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

process.env.LLM_WIKI_MOCK_TIER1 = "1";

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
    `skill-llm-wiki-review-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Build a wiki, then manually insert a single-leaf subfolder that
// LIFT will fire on during a subsequent rebuild. Returns { wiki,
// opId } for the NEW rebuild op (not the initial build).
function setupLiftScenario(tag) {
  const parent = tmpParent(tag);
  const src = join(parent, "corpus");
  mkdirSync(src);
  writeFileSync(join(src, "alpha.md"), "# Alpha\n\nunique alpha phrase xyzzy\n");
  writeFileSync(join(src, "beta.md"), "# Beta\n\nunique beta phrase foobar\n");
  const build = runCli(["build", src]);
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr}`);
  const wiki = join(parent, "corpus.wiki");

  // Set up a LIFT scenario: move alpha.md into its own subfolder.
  // Flat sources now land at the wiki root (no `general/` bucket),
  // so the fresh leaf is at `<wiki>/alpha.md`.
  mkdirSync(join(wiki, "alpha-solo"));
  const alphaSrc = join(wiki, "alpha.md");
  const alphaDst = join(wiki, "alpha-solo", "alpha.md");
  writeFileSync(alphaDst, readFileSync(alphaSrc, "utf8"));
  rmSync(alphaSrc);
  writeFileSync(
    join(wiki, "alpha-solo", "index.md"),
    "---\nid: alpha-solo\ntype: index\ndepth_role: subcategory\nfocus: solo\ngenerator: skill-llm-wiki/v1\nparents:\n  - ../index.md\n---\n\n",
  );

  // Take a fresh pre-op snapshot so `pre-op/<new-opId>` exists.
  const opId = `review-test-${tag}-${Date.now()}`;
  preOpSnapshot(wiki, opId);
  return { parent, wiki, opId };
}

async function runLift(wiki, opId) {
  await runConvergence(wiki, {
    opId,
    qualityMode: "tiered-fast",
    commitBetweenIterations: async ({ iteration, operator, summary }) => {
      gitRunChecked(wiki, ["add", "-A"]);
      if (!gitWorkingTreeClean(wiki)) {
        gitCommit(
          wiki,
          `phase operator-convergence: iteration ${iteration} ${operator} — ${summary}`,
        );
      }
    },
  });
}

test("runReviewCycle approve: leaves the working tree as-is", async () => {
  const { parent, wiki, opId } = setupLiftScenario("approve");
  try {
    await runLift(wiki, opId);
    // After the LIFT, alpha.md should be at wiki root.
    assert.ok(existsSync(join(wiki, "alpha.md")));
    const headBefore = gitHeadSha(wiki);
    const result = await runReviewCycle(wiki, opId, {
      forceInteractive: true,
      promptFn: async () => REVIEW_APPROVE,
    });
    assert.equal(result.outcome, "approve");
    assert.equal(gitHeadSha(wiki), headBefore);
    // File still at root.
    assert.ok(existsSync(join(wiki, "alpha.md")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runReviewCycle abort: resets working tree to pre-op", async () => {
  const { parent, wiki, opId } = setupLiftScenario("abort");
  try {
    await runLift(wiki, opId);
    // Scenario applied → alpha.md at root.
    assert.ok(existsSync(join(wiki, "alpha.md")));
    const result = await runReviewCycle(wiki, opId, {
      forceInteractive: true,
      promptFn: async () => REVIEW_ABORT,
    });
    assert.equal(result.outcome, "abort");
    // Working tree restored: alpha.md back in alpha-solo/, the
    // folder exists again, and the leaf no longer lives at root.
    assert.ok(!existsSync(join(wiki, "alpha.md")));
    assert.ok(existsSync(join(wiki, "alpha-solo", "alpha.md")));
    // HEAD points at the pre-op tag.
    const headSha = gitHeadSha(wiki);
    const preSha = gitRevParse(wiki, `pre-op/${opId}`);
    assert.equal(headSha, preSha);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runReviewCycle drop: reverts a specific iteration commit", async () => {
  const { parent, wiki, opId } = setupLiftScenario("drop");
  try {
    await runLift(wiki, opId);
    assert.ok(existsSync(join(wiki, "alpha.md")));
    // Pick the most-recent operator-convergence commit and drop it,
    // then approve on the next prompt. (The review loop re-prompts
    // after each drop so the user can drop multiple iterations.)
    let calls = 0;
    const result = await runReviewCycle(wiki, opId, {
      forceInteractive: true,
      promptFn: async (commits) => {
        calls++;
        if (calls === 1) return `drop:${commits[0].sha}`;
        return REVIEW_APPROVE;
      },
    });
    assert.equal(result.outcome, "approve");
    assert.ok(Array.isArray(result.dropped));
    assert.equal(result.dropped.length, 1);
    // The revert commit lives on top of HEAD; the tree state is
    // whatever the revert produced. For LIFT, revert undoes the
    // move — alpha.md is no longer at wiki root.
    assert.ok(!existsSync(join(wiki, "alpha.md")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runReviewCycle non-interactive: outcome='non-interactive', no changes", async () => {
  const { parent, wiki, opId } = setupLiftScenario("noninteractive");
  try {
    await runLift(wiki, opId);
    // No forceInteractive AND no TTY → non-interactive mode.
    const result = await runReviewCycle(wiki, opId, {
      promptFn: async () => REVIEW_APPROVE,
    });
    assert.equal(result.outcome, "non-interactive");
    // Nothing was applied or reverted — alpha.md still at root.
    assert.ok(existsSync(join(wiki, "alpha.md")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runReviewCycle drop: post-review index regen + validation still pass", async () => {
  // Regression for the "after drop, does the rest of the pipeline
  // survive?" concern: we manually drive the full orchestrator
  // flow — operator-convergence → review (drop) → index-generation
  // → validation — and assert that validation passes end-to-end
  // on the reverted tree. If index-generation produced stale
  // links to the dropped iteration's moves, LOSS-01 / ID-MISMATCH
  // would trip here.
  const { parent, wiki, opId } = setupLiftScenario("drop-revalidate");
  try {
    await runLift(wiki, opId);
    // Drop the most-recent (LIFT) iteration.
    let calls = 0;
    const result = await runReviewCycle(wiki, opId, {
      forceInteractive: true,
      promptFn: async (commits) => {
        // First call: drop the most recent commit.
        // Second call (loop): approve.
        calls++;
        if (calls === 1) return `drop:${commits[0].sha}`;
        return REVIEW_APPROVE;
      },
    });
    assert.equal(result.outcome, "approve");
    assert.ok(Array.isArray(result.dropped));
    assert.equal(result.dropped.length, 1);

    // Regenerate indices to match the now-reverted tree — this is
    // what the orchestrator does after review in the real phase
    // pipeline.
    const { rebuildAllIndices } = await import(
      "../../scripts/lib/indices.mjs"
    );
    const { bootstrapIndexStubs } = await import(
      "../../scripts/lib/orchestrator.mjs"
    ).catch(() => ({}));
    void bootstrapIndexStubs;
    rebuildAllIndices(wiki);

    // Validate end-to-end via the CLI so we hit the same code path
    // a real rebuild would.
    const v = runCli(["validate", wiki]);
    assert.equal(
      v.status,
      0,
      `post-drop validation failed: ${v.stdout}${v.stderr}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runReviewCycle zero commits: auto-approves", async () => {
  // Scenario with no operator-convergence commits at all.
  const parent = tmpParent("zero-commits");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(join(src, "only.md"), "# Only\n\njust one entry\n");
    writeFileSync(join(src, "other.md"), "# Other\n\nanother entry\n");
    runCli(["build", src]);
    const wiki = join(parent, "corpus.wiki");
    const opId = `zero-commits-${Date.now()}`;
    preOpSnapshot(wiki, opId);
    // No convergence run → no commits between pre-op/opId and HEAD.
    const result = await runReviewCycle(wiki, opId, {
      forceInteractive: true,
      promptFn: async () => {
        throw new Error("should not prompt for zero commits");
      },
    });
    assert.equal(result.outcome, "approve");
    assert.ok(gitRefExists(wiki, `pre-op/${opId}`));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
