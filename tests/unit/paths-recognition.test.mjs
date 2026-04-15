// paths-recognition.test.mjs — verify isWikiRoot, hasPrivateGit, and
// isLegacyVersionedWiki against a temp directory matrix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isWikiRoot,
  hasPrivateGit,
  isLegacyVersionedWiki,
} from "../../scripts/lib/paths.mjs";

function freshDir(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-paths-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withMarker(indexMdContent = "") {
  return `---\ngenerator: skill-llm-wiki/v1\nid: root\ntype: index\ndepth_role: category\nfocus: "root"\n---\n\n${indexMdContent}`;
}

test("isWikiRoot recognises a directory with private git + marker", () => {
  const wiki = freshDir("private-git");
  try {
    mkdirSync(join(wiki, ".llmwiki", "git"), { recursive: true });
    writeFileSync(join(wiki, ".llmwiki", "git", "HEAD"), "ref: main\n");
    writeFileSync(join(wiki, "index.md"), withMarker());
    assert.equal(isWikiRoot(wiki), true);
    assert.equal(hasPrivateGit(wiki), true);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("isWikiRoot still recognises legacy .llmwiki.vN naming", () => {
  const parent = freshDir("legacy");
  const wiki = join(parent, "docs.llmwiki.v1");
  try {
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "index.md"), withMarker());
    assert.equal(isWikiRoot(wiki), true);
    assert.equal(isLegacyVersionedWiki(wiki), true);
    assert.equal(hasPrivateGit(wiki), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("isWikiRoot recognises hosted mode (layout.yaml + marker)", () => {
  const wiki = freshDir("hosted");
  try {
    writeFileSync(join(wiki, ".llmwiki.layout.yaml"), "version: 1\n");
    writeFileSync(join(wiki, "index.md"), withMarker());
    assert.equal(isWikiRoot(wiki), true);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("isWikiRoot rejects a directory without the generator marker", () => {
  const wiki = freshDir("no-marker");
  try {
    mkdirSync(join(wiki, ".llmwiki", "git"), { recursive: true });
    writeFileSync(join(wiki, ".llmwiki", "git", "HEAD"), "ref: main\n");
    writeFileSync(join(wiki, "index.md"), "---\nid: x\n---\n");
    assert.equal(isWikiRoot(wiki), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("isWikiRoot rejects a bare directory", () => {
  const wiki = freshDir("bare");
  try {
    assert.equal(isWikiRoot(wiki), false);
    assert.equal(hasPrivateGit(wiki), false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("isLegacyVersionedWiki positive and negative", () => {
  assert.equal(isLegacyVersionedWiki("/tmp/docs.llmwiki.v1"), true);
  assert.equal(isLegacyVersionedWiki("/tmp/docs.llmwiki.v42"), true);
  assert.equal(isLegacyVersionedWiki("/tmp/docs.wiki"), false);
  assert.equal(isLegacyVersionedWiki("/tmp/docs"), false);
});
