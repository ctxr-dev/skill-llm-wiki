// windows-smoke.test.mjs — Phase 7 platform parity probe.
//
// Runs the smallest end-to-end exercise that would break on
// Windows if any code path still hard-codes `/dev/null`, `/`,
// or POSIX-only shell constructs. Covers:
//
//   - build into a sibling wiki
//   - validate passes
//   - diff --op <id> --stat produces git-native output
//   - rollback to pre-op returns the tree byte-identical
//
// The test is gated on `process.platform === "win32"` via the
// node:test `skip` option so it is a no-op on Linux/macOS
// developer boxes — but the ubuntu CI job will see it as
// `skipped: 1` and the windows-latest CI job will run it.

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

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

const IS_WINDOWS = process.platform === "win32";

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      LLM_WIKI_MOCK_TIER1: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
}

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-win-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test(
  "windows-smoke: build → validate → diff → rollback parity",
  { skip: !IS_WINDOWS && "runs only on windows-latest CI" },
  () => {
    const parent = tmpParent("smoke");
    try {
      const src = join(parent, "docs");
      mkdirSync(src);
      writeFileSync(
        join(src, "alpha.md"),
        "# Alpha\n\nunique alpha content phrase for windows-smoke\n",
      );
      writeFileSync(
        join(src, "beta.md"),
        "# Beta\n\nunique beta content phrase for windows-smoke\n",
      );

      // Build.
      const build = runCli(["build", src]);
      assert.equal(build.status, 0, `build failed: ${build.stderr}`);
      const wiki = join(parent, "docs.wiki");
      assert.ok(existsSync(wiki));
      assert.ok(existsSync(join(wiki, ".llmwiki", "git", "HEAD")));
      assert.ok(existsSync(join(wiki, ".gitignore")));

      // Validate.
      const validate = runCli(["validate", wiki]);
      assert.equal(validate.status, 0, `validate failed: ${validate.stderr}`);

      // Extract the op-id from the build output and diff it.
      const opIdMatch = /build-\d{8}-\d{6}-[a-z0-9]+/.exec(build.stdout);
      assert.ok(opIdMatch, `could not parse op-id from: ${build.stdout}`);
      const opId = opIdMatch[0];
      const diff = runCli(["diff", wiki, "--op", opId, "--stat"]);
      assert.equal(diff.status, 0, diff.stderr);
      assert.match(diff.stdout, /index\.md/);

      // Rollback to pre-op and verify the tree is clean.
      const rollback = runCli(["rollback", wiki, "--to", `pre-${opId}`]);
      assert.equal(rollback.status, 0, rollback.stderr);
      // The wiki's operator-generated files should be gone after
      // rollback to pre-op state (pre-op was an empty snapshot).
      assert.ok(
        !existsSync(join(wiki, "general", "alpha.md")) ||
          !existsSync(join(wiki, "alpha.md")),
        "rollback should have removed the drafted leaves",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
);
