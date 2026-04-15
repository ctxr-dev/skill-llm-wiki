// orchestrator-build.test.mjs — end-to-end proof that a `build`
// invocation produces a valid wiki with a per-phase commit history and
// that validation failure rolls back cleanly.

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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
}

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-orch-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("depth-2 index parent paths resolve correctly end-to-end", async () => {
  // Regression for bootstrapIndexStubs + rebuildIndex parent-path
  // correctness at depth ≥ 2. We construct a wiki manually (the
  // default draft categoriser would flatten everything to depth 1),
  // run the orchestrator's index rebuild pipeline, and assert both
  // the frontmatter parents[] value AND that the full validator
  // passes the narrowing-chain and parents-required checks.
  const { preOpSnapshot } = await import("../../scripts/lib/snapshot.mjs");
  const { parseFrontmatter } = await import(
    "../../scripts/lib/frontmatter.mjs"
  );
  const { rebuildAllIndices } = await import(
    "../../scripts/lib/indices.mjs"
  );
  const { validateWiki, summariseFindings } = await import(
    "../../scripts/lib/validate.mjs"
  );
  const orchestrator = await import("../../scripts/lib/orchestrator.mjs");
  // bootstrapIndexStubs is not exported; drive it indirectly via the
  // full rebuild pipeline — or import the internal helper through a
  // test-only path. We exercise the pipeline by directly creating a
  // depth-2 wiki structure and calling rebuildAllIndices.

  const parent = tmpParent("depth2-real");
  try {
    const wiki = join(parent, "manual.wiki");
    // Create the nested leaf structure manually.
    mkdirSync(join(wiki, "api", "v1"), { recursive: true });
    mkdirSync(join(wiki, "api", "v2"), { recursive: true });
    writeFileSync(
      join(wiki, "api", "v1", "hello-v1.md"),
      "---\nid: hello-v1\ntype: primary\ndepth_role: leaf\nfocus: v1 greeting\ncovers:\n  - returns a version-1 greeting\nparents:\n  - ../index.md\n---\n\nbody\n",
    );
    writeFileSync(
      join(wiki, "api", "v2", "hello-v2.md"),
      "---\nid: hello-v2\ntype: primary\ndepth_role: leaf\nfocus: v2 greeting\ncovers:\n  - returns a version-2 greeting\nparents:\n  - ../index.md\n---\n\nbody\n",
    );
    // Seed the private git so snapshot.mjs can take an initial
    // snapshot; this runs bootstrapIndexStubs indirectly via the
    // orchestrator's full pipeline. The simplest way to drive the
    // bootstrap + rebuild cycle is to run an empty-source build into
    // a wiki directory that already has content, but that path is
    // now blocked by the build-overwrite guard. Instead, drive
    // rebuildAllIndices after manually initialising git.
    preOpSnapshot(wiki, "depth2-test");
    // bootstrapIndexStubs is an internal function — invoke it by
    // asking the orchestrator to run a no-source build. That path
    // is also guarded. Fall back to the lowest-level component test:
    // directly verify `rebuildIndex.parents` derivation on a manually
    // pre-stubbed tree.
    //
    // Stub the intermediate indices exactly as bootstrapIndexStubs
    // would for a depth-2 leaf-bearing tree, then rebuild.
    for (const dir of [wiki, join(wiki, "api"), join(wiki, "api", "v1"), join(wiki, "api", "v2")]) {
      const id =
        dir === wiki ? basename(wiki) : basename(dir);
      const role = dir === wiki ? "category" : "subcategory";
      writeFileSync(
        join(dir, "index.md"),
        `---\nid: ${id}\ntype: index\ndepth_role: ${role}\nfocus: "subtree under ${id}"\ngenerator: skill-llm-wiki/v1\n---\n\n`,
      );
    }
    rebuildAllIndices(wiki);

    // Parent-path correctness for depth 2.
    const v1Index = readFileSync(join(wiki, "api", "v1", "index.md"), "utf8");
    const { data: v1Data } = parseFrontmatter(v1Index);
    assert.deepEqual(
      v1Data.parents,
      ["../index.md"],
      `depth-2 v1 index.md parents must be [../index.md], got ${JSON.stringify(v1Data.parents)}`,
    );

    const apiIndex = readFileSync(join(wiki, "api", "index.md"), "utf8");
    const { data: apiData } = parseFrontmatter(apiIndex);
    assert.deepEqual(
      apiData.parents,
      ["../index.md"],
      "depth-1 api index.md parents must be [../index.md]",
    );

    // Full validator: narrowing chain, PARENTS-REQUIRED, link integrity.
    const findings = validateWiki(wiki);
    const summary = summariseFindings(findings);
    // Allow soft-signal warnings; the narrowing/parents bugs are
    // hard errors that would trigger here if the fix regressed.
    const errorFindings = findings.filter((f) => f.severity === "error");
    assert.equal(
      summary.errors,
      0,
      `depth-2 validation errors: ${errorFindings.map((f) => `${f.code}: ${f.message}`).join(" | ")}`,
    );
    // Reference orchestrator import so lint doesn't complain.
    assert.ok(orchestrator.runOperation);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("build end-to-end produces a valid wiki with per-phase commits", () => {
  const parent = tmpParent("happy");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    mkdirSync(join(src, "api"));
    writeFileSync(join(src, "api", "hello.md"), "# Hello API\n\nSends greetings.\n");
    writeFileSync(join(src, "overview.md"), "# Overview\n\nTop-level intro.\n");

    const r = runCli(["build", src]);
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);

    // Every phase name must appear in the output.
    for (const phase of [
      "snapshot",
      "ingest",
      "draft-frontmatter",
      "index-generation",
      "validation",
      "commit-finalize",
    ]) {
      assert.match(
        r.stdout,
        new RegExp(phase),
        `phase ${phase} missing from build output`,
      );
    }

    const wiki = join(parent, "docs.wiki");
    assert.ok(existsSync(join(wiki, "index.md")), "root index.md must exist");
    assert.ok(existsSync(join(wiki, ".llmwiki", "git", "HEAD")));

    // Validation smoke: the wiki the orchestrator just built must pass
    // the hard-invariant validator.
    const v = runCli(["validate", wiki]);
    assert.equal(v.status, 0, `validate failed: ${v.stderr}`);

    // Op-log entry must exist with the final_commit populated.
    const opLog = readFileSync(
      join(wiki, ".llmwiki", "op-log.yaml"),
      "utf8",
    );
    assert.match(opLog, /operation: build/);
    assert.match(opLog, /layout_mode: sibling/);
    assert.match(opLog, /final_commit:/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("validation failure leaves no op/<id> final tag and rolls tree to pre-op", () => {
  // Build a wiki, corrupt a leaf, then run rebuild. The orchestrator
  // should:
  //   (a) snapshot the corrupted working tree as `pre-op/<rebuild-id>`,
  //   (b) run phases through validation, which fails,
  //   (c) `git reset --hard pre-op/<rebuild-id>`,
  //   (d) NOT create the final `op/<rebuild-id>` tag,
  //   (e) leave the HEAD pointing at the pre-op snapshot (which is the
  //       corrupted state — the user must fix and retry; the orchestrator
  //       does NOT reach back to a prior healthy commit).
  const parent = tmpParent("rollback");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    // Two distinct leaves so Phase 6's LIFT operator doesn't
    // rearrange the tree under us. Rollback semantics are
    // orthogonal to operator-convergence; we just need a stable
    // layout we can find the leaf in after build.
    writeFileSync(join(src, "a.md"), "# alpha\n\nalpha content\n");
    writeFileSync(join(src, "b.md"), "# beta\n\nbeta content\n");

    const build = runCli(["build", src]);
    assert.equal(build.status, 0, build.stderr);
    const wiki = join(parent, "docs.wiki");

    // Corrupt a leaf: keep `id` so collectAll picks it up, strip every
    // other required field so the validator emits MISSING-FIELD.
    // Leaves from a flat source live at the wiki root now (no `general/`
    // bucket), matching the source layout.
    const leafPath = join(wiki, "a.md");
    assert.ok(
      existsSync(leafPath),
      `fixture leaf should be at ${leafPath} after build`,
    );
    writeFileSync(leafPath, "---\nid: a\ntype: primary\n---\n\ncorrupted\n");

    const rebuild = runCli(["rebuild", wiki]);
    assert.notEqual(
      rebuild.status,
      0,
      "rebuild must fail when validation is broken",
    );
    assert.match(rebuild.stderr, /validation failed/);

    // Extract the rebuild op-id from the error output. The orchestrator's
    // ValidationError includes the op-id explicitly via "for op <id>"
    // thanks to M2's message refinement.
    const opIdMatch = /rebuild-\d{8}-\d{6}-[a-z0-9]+/.exec(
      rebuild.stderr + rebuild.stdout,
    );
    const rebuildOpId = opIdMatch ? opIdMatch[0] : null;
    assert.ok(rebuildOpId, "should be able to locate the failed rebuild op-id");

    // 1. The final tag must NOT exist.
    const finalTagCheck = runCli([
      "show",
      wiki,
      `refs/tags/op/${rebuildOpId}`,
    ]);
    assert.notEqual(
      finalTagCheck.status,
      0,
      `op/${rebuildOpId} final tag must NOT exist after validation failure`,
    );

    // 2. The pre-op tag MUST exist and resolve cleanly.
    const preTagCheck = runCli([
      "show",
      wiki,
      `refs/tags/pre-op/${rebuildOpId}`,
    ]);
    assert.equal(
      preTagCheck.status,
      0,
      `pre-op/${rebuildOpId} must exist as the rollback anchor`,
    );

    // 3. HEAD matches the pre-op tag after rollback.
    const headSha = runCli(["log", wiki, "-1", "--format=%H"]).stdout.trim();
    const preSha = runCli([
      "show",
      wiki,
      `refs/tags/pre-op/${rebuildOpId}`,
      "--format=%H",
      "--no-patch",
    ]).stdout.trim();
    assert.equal(
      headSha,
      preSha,
      "HEAD must equal the pre-op tag after rollback",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
