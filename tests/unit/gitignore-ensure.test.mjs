// gitignore-ensure.test.mjs — idempotent write + merge behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  REQUIRED_GITIGNORE_ENTRIES,
  ensureWikiGitignore,
} from "../../scripts/lib/gitignore.mjs";

function freshWiki(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-gi-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("creates .gitignore when absent", () => {
  const wiki = freshWiki("absent");
  try {
    const r = ensureWikiGitignore(wiki);
    assert.equal(r.created, true);
    assert.equal(r.updated, false);
    const body = readFileSync(join(wiki, ".gitignore"), "utf8");
    for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
      assert.ok(body.includes(entry), `missing entry ${entry}`);
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("idempotent — running twice leaves the file unchanged", () => {
  const wiki = freshWiki("idemp");
  try {
    ensureWikiGitignore(wiki);
    const firstBody = readFileSync(join(wiki, ".gitignore"), "utf8");
    const r = ensureWikiGitignore(wiki);
    assert.equal(r.created, false);
    assert.equal(r.updated, false);
    assert.equal(r.added.length, 0);
    const secondBody = readFileSync(join(wiki, ".gitignore"), "utf8");
    assert.equal(secondBody, firstBody);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("merges into a pre-existing user .gitignore without duplication", () => {
  const wiki = freshWiki("merge");
  try {
    writeFileSync(
      join(wiki, ".gitignore"),
      ["# user entries", "node_modules/", "*.log", ""].join("\n"),
      "utf8",
    );
    const r = ensureWikiGitignore(wiki);
    assert.equal(r.created, false);
    assert.equal(r.updated, true);
    assert.deepEqual(r.added, [...REQUIRED_GITIGNORE_ENTRIES]);
    const body = readFileSync(join(wiki, ".gitignore"), "utf8");
    // User entries preserved.
    assert.ok(body.includes("node_modules/"));
    assert.ok(body.includes("*.log"));
    // Skill entries appended with a marker comment.
    assert.ok(body.includes("# skill-llm-wiki additions"));
    for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
      assert.ok(body.includes(entry));
    }
    // Re-run must not duplicate.
    ensureWikiGitignore(wiki);
    const body2 = readFileSync(join(wiki, ".gitignore"), "utf8");
    const occurrences = body2
      .split(/\r?\n/)
      .filter((l) => l.trim() === ".llmwiki/").length;
    assert.equal(occurrences, 1, ".llmwiki/ entry must appear exactly once");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("merges only the missing entries when the file has some of them", () => {
  const wiki = freshWiki("partial");
  try {
    writeFileSync(
      join(wiki, ".gitignore"),
      ["# user", ".llmwiki/", ""].join("\n"),
      "utf8",
    );
    const r = ensureWikiGitignore(wiki);
    assert.equal(r.updated, true);
    // .llmwiki/ already present, so only two new entries.
    assert.deepEqual(r.added, [".work/", ".shape/history/*/work/"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
