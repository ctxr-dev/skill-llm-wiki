// snapshot-rollback.test.mjs — prove that a pre-op snapshot + rollback
// cycle returns the working tree byte-for-byte to its pre-op state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { preOpSnapshot } from "../../scripts/lib/snapshot.mjs";
import { rollbackOperation } from "../../scripts/lib/rollback.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Compute a deterministic hash of the tracked files in a directory (excluding
// .llmwiki/ which carries skill metadata). Used to prove byte-identical state.
function treeHash(root) {
  const entries = [];
  function walk(rel) {
    const full = join(root, rel);
    for (const name of readdirSync(full).sort()) {
      if (rel === "" && name === ".llmwiki") continue;
      const sub = rel ? join(rel, name) : name;
      const st = statSync(join(root, sub));
      if (st.isDirectory()) {
        walk(sub);
      } else {
        entries.push([sub, readFileSync(join(root, sub))]);
      }
    }
  }
  walk("");
  const h = createHash("sha256");
  for (const [path, body] of entries) {
    h.update(path);
    h.update("\0");
    h.update(body);
    h.update("\0");
  }
  return h.digest("hex");
}

test("snapshot then rollback returns working tree byte-identical", () => {
  const wiki = tmpWiki("snap");
  try {
    // Seed 5 files of varied sizes.
    writeFileSync(join(wiki, "a.md"), "# Alpha\n\nContent of a.\n");
    writeFileSync(join(wiki, "b.md"), "# Beta\n\nContent of b.\n");
    mkdirSync(join(wiki, "sub"), { recursive: true });
    writeFileSync(join(wiki, "sub", "c.md"), "# Gamma\n\nContent of c.\n");
    writeFileSync(join(wiki, "sub", "d.md"), "# Delta\n\nContent of d.\n");
    writeFileSync(
      join(wiki, "big.md"),
      "# Big\n\n" + "x".repeat(5000) + "\n",
    );

    const snap = preOpSnapshot(wiki, "test-op-1");
    assert.equal(snap.tag, "pre-op/test-op-1");

    // "pre-op state" means "working tree at the moment the snapshot was
    // taken", which includes the auto-generated wiki-local .gitignore.
    // Hash AFTER preOpSnapshot so the rollback target matches.
    const beforeHash = treeHash(wiki);

    // Simulate an in-flight operation mutating and deleting files.
    writeFileSync(join(wiki, "a.md"), "MUTATED\n");
    rmSync(join(wiki, "b.md"));
    writeFileSync(join(wiki, "new-file.md"), "created during op\n");
    mkdirSync(join(wiki, "sub2"), { recursive: true });
    writeFileSync(join(wiki, "sub2", "e.md"), "newly nested\n");

    const mutatedHash = treeHash(wiki);
    assert.notEqual(beforeHash, mutatedHash);

    rollbackOperation(wiki, "pre-test-op-1");
    const afterHash = treeHash(wiki);
    assert.equal(
      afterHash,
      beforeHash,
      "rollback must return the tree to its pre-op state byte-for-byte",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("snapshot is idempotent on a clean tree", () => {
  const wiki = tmpWiki("idempotent");
  try {
    writeFileSync(join(wiki, "only.md"), "single file\n");
    const s1 = preOpSnapshot(wiki, "op-a");
    const s2 = preOpSnapshot(wiki, "op-b");
    assert.equal(s1.tag, "pre-op/op-a");
    assert.equal(s2.tag, "pre-op/op-b");
    // Second snapshot on a clean tree should not create a new commit
    // (working tree matches HEAD); only a new tag on HEAD.
    assert.equal(s2.committed, false);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("genesis tag is created on first snapshot", () => {
  const wiki = tmpWiki("genesis");
  try {
    // Even an empty wiki directory gets a genesis commit.
    preOpSnapshot(wiki, "first");
    rollbackOperation(wiki, "genesis"); // must not throw
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
