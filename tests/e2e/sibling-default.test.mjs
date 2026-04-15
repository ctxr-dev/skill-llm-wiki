// sibling-default.test.mjs — exercise the default `<source>.wiki` path
// from the real CLI entry-point, proving:
//   1. `build ./docs` creates `./docs.wiki/` with `.llmwiki/git/`.
//   2. A second `build` on the same source exits 2 with INT-03.
//   3. `rebuild ./docs.wiki` succeeds (treats the wiki as existing).
//   4. The target is NEVER named `.llmwiki.v1/` — legacy naming is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

function freshParent(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-sib-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("build ./docs creates ./docs.wiki with .llmwiki/git/", () => {
  const parent = freshParent("build-default");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# alpha\n");
    writeFileSync(join(src, "b.md"), "# beta\n");

    const r = runCli(["build", src]);
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);

    const target = join(parent, "docs.wiki");
    assert.ok(existsSync(target), "sibling wiki dir must exist");
    assert.ok(
      existsSync(join(target, ".llmwiki", "git", "HEAD")),
      "private git repo must be initialised",
    );
    assert.ok(
      existsSync(join(target, ".gitignore")),
      "wiki-local .gitignore must be written",
    );
    // Target must NOT be named with legacy versioning.
    for (const name of readdirSync(parent)) {
      assert.ok(
        !/\.llmwiki\.v\d+$/.test(name),
        `unexpected legacy-named folder: ${name}`,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("second build on same source exits 2 with INT-03", () => {
  const parent = freshParent("collision");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# alpha\n");

    const first = runCli(["build", src]);
    assert.equal(first.status, 0, `first build failed: ${first.stderr}`);

    const second = runCli(["build", src, "--json-errors"]);
    assert.equal(second.status, 2);
    const parsed = JSON.parse(second.stderr);
    assert.equal(parsed.error.code, "INT-03");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rebuild on an existing managed wiki succeeds", () => {
  const parent = freshParent("rebuild-happy");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# alpha\n");

    const build = runCli(["build", src]);
    assert.equal(build.status, 0, build.stderr);

    const wiki = join(parent, "docs.wiki");
    const rebuild = runCli(["rebuild", wiki]);
    assert.equal(rebuild.status, 0, `rebuild failed: ${rebuild.stderr}`);
    assert.ok(rebuild.stdout.includes("rebuild:"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
