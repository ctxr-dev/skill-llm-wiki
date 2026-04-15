// multi-op-rollback.test.mjs — B33/B46 regression.
//
// Runs Build → Rebuild against a wiki, then rolls back to the first
// op's `pre-op/<id>` tag and asserts the tree state matches what was
// present immediately before the first op. The load-bearing claim is
// "any op is reversible to its pre-op anchor, no matter how many ops
// came after it". A regression that re-uses the same tag across ops,
// or that forgets to preserve prior pre-op tags, would be caught
// here.

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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gitRun } from "../../scripts/lib/git.mjs";

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
      LLM_WIKI_MOCK_TIER1: "1",
      ...(opts.env || {}),
    },
  });
}

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-multi-rb-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("rollback across Build→Rebuild to the first op's pre-op anchor restores pre-build state", () => {
  const parent = tmpParent("buildrebuild");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(join(src, "alpha.md"), "# Alpha\n\nalpha prose\n");
    writeFileSync(join(src, "beta.md"), "# Beta\n\nbeta prose\n");

    const build = runCli(["build", src]);
    assert.equal(build.status, 0, `build failed: ${build.stderr}`);
    const wiki = join(parent, "corpus.wiki");
    assert.ok(existsSync(wiki));

    // Capture the build's pre-op tag SHA so we can assert the
    // rollback target is the exact anchor we want.
    const opLogBefore = readFileSync(
      join(wiki, ".llmwiki", "op-log.yaml"),
      "utf8",
    );
    const buildOpIdMatch = /op_id: (build-\S+)/.exec(opLogBefore);
    assert.ok(buildOpIdMatch, `no build op-id in op-log:\n${opLogBefore}`);
    const buildOpId = buildOpIdMatch[1];
    const preBuildSha = gitRun(wiki, [
      "rev-parse",
      `pre-op/${buildOpId}`,
    ]).stdout.trim();
    assert.match(preBuildSha, /^[a-f0-9]{40}$/);

    // Second op: Rebuild. After rebuild, the working tree reflects
    // rebuild's result but the pre-op/<buildOpId> anchor still exists.
    const rebuild = runCli(["rebuild", wiki]);
    assert.equal(rebuild.status, 0, `rebuild failed: ${rebuild.stderr}`);

    // Verify we now have two pre-op tags: one for build, one for rebuild.
    const tagList = gitRun(wiki, ["tag", "-l"]).stdout;
    assert.match(tagList, new RegExp(`pre-op/${buildOpId}`));
    assert.match(tagList, /pre-op\/rebuild-/);

    // Rollback to the BUILD's pre-op tag (not rebuild's).
    const rollback = runCli([
      "rollback",
      wiki,
      "--to",
      `pre-${buildOpId}`,
    ]);
    assert.equal(rollback.status, 0, `rollback failed: ${rollback.stderr}`);

    // HEAD should now point at the same commit as pre-op/<buildOpId>.
    const headSha = gitRun(wiki, ["rev-parse", "HEAD"]).stdout.trim();
    assert.equal(
      headSha,
      preBuildSha,
      "HEAD after rollback must equal the build's pre-op anchor",
    );

    // Working tree is the pre-build snapshot — which was EMPTY
    // (first op on a fresh directory). So there should be no
    // wiki-content files at all except the auto-generated
    // `.gitignore` that `snapshot.mjs::preOpSnapshot` writes
    // BEFORE taking the snapshot commit.
    assert.ok(!existsSync(join(wiki, "index.md")));
    // Flat sources land at the wiki root, not under a `general/` bucket.
    assert.ok(!existsSync(join(wiki, "alpha.md")));
    assert.ok(!existsSync(join(wiki, "beta.md")));
    // The pre-op commit itself tracks the .gitignore (see
    // snapshot.mjs) so it IS reachable in the working tree after
    // the reset.
    assert.ok(existsSync(join(wiki, ".gitignore")));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
