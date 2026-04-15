// migration.test.mjs — legacy `<source>.llmwiki.v<N>/` → `<source>.wiki/`
// migration. Build refuses to operate on the legacy folder (INT-04);
// `migrate` does the move; the legacy folder stays byte-identical; the
// new wiki has a private git repo and an op-log entry describing the
// migration.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function runCli(args, cwd) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LLM_WIKI_NO_PROMPT: "1" },
  });
}

function tmpParent(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-mig-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function dirHash(root) {
  const h = createHash("sha256");
  function walk(rel) {
    const full = join(root, rel);
    for (const name of readdirSync(full).sort()) {
      const sub = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, sub));
      if (st.isDirectory()) {
        walk(sub);
      } else {
        h.update(sub);
        h.update("\0");
        h.update(readFileSync(join(root, sub)));
        h.update("\0");
      }
    }
  }
  walk("");
  return h.digest("hex");
}

test("build refuses to operate on a legacy .llmwiki.v<N> folder", () => {
  const parent = tmpParent("refuse");
  try {
    const legacy = join(parent, "docs.llmwiki.v2");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "index.md"), "# legacy root\n");
    const r = runCli(["build", legacy, "--json-errors"], parent);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-04");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("migrate moves a legacy wiki into <source>.wiki and leaves legacy intact", () => {
  const parent = tmpParent("migrate");
  try {
    const legacy = join(parent, "docs.llmwiki.v3");
    mkdirSync(legacy);
    mkdirSync(join(legacy, "sub"));
    writeFileSync(join(legacy, "index.md"), "# legacy\n");
    writeFileSync(join(legacy, "a.md"), "# a\n");
    writeFileSync(join(legacy, "sub", "b.md"), "# b\n");

    const legacyHashBefore = dirHash(legacy);

    const r = runCli(["migrate", legacy], parent);
    assert.equal(r.status, 0, `migrate failed: ${r.stderr}`);

    // New wiki at docs.wiki/ with private git.
    const target = join(parent, "docs.wiki");
    assert.ok(existsSync(target));
    assert.ok(existsSync(join(target, ".llmwiki", "git", "HEAD")));
    assert.ok(existsSync(join(target, "a.md")));
    assert.ok(existsSync(join(target, "sub", "b.md")));

    // Op-log records the migration lineage.
    const opLog = readFileSync(
      join(target, ".llmwiki", "op-log.yaml"),
      "utf8",
    );
    assert.match(opLog, /operation: migrate/);
    assert.match(opLog, /v3/);

    // Legacy folder byte-identical afterwards.
    const legacyHashAfter = dirHash(legacy);
    assert.equal(
      legacyHashAfter,
      legacyHashBefore,
      "legacy folder must be byte-identical after migration",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("migrate refuses when target already exists", () => {
  const parent = tmpParent("collision");
  try {
    const legacy = join(parent, "docs.llmwiki.v1");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "a.md"), "# a\n");
    // Pre-existing sibling the skill would collide with.
    mkdirSync(join(parent, "docs.wiki"));
    writeFileSync(join(parent, "docs.wiki", "something.md"), "other\n");

    const r = runCli(["migrate", legacy, "--json-errors"], parent);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-01");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("migrate atomically cleans up the destination on failure", async () => {
  // Drive migrateLegacyWiki directly and force a failure between
  // mkdirSync and the final commit by planting a pre-existing op tag
  // that will collide with the fresh gitTag call. The atomic rollback
  // must remove the half-built destination so a retry starts clean.
  const { migrateLegacyWiki } = await import(
    "../../scripts/lib/migrate.mjs"
  );
  const { gitInit, gitTag } = await import("../../scripts/lib/git.mjs");
  const parent = tmpParent("atomic");
  try {
    const legacy = join(parent, "docs.llmwiki.v1");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "a.md"), "# a\n");
    const target = join(parent, "docs.wiki");

    // Pre-seed a conflicting tag by creating the target ourselves,
    // initialising its private git, and planting a different commit at
    // the same tag name migrate will attempt to use. We then remove
    // just the working tree files (NOT the .llmwiki/git/) so migrate
    // sees `existsSync(newWikiPath) === false` semantics... except
    // cpSync would fail anyway. Simpler: pass an opId that collides
    // with an existing tag. Create the repo + tag separately first.
    //
    // Actually, the simplest forced-failure is to make the legacy
    // source unreadable partway through. We fake that by using a
    // non-string opId, which throws a controlled error BEFORE mkdir
    // runs — but we want the failure AFTER mkdir so we can verify
    // cleanup. Use `cpSync` failure: we pre-create the target as a
    // file, so migrateLegacyWiki's mkdirSync `recursive: true` on an
    // existing FILE path will throw. But the pre-existence guard
    // would refuse first.
    //
    // Cleanest: monkey-patch process.env.LLM_WIKI_FIXED_TIMESTAMP to
    // a value that trips LLM_WIKI_FIXED_TIMESTAMP validation — that
    // throws from within gitCommit, which runs AFTER cpSync and
    // mkdirSync. This is a real failure path.
    const prev = process.env.LLM_WIKI_FIXED_TIMESTAMP;
    process.env.LLM_WIKI_FIXED_TIMESTAMP = "not-a-number";
    let caught = null;
    try {
      migrateLegacyWiki(legacy, target, { opId: "atomic-test" });
    } catch (err) {
      caught = err;
    } finally {
      if (prev === undefined) delete process.env.LLM_WIKI_FIXED_TIMESTAMP;
      else process.env.LLM_WIKI_FIXED_TIMESTAMP = prev;
    }
    assert.ok(caught, "migration should have thrown");
    assert.match(
      caught.message,
      /LLM_WIKI_FIXED_TIMESTAMP must be a positive integer/,
    );
    // Destination must have been cleaned up — a retry should now work.
    assert.equal(
      existsSync(target),
      false,
      "half-built destination must be removed after failure",
    );

    // Second attempt — should succeed.
    const r = migrateLegacyWiki(legacy, target, { opId: "atomic-retry" });
    assert.equal(r.version, 1);
    assert.ok(existsSync(join(target, "a.md")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
