// Smoke test for skill-llm-wiki.
// Verifies: frontmatter roundtrip, ingest, hand-built wiki passes validate,
// index-rebuild is idempotent, shape-check detects LIFT candidates.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter, renderFrontmatter } from "../scripts/lib/frontmatter.mjs";
import { ingestSource } from "../scripts/lib/ingest.mjs";
import { rebuildAllIndices } from "../scripts/lib/indices.mjs";
import { validateWiki, summariseFindings } from "../scripts/lib/validate.mjs";
import { runShapeCheck } from "../scripts/lib/shape-check.mjs";
import { findEnclosingWiki, isWikiRoot } from "../scripts/lib/paths.mjs";

function tmp() {
  return join(tmpdir(), `skill-llm-wiki-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

test("frontmatter roundtrip preserves data", () => {
  const input = {
    id: "installation",
    type: "index",
    depth_role: "category",
    depth: 1,
    focus: "installing the product",
    parents: ["../index.md"],
    shared_covers: ["prereq checks", "post-install validation"],
    activation_defaults: {
      file_globs: ["**/*install*"],
      import_patterns: [],
    },
    entries: [
      { id: "linux", file: "linux.md", type: "primary", focus: "installing on Linux" },
      { id: "macos", file: "macos.md", type: "primary", focus: "installing on macOS" },
    ],
    orientation: "This subtree covers installation.\nPick the child matching your OS.",
    rebuild_needed: false,
  };
  const rendered = renderFrontmatter(input, "\nbody here\n");
  const { data } = parseFrontmatter(rendered);
  assert.deepEqual(data, input);
});

test("ingest walks a source and produces candidates", () => {
  const src = tmp();
  try {
    mkdirSync(join(src, "installation"), { recursive: true });
    writeFileSync(
      join(src, "installation", "linux.md"),
      "# Linux\n\nInstall on Linux.\n\n## Prerequisites\n\n- RAM\n- Disk\n",
    );
    writeFileSync(
      join(src, "README.md"),
      "# Project\n\nTop-level docs.\n",
    );
    const { leaves: candidates } = ingestSource(src);
    assert.equal(candidates.length, 2);
    // ids are derived from the plain filename, not the flattened
    // directory slug, so the validator's ID-MISMATCH-FILE check can
    // pass when the orchestrator writes the leaf at its original
    // file position (`installation/linux.md`).
    const linux = candidates.find((c) => c.id === "linux");
    assert.ok(linux, "expected a linux candidate");
    assert.equal(linux.title, "Linux");
    assert.ok(linux.headings.some((h) => h.text === "Prerequisites"));
    assert.ok(linux.hash.startsWith("sha256:"));
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("hand-built wiki passes validate; index-rebuild is idempotent", () => {
  const base = tmp();
  const wiki = `${base}.llmwiki.v1`;
  try {
    mkdirSync(join(wiki, "installation"), { recursive: true });

    writeFileSync(
      join(wiki, "index.md"),
      `---\nid: ${wiki.split("/").pop()}\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "product docs"\nparents: []\n---\n`,
    );
    writeFileSync(
      join(wiki, "installation", "index.md"),
      `---\nid: installation\ntype: index\ndepth_role: category\ndepth: 1\nfocus: "installing the product"\nparents:\n  - ../index.md\n---\n`,
    );
    writeFileSync(
      join(wiki, "installation", "linux.md"),
      `---\nid: linux\ntype: primary\ndepth_role: leaf\nfocus: "installing on Linux"\nparents:\n  - index.md\ncovers:\n  - prereq checks\n  - apt on Debian\n  - yum on RHEL\n---\n\n# Linux\n`,
    );
    writeFileSync(
      join(wiki, "installation", "macos.md"),
      `---\nid: macos\ntype: primary\ndepth_role: leaf\nfocus: "installing on macOS"\nparents:\n  - index.md\ncovers:\n  - Homebrew\n  - pkg installer\n---\n\n# macOS\n`,
    );

    rebuildAllIndices(wiki);
    const findings1 = validateWiki(wiki);
    const summary1 = summariseFindings(findings1);
    assert.equal(summary1.errors, 0, `expected 0 errors, got ${JSON.stringify(findings1)}`);

    // Rebuild again — must be byte-identical
    const before = readFileSync(join(wiki, "installation", "index.md"), "utf8");
    rebuildAllIndices(wiki);
    const after = readFileSync(join(wiki, "installation", "index.md"), "utf8");
    assert.equal(before, after, "index-rebuild must be idempotent");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("shape-check detects LIFT for single-child folder", () => {
  const base = tmp();
  const wiki = `${base}.llmwiki.v1`;
  try {
    mkdirSync(join(wiki, "lonely"), { recursive: true });
    writeFileSync(
      join(wiki, "index.md"),
      `---\nid: ${wiki.split("/").pop()}\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "root"\nparents: []\n---\n`,
    );
    writeFileSync(
      join(wiki, "lonely", "index.md"),
      `---\nid: lonely\ntype: index\ndepth_role: category\ndepth: 1\nfocus: "lonely category with one child"\nparents:\n  - ../index.md\n---\n`,
    );
    writeFileSync(
      join(wiki, "lonely", "only.md"),
      `---\nid: only\ntype: primary\ndepth_role: leaf\nfocus: "the only entry"\nparents:\n  - index.md\ncovers:\n  - standalone item\n---\n\n# Only\n`,
    );
    rebuildAllIndices(wiki);
    const suggestions = runShapeCheck(wiki, { threshold: 1 });
    const lift = suggestions.find((s) => s.operator === "LIFT");
    assert.ok(lift, `expected LIFT suggestion, got ${JSON.stringify(suggestions)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("hosted mode: arbitrary directory name is a valid wiki root when layout contract + generator marker are both present", () => {
  const base = tmp();
  const hosted = `${base}-arbitrary-name`;
  const plain = `${base}-plain-with-index`;
  try {
    // Hosted: arbitrary name + layout contract + generator marker → valid
    mkdirSync(hosted, { recursive: true });
    writeFileSync(
      join(hosted, ".llmwiki.layout.yaml"),
      "mode: hosted\nversioning:\n  style: in-place\nlayout: []\n",
    );
    writeFileSync(
      join(hosted, "index.md"),
      `---\nid: ${hosted.split("/").pop()}\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "hosted target"\nparents: []\ngenerator: skill-llm-wiki/v1\nmode: hosted\n---\n`,
    );
    assert.equal(isWikiRoot(hosted), true, "hosted-mode directory with contract + marker must be recognized");

    // Plain: arbitrary name + generator marker but NO layout contract → rejected
    mkdirSync(plain, { recursive: true });
    writeFileSync(
      join(plain, "index.md"),
      `---\nid: plain\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "no contract"\nparents: []\ngenerator: skill-llm-wiki/v1\n---\n`,
    );
    assert.equal(
      isWikiRoot(plain),
      false,
      "arbitrary-name directory without layout contract must be rejected even if it has the marker",
    );
  } finally {
    rmSync(hosted, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("script safety: findEnclosingWiki only matches skill-generated wikis", () => {
  const base = tmp();
  const realWiki = `${base}.llmwiki.v1`;
  const fakeWiki = `${base}-fake.llmwiki.v1`;
  try {
    // Real wiki — built via rebuildAllIndices so the generator marker is written
    mkdirSync(join(realWiki, "cat"), { recursive: true });
    writeFileSync(
      join(realWiki, "index.md"),
      `---\nid: ${realWiki.split("/").pop()}\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "real root"\nparents: []\n---\n`,
    );
    writeFileSync(
      join(realWiki, "cat", "index.md"),
      `---\nid: cat\ntype: index\ndepth_role: category\ndepth: 1\nfocus: "real cat"\nparents:\n  - ../index.md\n---\n`,
    );
    writeFileSync(
      join(realWiki, "cat", "leaf.md"),
      `---\nid: leaf\ntype: primary\ndepth_role: leaf\nfocus: "leaf"\nparents:\n  - index.md\ncovers:\n  - a\n---\n\n# Leaf\n`,
    );
    rebuildAllIndices(realWiki); // this writes the generator marker into root

    // Fake wiki — correct naming and an index.md, but NO marker (not generated by us)
    mkdirSync(fakeWiki, { recursive: true });
    writeFileSync(
      join(fakeWiki, "index.md"),
      `---\nid: fake\ntype: index\ndepth_role: category\ndepth: 0\nfocus: "unrelated folder"\nparents: []\n---\n`,
    );

    // Real wiki is recognized
    assert.equal(isWikiRoot(realWiki), true, "real wiki with marker must be recognized");
    assert.equal(
      findEnclosingWiki(join(realWiki, "cat", "leaf.md")),
      realWiki,
      "findEnclosingWiki should find the real wiki",
    );

    // Fake wiki is NOT recognized
    assert.equal(isWikiRoot(fakeWiki), false, "fake wiki without marker must be ignored");
    assert.equal(
      findEnclosingWiki(join(fakeWiki, "index.md")),
      null,
      "findEnclosingWiki must return null for non-marked folders",
    );
  } finally {
    rmSync(realWiki, { recursive: true, force: true });
    rmSync(fakeWiki, { recursive: true, force: true });
  }
});
