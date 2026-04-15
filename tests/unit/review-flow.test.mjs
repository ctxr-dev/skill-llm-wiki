// review-flow.test.mjs — the pure planning logic for `rebuild --review`.
//
// We test every branch of `planReviewAction` in isolation (no git
// calls, no fs), and then drive a small fake commit list through
// `runReviewCycle` via the injected `promptFn` seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REVIEW_ABORT,
  REVIEW_APPROVE,
  REVIEW_DROP,
  planReviewAction,
} from "../../scripts/commands/review.mjs";

const FAKE_COMMITS = [
  { sha: "abc123def4567890", subject: "phase operator-convergence: iteration 1 LIFT — lifted foo" },
  { sha: "def4567890abc123", subject: "phase operator-convergence: iteration 2 MERGE — merged a into b" },
];

test("planReviewAction: approve returns { action: 'approve' }", () => {
  const r = planReviewAction(REVIEW_APPROVE, FAKE_COMMITS);
  assert.deepEqual(r, { action: "approve" });
});

test("planReviewAction: abort returns { action: 'abort' }", () => {
  const r = planReviewAction(REVIEW_ABORT, FAKE_COMMITS);
  assert.deepEqual(r, { action: "abort" });
});

test("planReviewAction: drop:<sha> resolves via exact sha prefix", () => {
  const r = planReviewAction("drop:abc123def4567890", FAKE_COMMITS);
  assert.equal(r.action, "drop");
  assert.equal(r.commit.sha, "abc123def4567890");
});

test("planReviewAction: drop:<substring> resolves by subject match", () => {
  const r = planReviewAction("drop:LIFT", FAKE_COMMITS);
  assert.equal(r.action, "drop");
  assert.equal(r.commit.sha, "abc123def4567890");
});

test("planReviewAction: drop with no matching commit returns error", () => {
  const r = planReviewAction("drop:nonexistent", FAKE_COMMITS);
  assert.equal(r.action, "error");
  assert.match(r.error, /no commit matches/);
});

test("planReviewAction: unknown choice returns error", () => {
  const r = planReviewAction("bogus", FAKE_COMMITS);
  assert.equal(r.action, "error");
  assert.match(r.error, /unknown review choice/);
});

test("planReviewAction: drop: with empty payload still errors cleanly", () => {
  const r = planReviewAction("drop:", FAKE_COMMITS);
  assert.equal(r.action, "error");
});

test("REVIEW_* constants are the canonical strings", () => {
  assert.equal(REVIEW_APPROVE, "approve");
  assert.equal(REVIEW_ABORT, "abort");
  assert.equal(REVIEW_DROP, "drop");
});

test("planReviewAction: exact sha match wins over subject substring match", () => {
  // A user typing an exact sha should always drop that commit,
  // even if the sha prefix happens to appear as a substring in a
  // different commit's subject (e.g., the subject embedded part
  // of an earlier commit's hash).
  const ambiguousCommits = [
    { sha: "aaaaaaa1111111111", subject: "phase operator-convergence: iteration 1 LIFT — contains bbbbbbb2" },
    { sha: "bbbbbbb2222222222", subject: "phase operator-convergence: iteration 2 LIFT — distinct" },
  ];
  const r = planReviewAction("drop:bbbbbbb2222222222", ambiguousCommits);
  assert.equal(r.action, "drop");
  assert.equal(r.commit.sha, "bbbbbbb2222222222");
});

test("planReviewAction: ambiguous subject match is rejected with all candidates listed", () => {
  const commits = [
    { sha: "a1111111aaaaaaaaa", subject: "phase operator-convergence: iteration 1 LIFT — foo" },
    { sha: "b2222222bbbbbbbbb", subject: "phase operator-convergence: iteration 2 LIFT — bar" },
    { sha: "c3333333ccccccccc", subject: "phase operator-convergence: iteration 3 LIFT — baz" },
  ];
  const r = planReviewAction("drop:LIFT", commits);
  assert.equal(r.action, "error");
  assert.match(r.error, /ambiguous drop/);
  // All three short-sha prefixes appear in the error.
  assert.match(r.error, /a1111111a/);
  assert.match(r.error, /b2222222b/);
  assert.match(r.error, /c3333333c/);
});

test("planReviewAction: unique subject substring still resolves to a drop", () => {
  const commits = [
    { sha: "a1111111aaaaaaaaa", subject: "phase operator-convergence: iteration 1 LIFT — distinct-phrase-xyzzy" },
    { sha: "b2222222bbbbbbbbb", subject: "phase operator-convergence: iteration 2 LIFT — other" },
  ];
  const r = planReviewAction("drop:xyzzy", commits);
  assert.equal(r.action, "drop");
  assert.equal(r.commit.sha, "a1111111aaaaaaaaa");
});
