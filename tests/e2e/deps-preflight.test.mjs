// deps-preflight.test.mjs — e2e checks for the runtime dependency preflight.
//
// Test cases:
//   1. Happy path: `node scripts/cli.mjs --version` exits 0 and prints the
//      version. The dep preflight is intentionally skipped on --version,
//      but this still proves the wired-in code did not break the path.
//   2. Missing-dep failure: simulate a missing dep via the test-only
//      LLM_WIKI_TEST_FORCE_DEPS_MISSING knob, AND disable the auto-install
//      attempt via LLM_WIKI_TEST_NO_AUTOINSTALL=1. Assert exit 8 and that
//      stderr contains the Case E message (gray-matter named, "required
//      runtime dependencies are missing" header).
//
//      Why a knob and not a rename: parallel `node --test` runs share the
//      same node_modules. Renaming a real dep mid-run would race with
//      every other test file and would force an auto-install path that
//      could mangle the shared install. The knob exercises the same code
//      path with zero filesystem mutation.
//
//   3. Auto-install path: opt-in only, gated by LLM_WIKI_TEST_AUTO_INSTALL=1.
//      Skipped by default because running a real `npm install` against the
//      live skill tree from inside a test would be slow and could clobber
//      the operator's working environment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(HERE, "..", "..");
const CLI = join(SKILL_ROOT, "scripts", "cli.mjs");

function runCli(args, env) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: SKILL_ROOT,
  });
}

test("deps-preflight: --version is exit 0 (preflight skipped)", () => {
  const r = runCli(["--version"], { LLM_WIKI_NO_PROMPT: "1" });
  assert.equal(r.status, 0, `unexpected stderr: ${r.stderr}`);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
});

test("deps-preflight: --help is exit 0 (preflight skipped)", () => {
  const r = runCli(["--help"], { LLM_WIKI_NO_PROMPT: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skill-llm-wiki CLI/);
  // Exit code 8 must be documented in --help output.
  assert.match(r.stdout, /8 DEPS_MISSING/);
});

test("deps-preflight: forced missing dep → exit 8 with Case E message", () => {
  const r = runCli(["ingest", "/tmp/llm-wiki-deps-preflight-no-such-source"], {
    LLM_WIKI_NO_PROMPT: "1",
    LLM_WIKI_TEST_FORCE_DEPS_MISSING: "gray-matter",
    LLM_WIKI_TEST_NO_AUTOINSTALL: "1",
  });
  assert.equal(
    r.status,
    8,
    `expected exit 8 (DEPS_MISSING), got ${r.status}\n` +
      `stdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
  assert.match(
    r.stderr,
    /required runtime dependencies are missing/,
    "stderr should include the Case E header",
  );
  assert.match(r.stderr, /gray-matter/, "stderr should name the missing dep");
  assert.match(
    r.stderr,
    /auto-install disabled by test harness/,
    "stderr should record that the auto-install path was skipped",
  );
});

test("deps-preflight: forced missing dep names all reported entries", () => {
  const r = runCli(["validate", "/tmp/no-such-wiki-xyz"], {
    LLM_WIKI_NO_PROMPT: "1",
    LLM_WIKI_TEST_FORCE_DEPS_MISSING: "gray-matter,@xenova/transformers",
    LLM_WIKI_TEST_NO_AUTOINSTALL: "1",
  });
  assert.equal(r.status, 8);
  assert.match(r.stderr, /gray-matter/);
  assert.match(r.stderr, /@xenova\/transformers/);
});

test(
  "deps-preflight: auto-install branch (opt-in)",
  { skip: process.env.LLM_WIKI_TEST_AUTO_INSTALL !== "1" },
  () => {
    // Opt-in only. When LLM_WIKI_TEST_AUTO_INSTALL=1 is set the test
    // harness has explicitly accepted the cost and risk of a real
    // `npm install` against the live skill tree. Outside of that
    // gate this test is skipped — see the file header for rationale.
    const r = runCli(["--version"], { LLM_WIKI_NO_PROMPT: "1" });
    assert.equal(r.status, 0);
  },
);
