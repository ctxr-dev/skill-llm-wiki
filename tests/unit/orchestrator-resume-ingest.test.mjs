// orchestrator-resume-ingest.test.mjs — unit coverage for the
// idempotent build-ingest helper that powers exit-7 build resume.
//
// `collectExistingLeavesBySource` walks a wiki tree and returns a
// map keyed by the `source.path` field carried in each existing
// leaf's frontmatter. The build phase uses this to detect leaves
// that are already drafted (so a re-run does not clobber authored
// frontmatter or duplicate leaves operator-convergence has moved
// under a subcategory).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectExistingLeavesBySource } from "../../scripts/lib/orchestrator.mjs";

function tmpWiki(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-resume-ingest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLeaf(absPath, sourcePath, hash, extra = "") {
  mkdirSync(absPath.slice(0, absPath.lastIndexOf("/")), { recursive: true });
  const fm = [
    "---",
    `id: ${absPath.split("/").pop().replace(/\.md$/, "")}`,
    "type: primary",
    "depth_role: leaf",
    "focus: anchor",
    "covers:",
    "  - thing",
    "parents:",
    "  - index.md",
    "tags:",
    "  - test",
    "source:",
    "  origin: file",
    `  path: ${sourcePath}`,
    `  hash: ${hash}`,
    "---",
    "",
    extra || "body",
    "",
  ].join("\n");
  writeFileSync(absPath, fm, "utf8");
}

test("collectExistingLeavesBySource: byte-identical leaf is captured by source path", () => {
  const wiki = tmpWiki("byte-identical");
  try {
    writeLeaf(join(wiki, "alpha.md"), "alpha.md", "sha256:cafebabe");
    const map = collectExistingLeavesBySource(wiki);
    assert.equal(map.size, 1);
    const entry = map.get("alpha.md");
    assert.ok(entry, "alpha.md must be in the map");
    assert.equal(entry.hash, "sha256:cafebabe");
    assert.equal(entry.targetRel, "alpha.md");
    assert.equal(entry.relCategory, "");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectExistingLeavesBySource: nested leaf reports its category", () => {
  const wiki = tmpWiki("nested");
  try {
    mkdirSync(join(wiki, "subgroup"), { recursive: true });
    writeLeaf(join(wiki, "subgroup", "beta.md"), "beta.md", "sha256:1234");
    const map = collectExistingLeavesBySource(wiki);
    const entry = map.get("beta.md");
    assert.ok(entry, "beta.md must be discovered under subgroup/");
    assert.equal(entry.relCategory, "subgroup");
    assert.equal(entry.targetRel, "subgroup/beta.md");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectExistingLeavesBySource: leaves without source.path are skipped", () => {
  const wiki = tmpWiki("no-source");
  try {
    // Hand-write a leaf without the source block. The helper must
    // not blow up; it simply omits the file from the map.
    const fm = [
      "---",
      "id: orphan",
      "type: primary",
      "depth_role: leaf",
      "focus: orphan",
      "covers:",
      "  - x",
      "parents:",
      "  - index.md",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    writeFileSync(join(wiki, "orphan.md"), fm, "utf8");
    const map = collectExistingLeavesBySource(wiki);
    assert.equal(map.size, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectExistingLeavesBySource: skips index.md and dot-dirs", () => {
  const wiki = tmpWiki("skips");
  try {
    // index.md must be ignored.
    writeLeaf(join(wiki, "index.md"), "index.md", "sha256:abc");
    // Hidden working-dir leaf must be ignored.
    mkdirSync(join(wiki, ".work", "build-x"), { recursive: true });
    writeLeaf(join(wiki, ".work", "build-x", "leak.md"), "leak.md", "sha256:zzz");
    // A real leaf at the root must still appear.
    writeLeaf(join(wiki, "real.md"), "real.md", "sha256:dead");
    const map = collectExistingLeavesBySource(wiki);
    assert.equal(map.size, 1);
    assert.ok(map.has("real.md"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectExistingLeavesBySource: hash field round-trips so callers can compare", () => {
  // The whole point of the map is that callers compare
  // entry.hash against a freshly-ingested candidate.hash to decide
  // skip-vs-redraft. Verify the round-trip preserves the literal
  // string (no parsing surprises around `sha256:` prefixes).
  const wiki = tmpWiki("hash-roundtrip");
  try {
    writeLeaf(
      join(wiki, "gamma.md"),
      "src/gamma.md",
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const map = collectExistingLeavesBySource(wiki);
    const entry = map.get("src/gamma.md");
    assert.ok(entry);
    assert.equal(
      entry.hash,
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
