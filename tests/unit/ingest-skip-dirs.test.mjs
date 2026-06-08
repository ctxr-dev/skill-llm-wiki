// ingest-skip-dirs.test.mjs - regression: a curated TEXT source must not have its
// content silently dropped because a directory is named build/ dist/ target/. Those
// are build-output names skipped only for CODE ingests. A leaf folder sharded by id
// prefix (e.g. reviewers.src/build/build-cargo.md) is hand-authored content.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestSource } from "../../scripts/lib/ingest.mjs";

function freshDir() {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-ingest-skip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function leaf(dir, id) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nid: ${id}\ntype: primary\nfocus: ${id}\n---\n\n# ${id}\n`,
  );
}

test("text ingest: leaves under build/ dist/ target/ are NOT dropped", () => {
  const src = freshDir();
  try {
    leaf(src, "top-level");
    leaf(join(src, "build"), "build-cargo");
    leaf(join(src, "dist"), "dist-thing");
    leaf(join(src, "target"), "target-thing");
    const { leaves } = ingestSource(src);
    const ids = new Set(leaves.map((l) => l.id));
    assert.ok(ids.has("build-cargo"), "build/ leaf should be ingested");
    assert.ok(ids.has("dist-thing"), "dist/ leaf should be ingested");
    assert.ok(ids.has("target-thing"), "target/ leaf should be ingested");
    assert.ok(ids.has("top-level"));
    assert.equal(leaves.length, 4);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("text ingest: node_modules and __pycache__ are still skipped", () => {
  const src = freshDir();
  try {
    leaf(src, "real");
    leaf(join(src, "node_modules"), "dep");
    leaf(join(src, "__pycache__"), "cached");
    const { leaves } = ingestSource(src);
    const ids = new Set(leaves.map((l) => l.id));
    assert.ok(ids.has("real"));
    assert.ok(!ids.has("dep"), "node_modules must stay skipped");
    assert.ok(!ids.has("cached"), "__pycache__ must stay skipped");
    assert.equal(leaves.length, 1);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("code ingest (includeCode): build-output dirs ARE still skipped", () => {
  const src = freshDir();
  try {
    leaf(src, "keep");
    leaf(join(src, "build"), "generated");
    // includeCode also pulls in code files, but the .md under build/ must be skipped.
    const { leaves } = ingestSource(src, { includeCode: true });
    const ids = new Set(leaves.map((l) => l.id));
    assert.ok(ids.has("keep"));
    assert.ok(!ids.has("generated"), "build/ must be skipped for a code ingest");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
