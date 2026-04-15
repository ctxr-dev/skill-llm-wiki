// invariants-phase4.test.mjs — end-to-end checks for GIT-01 and LOSS-01.
//
// Both invariants are guarded: they run only when their underlying
// artifacts exist. We exercise both the happy path (a freshly-built
// wiki passes) and the failure path (a tampered repo / tampered
// provenance triggers the error) to make sure the guards do not
// silently suppress real failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
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
    `skill-llm-wiki-inv-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function seedBuild(tag) {
  const parent = tmpParent(tag);
  const src = join(parent, "corpus");
  mkdirSync(src);
  writeFileSync(join(src, "alpha.md"), "# alpha\n\nalpha body\n");
  writeFileSync(join(src, "beta.md"), "# beta\n\nbeta body\n");
  const r = runCli(["build", src]);
  if (r.status !== 0) throw new Error(`seed build failed: ${r.stderr}`);
  return { parent, wiki: join(parent, "corpus.wiki") };
}

test("GIT-01 + LOSS-01 pass on a freshly-built wiki", () => {
  const { parent, wiki } = seedBuild("happy");
  try {
    const v = runCli(["validate", wiki]);
    assert.equal(v.status, 0, `validate failed: ${v.stdout}${v.stderr}`);
    // Both codes are in the validator output when they fire; absence
    // of "GIT-01" / "LOSS-01" in the error stream is the signal that
    // the invariants passed. The summary line confirms zero errors.
    assert.match(v.stdout, /0 error/);
    assert.doesNotMatch(v.stdout, /ERR.*GIT-01/);
    assert.doesNotMatch(v.stdout, /ERR.*LOSS-01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("LOSS-01 fires when provenance.yaml has an uncovered tail", () => {
  const { parent, wiki } = seedBuild("loss01");
  try {
    // Mutate provenance.yaml: clip the second source entry's byte
    // range so the tail of the source is no longer covered.
    const provPath = join(wiki, ".llmwiki", "provenance.yaml");
    const raw = readFileSync(provPath, "utf8");
    // The alpha.md and beta.md leaves each cover [0, N]. Replace
    // the first occurrence of `byte_range: [0, ` with a half-range.
    const mutated = raw.replace(
      /byte_range: \[0, (\d+)\]/,
      (_m, n) => `byte_range: [0, ${Math.max(1, Math.floor(Number(n) / 2))}]`,
    );
    assert.notEqual(mutated, raw, "fixture mutation failed");
    writeFileSync(provPath, mutated);

    const v = runCli(["validate", wiki]);
    assert.notEqual(v.status, 0, "LOSS-01 must fire when coverage is broken");
    assert.match(v.stdout, /LOSS-01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("LOSS-01 is skipped when .llmwiki/provenance.yaml is absent", () => {
  const { parent, wiki } = seedBuild("loss01-absent");
  try {
    rmSync(join(wiki, ".llmwiki", "provenance.yaml"));
    const v = runCli(["validate", wiki]);
    assert.equal(v.status, 0, `validate failed: ${v.stdout}${v.stderr}`);
    assert.doesNotMatch(v.stdout, /ERR.*LOSS-01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("GIT-01 fires when the pre-op tag for the latest op is missing", () => {
  const { parent, wiki } = seedBuild("git01-pre");
  try {
    // Read the latest op from op-log, then delete its pre-op tag.
    const opLog = readFileSync(join(wiki, ".llmwiki", "op-log.yaml"), "utf8");
    const opIdMatch = /- op_id: (\S+)/.exec(opLog);
    assert.ok(opIdMatch, `could not extract op_id from op-log: ${opLog}`);
    const opId = opIdMatch[1];
    // Delete the pre-op tag via raw git (we are inspecting the private
    // repo, still using the isolation env by going through the skill's
    // own git.mjs helpers is cleaner, but for a tampering test the
    // direct subprocess is simpler).
    const del = spawnSync(
      "git",
      [
        `--git-dir=${join(wiki, ".llmwiki", "git")}`,
        `--work-tree=${wiki}`,
        "tag",
        "-d",
        `pre-op/${opId}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(del.status, 0, `tag -d failed: ${del.stderr}`);

    const v = runCli(["validate", wiki]);
    assert.notEqual(v.status, 0, "GIT-01 must fire on missing pre-op tag");
    assert.match(v.stdout, /GIT-01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("GIT-01 is skipped when .llmwiki/git/ is absent", () => {
  const parent = tmpParent("git01-absent");
  try {
    // Build a wiki by hand that has a valid frontmatter marker but no
    // private git repo. This mimics a pre-Phase-1 legacy wiki.
    const wiki = join(parent, "hand.wiki");
    mkdirSync(wiki);
    writeFileSync(
      join(wiki, ".llmwiki.layout.yaml"),
      "version: 1\n",
    );
    // index.md id must match the directory basename — `hand.wiki` in
    // our fixture — for ID-MISMATCH-DIR not to fire.
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: hand.wiki\ntype: index\ndepth_role: category\nfocus: hand-built\ngenerator: skill-llm-wiki/v1\n---\n\n",
    );
    const v = runCli(["validate", wiki]);
    assert.equal(
      v.status,
      0,
      `validate must pass without private git: ${v.stdout}${v.stderr}`,
    );
    assert.doesNotMatch(v.stdout, /ERR.*GIT-01/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
