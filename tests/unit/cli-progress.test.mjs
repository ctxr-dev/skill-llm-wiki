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
import { spawn, spawnSync } from "node:child_process";
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
    // Assert the exact "one callback per phase, in order" contract:
    // indices must form the consecutive sequence 1, 2, 3, … with
    // no duplicates and no gaps. That also rules out
    // skipped-phase regressions.
    assert.ok(indices.length > 0, "expected at least one phase breadcrumb");
    for (let i = 0; i < indices.length; i++) {
      assert.equal(
        indices[i],
        i + 1,
        `phase index at position ${i} must equal ${i + 1}, got ${indices[i]}; full sequence: ${indices.join(", ")}`,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("cli progress: join emits per-phase breadcrumbs in stderr (final shape)", async () => {
  // CLI-side check: a `join` invocation's stderr carries the
  // expected per-phase breadcrumb names with consecutive indices
  // from 1. This is a final-shape test — it verifies the wiring
  // from `runJoin`'s `onPhase` through the orchestrator's
  // `record()` to the CLI's `onProgress` writer reaches stderr,
  // but it intentionally does NOT try to distinguish "streamed
  // during execution" from "batched at end" via stderr timing.
  // That distinction is unreliable from a black-box CLI runner
  // (the regressed code path also wrote breadcrumbs before
  // process exit, just not interleaved with join's phases). The
  // streaming-vs-batching contract is pinned by a direct
  // in-process test on `runJoin`'s `onPhase` in
  // tests/unit/join.test.mjs.
  const parent = tmpParent("join");
  try {
    const srcA = buildTinySource(parent, ["alpha-src"]);
    const buildA = runCli(["build", srcA]);
    assert.equal(buildA.status, 0, buildA.stderr);
    const wikiA = `${srcA}.wiki`;
    const srcBRoot = join(parent, "srcB");
    mkdirSync(join(srcBRoot, "other"), { recursive: true });
    writeFileSync(
      join(srcBRoot, "other", "beta-src.md"),
      "# Beta\n\ndistinct beta content\n",
    );
    const buildB = runCli(["build", srcBRoot]);
    assert.equal(buildB.status, 0, buildB.stderr);
    const wikiB = `${srcBRoot}.wiki`;
    const target = join(parent, "joined.wiki");
    const child = spawn(
      "node",
      [
        CLI,
        "join",
        wikiA,
        wikiB,
        "--target",
        target,
        "--quality-mode",
        "deterministic",
      ],
      {
        env: {
          ...process.env,
          LLM_WIKI_NO_PROMPT: "1",
          LLM_WIKI_MOCK_TIER1: "1",
          LLM_WIKI_SKIP_CLUSTER_NEST: "1",
        },
        // Drop stdin + stdout. The CLI writes a completion summary
        // and per-phase bullet list to stdout under `join`; if we
        // piped it without draining, a long-enough run could block
        // the child on a full pipe buffer and hang the test. We
        // only need stderr (the breadcrumb stream) here.
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // Listen on `close` rather than `exit`: `exit` fires when the
    // process ends but stdio buffers may still flush afterwards;
    // `close` is the reliable "all stdio drained" signal so we
    // don't race with late-arriving stderr chunks. Also wire an
    // error handler so a spawn failure rejects the test instead
    // of hanging.
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    assert.equal(exitCode, 0, stderr);
    assert.match(
      stderr,
      /\[join-\S+ \d+\] ingest-all:/,
      `expected ingest-all breadcrumb; got:\n${stderr}`,
    );
    assert.match(
      stderr,
      /\[join-\S+ \d+\] plan-union:/,
      `expected plan-union breadcrumb; got:\n${stderr}`,
    );
    assert.match(
      stderr,
      /\[join-\S+ \d+\] validation:/,
      `expected validation breadcrumb; got:\n${stderr}`,
    );
    const joinIndices = [...stderr.matchAll(/\[join-\S+ (\d+)\]/g)].map(
      (m) => Number(m[1]),
    );
    assert.ok(
      joinIndices.length > 0,
      `expected at least one join breadcrumb; got:\n${stderr}`,
    );
    for (let i = 0; i < joinIndices.length; i++) {
      assert.equal(
        joinIndices[i],
        i + 1,
        `join phase index at position ${i} must equal ${i + 1}, got ${joinIndices[i]}; full sequence: ${joinIndices.join(", ")}`,
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
