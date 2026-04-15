// interactive.mjs — TTY-gated prompt helpers.
//
// The "ask, don't guess" rule from methodology section 9.4.3 has two
// enforcement layers: intent.mjs refuses ambiguous CLI invocations; this
// module handles interactive prompts for things that genuinely need a
// runtime yes/no (migration confirmation, Tier 1 install, --review
// checkpoints in Phase 7).
//
// Non-interactive mode is the default for CI, hooks, and any pipeline
// where stdin is not a TTY. Detection prefers explicit flags over
// heuristics, in this order:
//
//   1. `LLM_WIKI_NO_PROMPT=1` (env var)            → never prompt
//   2. `--no-prompt` (CLI flag, surfaced via opts) → never prompt
//   3. `process.stdin.isTTY === false`             → never prompt
//   4. otherwise                                    → prompt
//
// When prompting is disabled, every prompt helper throws a
// `NonInteractiveError` that the caller is expected to surface as a
// structured CLI error. The caller chooses whether to exit, fall through,
// or translate into a different behaviour (Tier 1 install's silent
// fallthrough is the canonical example).

import { createInterface } from "node:readline";

export class NonInteractiveError extends Error {
  constructor(question) {
    super(
      `skill-llm-wiki: cannot prompt "${question}" in non-interactive mode`,
    );
    this.name = "NonInteractiveError";
    this.question = question;
  }
}

export function isInteractive(opts = {}) {
  if (process.env.LLM_WIKI_NO_PROMPT === "1") return false;
  if (opts.noPrompt) return false;
  if (opts.forceInteractive) return true; // tests
  // `process.stdin.isTTY` is `true` on a TTY, `undefined` on a pipe.
  // Boolean() handles both: pipes become false, TTYs become true.
  return Boolean(process.stdin && process.stdin.isTTY);
}

// Basic y/n prompt with a configurable default. Returns a boolean.
// Throws NonInteractiveError when prompts are disabled.
export async function confirm(question, opts = {}) {
  if (!isInteractive(opts)) {
    throw new NonInteractiveError(question);
  }
  const def = opts.default === undefined ? true : Boolean(opts.default);
  const suffix = def ? " [Y/n] " : " [y/N] ";
  const answer = await readLine(question + suffix);
  if (answer === "") return def;
  return /^y(es)?$/i.test(answer.trim());
}

// Free-form text prompt with an optional default value.
export async function ask(question, opts = {}) {
  if (!isInteractive(opts)) {
    throw new NonInteractiveError(question);
  }
  const suffix = opts.default ? ` [${opts.default}] ` : " ";
  const answer = await readLine(question + suffix);
  if (answer === "" && opts.default !== undefined) return opts.default;
  return answer.trim();
}

// Multiple-choice prompt. Returns the chosen option's `value`.
export async function choose(question, options, opts = {}) {
  if (!isInteractive(opts)) {
    throw new NonInteractiveError(question);
  }
  const lines = [question];
  for (let i = 0; i < options.length; i++) {
    lines.push(`  ${i + 1}. ${options[i].label}`);
  }
  lines.push(`Choose 1-${options.length}: `);
  while (true) {
    const answer = await readLine(lines.join("\n"));
    const idx = Number.parseInt(answer.trim(), 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1].value;
    }
    process.stderr.write(
      `skill-llm-wiki: please enter a number between 1 and ${options.length}\n`,
    );
  }
}

function readLine(prompt) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolvePromise(answer);
    });
  });
}
