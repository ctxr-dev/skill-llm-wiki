// interactive.test.mjs — exercise the non-interactive detection logic.
// The full TTY-bound prompt flow is covered in Phase 7's interactive-
// review e2e test; here we just verify that every prompt helper throws
// a NonInteractiveError when the skill is running without a TTY.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NonInteractiveError,
  ask,
  choose,
  confirm,
  isInteractive,
} from "../../scripts/lib/interactive.mjs";

test("isInteractive returns false when LLM_WIKI_NO_PROMPT=1", () => {
  const prev = process.env.LLM_WIKI_NO_PROMPT;
  process.env.LLM_WIKI_NO_PROMPT = "1";
  try {
    assert.equal(isInteractive({ forceInteractive: true }), false);
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_NO_PROMPT;
    else process.env.LLM_WIKI_NO_PROMPT = prev;
  }
});

test("isInteractive returns false with --no-prompt flag surface", () => {
  assert.equal(isInteractive({ noPrompt: true }), false);
});

test("confirm throws NonInteractiveError in non-interactive mode", async () => {
  await assert.rejects(
    () => confirm("proceed?", { noPrompt: true }),
    NonInteractiveError,
  );
});

test("ask throws NonInteractiveError in non-interactive mode", async () => {
  await assert.rejects(
    () => ask("name?", { noPrompt: true }),
    NonInteractiveError,
  );
});

test("choose throws NonInteractiveError in non-interactive mode", async () => {
  await assert.rejects(
    () =>
      choose(
        "pick one",
        [
          { label: "a", value: 1 },
          { label: "b", value: 2 },
        ],
        { noPrompt: true },
      ),
    NonInteractiveError,
  );
});

test("NonInteractiveError exposes the question it refused", async () => {
  try {
    await confirm("migrate legacy?", { noPrompt: true });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof NonInteractiveError);
    assert.equal(err.question, "migrate legacy?");
  }
});
