// cli-progress.test.mjs — X.9 phase-progress streaming to stderr.
//
// The orchestrator's `record(name, summary)` internally pushes
// each phase into `phases[]` and invokes `onProgress` if the
// caller supplied one. The CLI wires a progress callback that
// writes `[<op-id> <index>] <phase>: <summary>\n` to stderr.
// This file pins four contracts:
//
//   1. `runOperation({ onProgress })` fires the callback once per
//      phase, in order, with a monotonic running index. (Exercised
//      indirectly through the CLI breadcrumb shape below, which is
//      what real callers actually observe.)
//   2. The CLI's stderr breadcrumbs appear during a build.
//   3. `LLM_WIKI_NO_PROGRESS=1` suppresses the breadcrumbs (CI /
//      hermetic runs) without affecting exit code or phase output.
//   4. `--json` implicitly suppresses the breadcrumbs so stderr
//      stays reserved for structured JSON diagnostics.

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

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-progress-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      LLM_WIKI_MOCK_TIER1: "1",
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
}

function buildTinySource(parent, leaves) {
  const src = join(parent, "src");
  mkdirSync(join(src, "notes"), { recursive: true });
  for (const id of leaves) {
    writeFileSync(
      join(src, "notes", `${id}.md`),
      `# ${id}\n\ndistinctive body for ${id}\n`,
    );
  }
  return src;
}

test("cli progress: stderr carries phase breadcrumbs on a build", () => {
  const parent = tmpParent("on");
  try {
    const src = buildTinySource(parent, ["alpha", "beta"]);
    const r = runCli(["build", src]);
    assert.equal(r.status, 0, r.stderr);
    // At least one canonical phase breadcrumb must appear.
    assert.match(
      r.stderr,
      /\[build-\S+ \d+\] snapshot:/,
      `expected a snapshot-phase breadcrumb in stderr; got:\n${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[build-\S+ \d+\] validation:/,
      `expected a validation-phase breadcrumb in stderr; got:\n${r.stderr}`,
    );
    // Breadcrumbs carry a monotonically-increasing index per op.
    const indices = [...r.stderr.matchAll(/\[build-\S+ (\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    for (let i = 1; i < indices.length; i++) {
      assert.ok(
        indices[i] >= indices[i - 1],
        `phase index must not decrease; saw ${indices}`,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cli progress: LLM_WIKI_NO_PROGRESS=1 suppresses breadcrumbs", () => {
  const parent = tmpParent("off");
  try {
    const src = buildTinySource(parent, ["alpha", "beta"]);
    const r = runCli(["build", src], { env: { LLM_WIKI_NO_PROGRESS: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(
      r.stderr,
      /\[build-\S+ \d+\]/,
      `LLM_WIKI_NO_PROGRESS must suppress phase breadcrumbs; got:\n${r.stderr}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cli progress: --json suppresses breadcrumbs for the envelope contract", () => {
  const parent = tmpParent("json");
  try {
    const src = buildTinySource(parent, ["alpha", "beta"]);
    const r = runCli(["build", src, "--json"]);
    // In `--json` mode, stderr must stay free of phase
    // breadcrumbs so machine-oriented consumers and log
    // pipelines do not receive extra human-readable progress
    // lines mixed into structured handling paths. (The build
    // path still prints its human-readable completion summary to
    // stdout under --json; this test only pins the stderr
    // contract.)
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(
      r.stderr,
      /\[build-\S+ \d+\]/,
      `--json must suppress progress breadcrumbs; got:\n${r.stderr}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
