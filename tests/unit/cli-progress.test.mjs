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

test("cli progress: join streams per-phase breadcrumbs during execution", () => {
  // Regression for the PR-17-followup fix: before runJoin grew
  // an `onPhase` callback, the orchestrator's join branch only
  // relayed join's sub-phases into the outer phases[] AFTER
  // runJoin returned, so the stderr breadcrumbs all printed at
  // the end of the join instead of during it. This test pins
  // that join's own phase names (ingest-all, plan-union,
  // resolve-id-collisions, …) show up in stderr with consecutive
  // phase indices — proof that `onPhase` is wired through to the
  // CLI breadcrumb callback in real time.
  const parent = tmpParent("join");
  try {
    const srcA = buildTinySource(parent, ["alpha-src"]);
    // Build the first source into a wiki.
    const buildA = runCli(["build", srcA]);
    assert.equal(buildA.status, 0, buildA.stderr);
    const wikiA = `${srcA}.wiki`;
    // Build a second source (distinct subcat + leaves).
    const srcBRoot = join(parent, "srcB");
    mkdirSync(join(srcBRoot, "other"), { recursive: true });
    writeFileSync(
      join(srcBRoot, "other", "beta-src.md"),
      "# Beta\n\ndistinct beta content\n",
    );
    const buildB = runCli(["build", srcBRoot]);
    assert.equal(buildB.status, 0, buildB.stderr);
    const wikiB = `${srcBRoot}.wiki`;
    // Run the actual join; progress breadcrumbs should stream.
    const target = join(parent, "joined.wiki");
    const r = runCli([
      "join",
      wikiA,
      wikiB,
      "--target",
      target,
      "--quality-mode",
      "deterministic",
    ]);
    assert.equal(r.status, 0, r.stderr);
    // Each join sub-phase must appear as a `[join-... N] <phase>:`
    // breadcrumb. Check a couple of representative ones that
    // `runJoin` always records on a 2-source clean-merge run.
    assert.match(
      r.stderr,
      /\[join-\S+ \d+\] ingest-all:/,
      `expected ingest-all breadcrumb; got:\n${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[join-\S+ \d+\] plan-union:/,
      `expected plan-union breadcrumb; got:\n${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /\[join-\S+ \d+\] validation:/,
      `expected validation breadcrumb; got:\n${r.stderr}`,
    );
    // And the index sequence is consecutive from 1 for the join
    // op's breadcrumbs.
    const joinIndices = [...r.stderr.matchAll(/\[join-\S+ (\d+)\]/g)].map(
      (m) => Number(m[1]),
    );
    assert.ok(
      joinIndices.length > 0,
      `expected at least one join breadcrumb; got:\n${r.stderr}`,
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
