// intent-resolve.test.mjs — every ambiguity scenario from Part 6 of the
// master plan, plus the happy path for each layout mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIntent, VALID_LAYOUT_MODES } from "../../scripts/lib/intent.mjs";

function freshDir(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-intent-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function freshFile(tag) {
  const dir = freshDir(tag);
  const file = join(dir, "single.md");
  writeFileSync(file, "# single\n", "utf8");
  return file;
}

// Mark a directory as a skill-managed wiki by planting the marker files
// isWikiRoot / hasPrivateGit look for. Avoids calling git.
function plantManagedWiki(dir) {
  mkdirSync(join(dir, ".llmwiki", "git"), { recursive: true });
  writeFileSync(join(dir, ".llmwiki", "git", "HEAD"), "ref: main\n");
  writeFileSync(
    join(dir, "index.md"),
    "---\ngenerator: skill-llm-wiki/v1\nid: root\ntype: index\ndepth_role: category\nfocus: root\n---\n\n",
  );
}

test("VALID_LAYOUT_MODES is the canonical allow-list", () => {
  assert.deepEqual([...VALID_LAYOUT_MODES], ["sibling", "in-place", "hosted"]);
});

test("INT-13: unknown --quality-mode value is rejected at intent time", async () => {
  // intent.mjs validates --quality-mode before the orchestrator
  // runs so a typo does not trigger a full pre-op snapshot +
  // rollback. We don't need a real wiki for this — just a bare
  // tmp dir and a build invocation.
  const parent = freshDir("int13");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const { resolveIntent: _resolveIntent } = await import(
      "../../scripts/lib/intent.mjs"
    );
    const r = _resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { quality_mode: "bogus" },
      cwd: parent,
    });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.error.code, "INT-13");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-13: known --quality-mode values are accepted", async () => {
  const parent = freshDir("int13-ok");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const { resolveIntent: _resolveIntent } = await import(
      "../../scripts/lib/intent.mjs"
    );
    for (const mode of ["tiered-fast", "claude-first", "tier0-only"]) {
      const r = _resolveIntent({
        subcommand: "build",
        args: [src],
        flags: { quality_mode: mode },
        cwd: parent,
      });
      assert.equal(r.status, "ok", `expected ${mode} to resolve, got ${JSON.stringify(r)}`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-10: unknown --layout-mode value", () => {
  const r = resolveIntent({
    subcommand: "build",
    args: ["./docs"],
    flags: { layout_mode: "sideways" },
    cwd: "/tmp",
  });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.error.code, "INT-10");
});

test("INT-09a: --layout-mode in-place with --target", () => {
  const r = resolveIntent({
    subcommand: "build",
    args: ["./docs"],
    flags: { layout_mode: "in-place", target: "./elsewhere" },
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-09a");
});

test("INT-09b: --layout-mode hosted without --target", () => {
  const r = resolveIntent({
    subcommand: "build",
    args: ["./docs"],
    flags: { layout_mode: "hosted" },
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-09b");
});

test("precedence: INT-10 fires before INT-09a when both apply", () => {
  // `--layout-mode sideways --target other` is both an unknown mode
  // (INT-10) and a hypothetically-conflicting combination. INT-10
  // must win because the mode string is invalid and cannot be
  // interpreted as "in-place".
  const r = resolveIntent({
    subcommand: "build",
    args: ["./docs"],
    flags: { layout_mode: "sideways", target: "./elsewhere" },
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-10");
});

test("INT-05: rollback without --to", () => {
  const r = resolveIntent({
    subcommand: "rollback",
    args: ["./docs.wiki"],
    flags: {},
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-05");
});

test("INT-05: rollback without a positional", () => {
  const r = resolveIntent({
    subcommand: "rollback",
    args: [],
    flags: { to: "genesis" },
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-05");
});

test("INT-06: missing positional on build", () => {
  const r = resolveIntent({
    subcommand: "build",
    args: [],
    flags: {},
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-06");
});

test("INT-06: source is a file, not a directory", () => {
  const f = freshFile("file-src");
  try {
    const r = resolveIntent({
      subcommand: "build",
      args: [f],
      flags: {},
      cwd: "/tmp",
    });
    assert.equal(r.error.code, "INT-06");
  } finally {
    rmSync(f, { force: true });
  }
});

test("INT-07: multi-source build", () => {
  const r = resolveIntent({
    subcommand: "build",
    args: ["./a", "./b"],
    flags: {},
    cwd: "/tmp",
  });
  assert.equal(r.error.code, "INT-07");
});

test("INT-04: legacy .llmwiki.v2 folder", () => {
  const parent = freshDir("legacy-parent");
  try {
    const legacy = join(parent, "docs.llmwiki.v2");
    mkdirSync(legacy);
    const r = resolveIntent({
      subcommand: "build",
      args: [legacy],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-04");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-02: source is already a managed wiki (implicit in-place)", () => {
  const parent = freshDir("managed-parent");
  try {
    const wiki = join(parent, "already-a-wiki");
    mkdirSync(wiki);
    plantManagedWiki(wiki);
    const r = resolveIntent({
      subcommand: "build",
      args: [wiki],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-02");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-02: explicit --layout-mode in-place is allowed", () => {
  const parent = freshDir("managed-inplace");
  try {
    const wiki = join(parent, "already-a-wiki");
    mkdirSync(wiki);
    plantManagedWiki(wiki);
    const r = resolveIntent({
      subcommand: "build",
      args: [wiki],
      flags: { layout_mode: "in-place" },
      cwd: parent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.layout_mode, "in-place");
    assert.equal(r.plan.target, wiki);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-01: default sibling target already exists as foreign dir", () => {
  const parent = freshDir("collision-parent");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    // Pre-create a non-managed sibling the skill would collide with.
    const sibling = join(parent, "docs.wiki");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "unrelated.md"), "not a wiki\n");
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-01");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-03: build on an existing managed sibling wiki", () => {
  const parent = freshDir("int03-parent");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const sibling = join(parent, "docs.wiki");
    mkdirSync(sibling);
    plantManagedWiki(sibling);
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-03");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-03 resume: pending Tier 2 batch lets build through", () => {
  // Resume escape hatch: a wiki with a pending-*.json under
  // .work/tier2 is in the middle of an exit-7 handshake. Building
  // again with the same source must NOT trip INT-03 — the
  // orchestrator's idempotent ingest will then take over.
  const parent = freshDir("int03-resume-pending");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const sibling = join(parent, "docs.wiki");
    mkdirSync(sibling);
    plantManagedWiki(sibling);
    // Plant a fake pending Tier 2 batch.
    const tier2Dir = join(sibling, ".work", "tier2");
    mkdirSync(tier2Dir, { recursive: true });
    writeFileSync(
      join(tier2Dir, "pending-deadbeef.json"),
      JSON.stringify({ batch_id: "deadbeef", requests: [] }),
      "utf8",
    );
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(
      r.status,
      "ok",
      `resume must short-circuit INT-03, got: ${JSON.stringify(r.error)}`,
    );
    assert.equal(r.plan.operation, "build");
    assert.equal(r.plan.target, sibling);
    // is_new_wiki must reflect the pre-existing managed state so the
    // CLI doesn't try to re-create the wiki dir.
    assert.equal(r.plan.is_new_wiki, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-03 resume: build-* workdir without finalised op-log lets build through", () => {
  // Second resume signal: a `.work/build-*` workdir whose op-id
  // never appeared in op-log.yaml means the prior build crashed
  // before commit-finalize. Allow the resume.
  const parent = freshDir("int03-resume-workdir");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const sibling = join(parent, "docs.wiki");
    mkdirSync(sibling);
    plantManagedWiki(sibling);
    const workdir = join(sibling, ".work", "build-20250101-000000-abc");
    mkdirSync(workdir, { recursive: true });
    writeFileSync(
      join(workdir, "candidates.json"),
      JSON.stringify({ candidates: [], indexSources: [] }),
      "utf8",
    );
    // op-log.yaml does NOT mention this op-id.
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.status, "ok", "crashed-build resume must short-circuit INT-03");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-03 resume: a finalised build still trips INT-03", () => {
  // Counter-test: a wiki whose op-log contains the build op-id is
  // finalised and must NOT be silently re-built. INT-03 still fires.
  const parent = freshDir("int03-resume-final");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const sibling = join(parent, "docs.wiki");
    mkdirSync(sibling);
    plantManagedWiki(sibling);
    const opId = "build-20250101-000000-final";
    const workdir = join(sibling, ".work", opId);
    mkdirSync(workdir, { recursive: true });
    writeFileSync(
      join(workdir, "candidates.json"),
      JSON.stringify({ candidates: [], indexSources: [] }),
      "utf8",
    );
    // Plant an op-log entry that mentions the op-id. The YAML
    // emitter writes hyphenated op-ids unquoted, which is what
    // history.mjs:emitEntry produces in production.
    mkdirSync(join(sibling, ".llmwiki"), { recursive: true });
    writeFileSync(
      join(sibling, ".llmwiki", "op-log.yaml"),
      `# op-log\n- op_id: ${opId}\n  operation: build\n  layout_mode: sibling\n`,
      "utf8",
    );
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.status, "ambiguous");
    assert.equal(r.error.code, "INT-03");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("happy path: sibling build to default target", () => {
  const parent = freshDir("happy-sibling");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: {},
      cwd: parent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.operation, "build");
    assert.equal(r.plan.layout_mode, "sibling");
    assert.equal(r.plan.target, join(parent, "docs.wiki"));
    assert.equal(r.plan.is_new_wiki, true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("happy path: hosted build with --target", () => {
  const parent = freshDir("happy-hosted");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { layout_mode: "hosted", target: join(parent, "memory") },
      cwd: parent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.layout_mode, "hosted");
    assert.equal(r.plan.target, join(parent, "memory"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rollback happy path with --to genesis", () => {
  const wiki = freshDir("rb-happy");
  try {
    const r = resolveIntent({
      subcommand: "rollback",
      args: [wiki],
      flags: { to: "genesis" },
      cwd: "/tmp",
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.operation, "rollback");
    assert.equal(r.plan.target, wiki);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("INT-01b: explicit --target into a non-empty foreign directory", () => {
  const parent = freshDir("int01b");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const target = join(parent, "target");
    mkdirSync(target);
    writeFileSync(join(target, "unrelated.md"), "foreign\n");
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { target },
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-01b");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-01b: --accept-foreign-target overrides the guard", () => {
  const parent = freshDir("int01b-accept");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const target = join(parent, "target");
    mkdirSync(target);
    writeFileSync(join(target, "unrelated.md"), "foreign\n");
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { target, accept_foreign_target: true },
      cwd: parent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.target, target);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-01b: hosted mode refuses foreign target without layout contract", () => {
  const parent = freshDir("int01b-hosted");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const target = join(parent, "hosted-target");
    mkdirSync(target);
    writeFileSync(join(target, "unrelated.md"), "foreign\n");
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { layout_mode: "hosted", target },
      cwd: parent,
    });
    assert.equal(r.error.code, "INT-01b");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("hosted mode allows a foreign target when a layout contract is present", () => {
  const parent = freshDir("hosted-contract");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const target = join(parent, "hosted-target");
    mkdirSync(target);
    writeFileSync(join(target, "some-file.md"), "pre-existing\n");
    writeFileSync(join(target, ".llmwiki.layout.yaml"), "version: 1\n");
    const r = resolveIntent({
      subcommand: "build",
      args: [src],
      flags: { layout_mode: "hosted", target },
      cwd: parent,
    });
    assert.equal(r.status, "ok");
    assert.equal(r.plan.layout_mode, "hosted");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
