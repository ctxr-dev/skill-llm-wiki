// join-pipeline.test.mjs — e2e coverage for the orchestrator's
// `plan.operation === "join"` branch.
//
// Complements the unit coverage in tests/unit/join.test.mjs (which
// exercises individual phase helpers) by driving the full CLI path:
//
//   1. Build two tiny source wikis via `build` (so each has a
//      private `.llmwiki/git/HEAD` + a valid root index.md + a
//      populated subcategory — the shape intent's INT-06 validation
//      requires for a source to be accepted).
//   2. Invoke `join <wiki-a> <wiki-b> --target <out>`.
//   3. Assert the orchestrator's join branch:
//        - ran per-phase commits (git log shows `phase join-...`)
//        - tagged `op/<join-op-id>` on the target
//        - produced a tree that passes `validate` (0 errors)
//        - preserves every source leaf (renamed or kept)
//   4. Smoke-test the rollback semantics: a deliberately-broken
//      second join (target already non-empty) must NOT clobber
//      the first join's output.
//
// Tier 1 is stubbed via `LLM_WIKI_MOCK_TIER1=1` so the test does
// not load MiniLM; the convergence phase relies on Tier 0 TF-IDF
// only (sufficient for the tiny fixtures used here). Tier 2 is
// skipped via `LLM_WIKI_SKIP_CLUSTER_NEST=1` + no mid-band pairs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

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

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-join-e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Build a source wiki from tiny fixture content so it gains the
// private git + managed-wiki markers intent's source-validation
// requires. Returns the built wiki path.
function buildSourceWiki(parent, name, leafIds) {
  const src = join(parent, `${name}-src`);
  // Use a per-source subcategory name so the joined tree doesn't
  // hit JOIN-INDEX-COLLISION on the subcat index (both sources
  // otherwise land a `notes/index.md` with `id: "notes"`).
  const subName = `notes-${name}`;
  mkdirSync(join(src, subName), { recursive: true });
  for (const id of leafIds) {
    writeFileSync(
      join(src, subName, `${id}.md`),
      `# ${id}\n\ndistinctive content about ${id} in ${name}\n`,
    );
  }
  const r = runCli(["build", src]);
  if (r.status !== 0) {
    throw new Error(`build failed for ${name}: ${r.stderr}`);
  }
  return `${src}.wiki`;
}

test("join e2e: two non-overlapping source wikis merge into a valid unified target", () => {
  const parent = tmpParent("happy");
  try {
    const wikiA = buildSourceWiki(parent, "a", ["alpha", "beta"]);
    const wikiB = buildSourceWiki(parent, "b", ["gamma", "delta"]);
    const target = join(parent, "out.wiki");
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
    // Target exists + is a managed wiki.
    assert.ok(existsSync(join(target, "index.md")));
    assert.ok(existsSync(join(target, ".llmwiki", "git", "HEAD")));
    // Every source leaf is reachable under its basename somewhere
    // in the joined tree.
    const find = (name) => {
      const stack = [target];
      while (stack.length) {
        const d = stack.pop();
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = join(d, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile() && e.name === name) return full;
        }
      }
      return null;
    };
    for (const id of ["alpha", "beta", "gamma", "delta"]) {
      assert.ok(find(`${id}.md`), `${id}.md must exist somewhere in the joined tree`);
    }
    // Validate the output.
    const v = runCli(["validate", target]);
    assert.equal(v.status, 0, v.stderr);
    // Private git log contains join-* phase commits.
    const log = runCli(["log", target]);
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /phase join-materialise/);
    assert.match(log.stdout, /phase join-index-generation/);
    // Final tag present.
    assert.match(log.stdout, /op\/join-/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("join e2e: refuses a non-empty --target", () => {
  const parent = tmpParent("nonempty");
  try {
    const wikiA = buildSourceWiki(parent, "a", ["alpha"]);
    const wikiB = buildSourceWiki(parent, "b", ["beta"]);
    const target = join(parent, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "squatter.txt"), "already here\n");
    const r = runCli([
      "join",
      wikiA,
      wikiB,
      "--target",
      target,
      "--quality-mode",
      "deterministic",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already exists and is not empty/);
    // Squatter content untouched.
    assert.ok(existsSync(join(target, "squatter.txt")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("join e2e: refuses when fewer than 2 positionals are supplied", () => {
  const parent = tmpParent("fewargs");
  try {
    const wikiA = buildSourceWiki(parent, "a", ["alpha"]);
    const r = runCli(["join", wikiA, "--target", join(parent, "out")]);
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr + r.stdout,
      /requires at least 2 <wiki-path> positionals/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
