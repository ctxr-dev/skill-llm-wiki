// review.mjs — `skill-llm-wiki rebuild <wiki> --review`
//
// After the orchestrator's operator-convergence phase produces its
// per-iteration commits but before validation + commit-finalize
// run, the review flow:
//
//   1. Reads `git diff --stat pre-op/<id>..HEAD` and prints the
//      file-level summary of what the operators touched.
//   2. Reads `git log --oneline pre-op/<id>..HEAD` and prints the
//      per-iteration commit list.
//   3. Prompts the user: approve / abort / drop <iteration-N>.
//
// Approve: orchestrator proceeds to validation + commit-finalize
//          as normal.
// Abort:   `git reset --hard pre-op/<id>` + `git clean -fd`, roll
//          everything back, exit with code 2 so the caller knows
//          the op didn't land.
// Drop N:  `git revert --no-edit <sha-of-iteration-N>` produces an
//          inverse commit for iteration N directly in git history,
//          then the loop re-prompts so the user can drop more
//          iterations one at a time. The final outcome is
//          `"approve"` with a populated `dropped[]` array; the
//          revert commits are already in history by the time the
//          orchestrator sees the result.
//
// The prompt is gated on `isInteractive()`. In non-interactive
// mode the review flow is a no-op that returns immediately, and
// the orchestrator proceeds as if `--review` hadn't been passed.

import {
  gitClean,
  gitResetHard,
  gitRun,
  gitRunChecked,
} from "../lib/git.mjs";
import { choose, isInteractive, NonInteractiveError } from "../lib/interactive.mjs";

export const REVIEW_APPROVE = "approve";
export const REVIEW_ABORT = "abort";
export const REVIEW_DROP = "drop";

// Pure logic: given the current commit list between pre-tag and HEAD,
// and the user's choice, produce an action record. Exported so tests
// can drive every branch without spawning git.
export function planReviewAction(choice, pendingCommits) {
  if (choice === REVIEW_APPROVE) {
    return { action: "approve" };
  }
  if (choice === REVIEW_ABORT) {
    return { action: "abort" };
  }
  if (typeof choice === "string" && choice.startsWith("drop:")) {
    const rest = choice.slice("drop:".length).trim();
    if (rest === "") {
      return {
        action: "error",
        error:
          "drop: commit identifier missing (use drop:<sha> or drop:<subject-substring>)",
      };
    }
    // Exact sha match always wins, even when an earlier commit's
    // subject happens to contain the sha prefix as a substring.
    const exact = pendingCommits.find((c) => c.sha === rest);
    if (exact) {
      return { action: "drop", commit: exact };
    }
    const matches = pendingCommits.filter((c) => c.subject.includes(rest));
    if (matches.length === 0) {
      return { action: "error", error: `no commit matches "${rest}"` };
    }
    if (matches.length > 1) {
      const shas = matches.map((c) => c.sha.slice(0, 10)).join(", ");
      return {
        action: "error",
        error: `ambiguous drop: "${rest}" matches ${matches.length} commits (${shas}) — use a full sha`,
      };
    }
    return { action: "drop", commit: matches[0] };
  }
  return { action: "error", error: `unknown review choice: ${choice}` };
}

// Read the commit list between `pre-op/<opId>` and HEAD as an array
// of { sha, subject } records. Used by the review prompt and tests.
export function readPendingCommits(wikiRoot, opId) {
  const r = gitRun(wikiRoot, [
    "log",
    "--oneline",
    "--no-decorate",
    "--format=%H\t%s",
    `pre-op/${opId}..HEAD`,
  ]);
  if (r.status !== 0) {
    throw new Error(
      `review: git log pre-op/${opId}..HEAD exited ${r.status}: ${r.stderr.trim()}`,
    );
  }
  const lines = r.stdout.trim().split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((l) => {
    const [sha, ...rest] = l.split("\t");
    return { sha, subject: rest.join("\t") };
  });
}

// Print the stat + commit list to stdout. Tests capture stdout to
// verify the output shape.
export function printReviewSummary(wikiRoot, opId) {
  process.stdout.write(
    `\n=== Review pending changes for op ${opId} ===\n\n`,
  );
  const diff = gitRun(wikiRoot, [
    "diff",
    "--stat",
    "--find-renames",
    `pre-op/${opId}..HEAD`,
  ]);
  process.stdout.write(diff.stdout || "(no diff)\n");
  process.stdout.write("\nCommits (oldest first):\n");
  const commits = readPendingCommits(wikiRoot, opId).reverse();
  for (let i = 0; i < commits.length; i++) {
    process.stdout.write(
      `  ${i + 1}. ${commits[i].sha.slice(0, 10)}  ${commits[i].subject}\n`,
    );
  }
  process.stdout.write("\n");
  return commits;
}

// Interactive prompt that returns one of REVIEW_APPROVE /
// REVIEW_ABORT / `drop:<n>`. Uses `choose()` from interactive.mjs
// so non-TTY mode throws NonInteractiveError that the caller
// translates into a pass-through (just approve the op).
export async function promptReviewChoice(commits, opts = {}) {
  if (!isInteractive(opts)) {
    throw new NonInteractiveError("review: non-interactive");
  }
  const options = [
    { label: "approve — proceed to validation + commit-finalize", value: REVIEW_APPROVE },
    { label: "abort    — roll back to pre-op state", value: REVIEW_ABORT },
  ];
  for (let i = 0; i < commits.length; i++) {
    options.push({
      label: `drop ${i + 1} (${commits[i].subject})`,
      value: `drop:${commits[i].sha}`,
    });
  }
  return choose("What would you like to do with this review?", options, opts);
}

// Apply an abort: reset working tree to pre-op.
export function applyAbort(wikiRoot, opId) {
  gitResetHard(wikiRoot, `pre-op/${opId}`);
  gitClean(wikiRoot);
}

// Apply a drop: `git revert --no-edit <sha>` to produce an inverse
// commit for the dropped iteration. On a clean revert, returns
// `{ ok: true }`. On conflict (common for non-adjacent commits
// that touch the same files), calls `git revert --abort` to clean
// up the working tree and returns `{ ok: false, conflict: true,
// stderr }` so the review loop can re-prompt without leaving merge
// markers on disk. Throws only for true errors — the conflict
// path is normal and recoverable.
export function applyDrop(wikiRoot, commit) {
  const r = gitRun(wikiRoot, ["revert", "--no-edit", commit.sha]);
  if (r.status === 0) {
    return { ok: true };
  }
  // Non-zero exit is typically a conflict. Abort the in-progress
  // revert so the working tree is consistent, then report.
  try {
    gitRunChecked(wikiRoot, ["revert", "--abort"]);
  } catch {
    /* best effort; caller will reset on full abort */
  }
  return { ok: false, conflict: true, stderr: r.stderr.trim() };
}

// Full review cycle: print summary, prompt, apply. Loops until the
// user approves, aborts, or hits an error — so the user can drop
// multiple iterations one at a time. Each drop produces a revert
// commit and re-prints the updated summary before re-prompting.
//
// Returns one of:
//   { outcome: "approve" }
//   { outcome: "abort" }
//   { outcome: "dropped", commits: [...] }   ← all dropped commits
//   { outcome: "non-interactive" }
//
// Tests may inject a `promptFn` seam to avoid a real TTY. For
// multi-drop scenarios the injected promptFn is called once per
// iteration of the loop and returns the next user decision.
export async function runReviewCycle(wikiRoot, opId, opts = {}) {
  const {
    promptFn = promptReviewChoice,
    forceInteractive = false,
    maxIterations = 32,
  } = opts;
  // `isInteractive` already honours `forceInteractive` — pulling
  // that check out separately is dead code.
  if (!isInteractive({ forceInteractive })) {
    return { outcome: "non-interactive" };
  }
  const dropped = [];
  for (let iter = 0; iter < maxIterations; iter++) {
    const commits = printReviewSummary(wikiRoot, opId);
    if (commits.length === 0) {
      process.stdout.write("(no pending commits to review — approving)\n");
      return { outcome: "approve" };
    }
    let choice;
    try {
      choice = await promptFn(commits, { forceInteractive });
    } catch (err) {
      if (err instanceof NonInteractiveError) {
        return { outcome: "non-interactive" };
      }
      throw err;
    }
    const plan = planReviewAction(choice, commits);
    switch (plan.action) {
      case "approve":
        return dropped.length > 0
          ? { outcome: "approve", dropped }
          : { outcome: "approve" };
      case "abort":
        applyAbort(wikiRoot, opId);
        return { outcome: "abort" };
      case "drop": {
        const dropResult = applyDrop(wikiRoot, plan.commit);
        if (dropResult.conflict) {
          // Clean abort of the in-progress revert so the working
          // tree is consistent before we re-prompt.
          process.stderr.write(
            `review: drop of ${plan.commit.sha.slice(0, 10)} conflicts with later commits ` +
              "(git revert aborted). Pick a different iteration, " +
              "approve to keep everything, or abort to roll back.\n",
          );
          continue;
        }
        dropped.push(plan.commit);
        continue;
      }
      case "error":
      default:
        process.stderr.write(`review: ${plan.error}\n`);
        continue;
    }
  }
  throw new Error(
    `review: exceeded maxIterations=${maxIterations} without reaching approve/abort`,
  );
}
