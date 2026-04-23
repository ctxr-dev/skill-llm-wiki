// coexistence.test.mjs — prove that running `build` inside a user git
// repository leaves the user repo byte-identical and exposes only the
// intended files (the wiki content + auto `.gitignore`) to the user's
// git status. The private `.llmwiki/` metadata must be ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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

function tmpDir(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-coex-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function dirHash(root) {
  const h = createHash("sha256");
  function walk(rel) {
    const full = join(root, rel);
    if (!existsSync(full)) return;
    for (const name of readdirSync(full).sort()) {
      const sub = rel ? `${rel}/${name}` : name;
      const full2 = join(root, sub);
      let body;
      try {
        body = readFileSync(full2);
      } catch {
        walk(sub);
        continue;
      }
      h.update(sub);
      h.update("\0");
      h.update(body);
      h.update("\0");
    }
  }
  walk("");
  return h.digest("hex");
}

function userGit(repo, args) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`user git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function runCli(args, cwd) {
  return spawnSync("node", [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_NO_PROMPT: "1",
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
    },
  });
}

test("build inside a user git repo leaves the user repo byte-identical", () => {
  const repo = tmpDir("user-repo");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# project\n");
    userGit(repo, ["add", "README.md"]);
    userGit(repo, ["commit", "-m", "init"]);

    const src = join(repo, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    writeFileSync(join(src, "b.md"), "# b\n");
    userGit(repo, ["add", "docs"]);
    userGit(repo, ["commit", "-m", "add docs"]);

    const gitDirBefore = dirHash(join(repo, ".git"));
    const headBefore = userGit(repo, ["rev-parse", "HEAD"]).trim();
    const reflogBefore = userGit(repo, ["reflog", "--format=%H %s"]);

    const r = runCli(["build", src], repo);
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);

    // User repo state — every metric must be unchanged.
    const gitDirAfter = dirHash(join(repo, ".git"));
    const headAfter = userGit(repo, ["rev-parse", "HEAD"]).trim();
    const reflogAfter = userGit(repo, ["reflog", "--format=%H %s"]);
    assert.equal(gitDirAfter, gitDirBefore, "user .git dir must be untouched");
    assert.equal(headAfter, headBefore);
    assert.equal(reflogAfter, reflogBefore);

    // The sibling wiki exists and has the private git.
    const wiki = join(repo, "docs.wiki");
    assert.ok(existsSync(join(wiki, ".llmwiki", "git", "HEAD")));
    assert.ok(existsSync(join(wiki, ".gitignore")));

    // From the user repo's perspective, `git status --porcelain --ignored`
    // should list:
    //   `?? docs.wiki/`                     (the new wiki is untracked)
    //   `!! docs.wiki/.llmwiki/`             (private metadata is ignored)
    // It must NOT list `.llmwiki/` under the untracked prefix (`??`).
    const status = userGit(repo, [
      "status",
      "--porcelain",
      "--ignored",
      "docs.wiki",
    ]);
    for (const line of status.split(/\r?\n/)) {
      if (!line) continue;
      if (/^\?\?\s.*\.llmwiki/.test(line)) {
        assert.fail(
          `user git listed .llmwiki/ as untracked — wiki-local .gitignore is not working: ${line}`,
        );
      }
    }
    // Sanity: .llmwiki/ must appear under the ignored prefix.
    assert.match(
      status,
      /^!!\s.*\.llmwiki/m,
      ".llmwiki/ must be recognised as ignored by user git",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("INT-08: refuses build on a dirty user git working tree", () => {
  const repo = tmpDir("dirty");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# project\n");
    userGit(repo, ["add", "README.md"]);
    userGit(repo, ["commit", "-m", "init"]);

    // Create `docs` WITHOUT committing → dirty working tree.
    const src = join(repo, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");

    const result = runCli(["build", src, "--json-errors"], repo);
    assert.equal(result.status, 2);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.code, "INT-08");
    assert.match(parsed.error.message, /uncommitted changes/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--accept-dirty overrides INT-08", () => {
  const repo = tmpDir("accept-dirty");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "README.md"), "# project\n");
    userGit(repo, ["add", "README.md"]);
    userGit(repo, ["commit", "-m", "init"]);

    const src = join(repo, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    // No commit — working tree is dirty.

    const result = runCli(["build", src, "--accept-dirty"], repo);
    assert.equal(result.status, 0, `build failed: ${result.stderr}`);

    // The wiki was created despite the dirty working tree.
    assert.ok(existsSync(join(repo, "docs.wiki", ".llmwiki", "git", "HEAD")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("hostile core.autocrlf=input in user repo does not normalise CRLF in wiki commits", () => {
  // B42 regression from the Phase 8 test-gap sweep.
  //
  // The skill's FORCED_CONFIG_FLAGS list includes `core.autocrlf=false`
  // so the skill's private git never transforms line endings. A user
  // who has `core.autocrlf=input` set in their enclosing repo must
  // not see any CRLF→LF conversion in the skill's tracked content,
  // because the skill's subprocess runs under a fresh HOME and
  // GIT_CONFIG_GLOBAL=/dev/null — but the `-c core.autocrlf=false`
  // flag is the authoritative defence.
  //
  // Scenario: seed a CRLF file in the wiki-to-be, run build, then
  // read the blob content via `git show` on the private repo. The
  // bytes must still contain `\r\n`, not `\n`.
  const repo = tmpDir("autocrlf-input");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);
    // Crank autocrlf to the most aggressive line-ending-normalising
    // setting we can plant in the user repo.
    userGit(repo, ["config", "core.autocrlf", "input"]);
    writeFileSync(join(repo, "README.md"), "# project\n");
    userGit(repo, ["add", "README.md"]);
    userGit(repo, ["commit", "-m", "init"]);

    const src = join(repo, "docs");
    mkdirSync(src);
    // Seed multiple CRLF-terminated source files. Flat sources get
    // contained into per-outlier subcategories by the X.11 invariant
    // — the path we assert on is resolved at read-time by searching
    // the tree for `crlf-alpha.md` rather than hard-coding a root
    // path.
    writeFileSync(
      join(src, "crlf-alpha.md"),
      "# CRLF Alpha\r\n\r\nline one with CRLF\r\nline two with CRLF\r\n",
    );
    writeFileSync(
      join(src, "crlf-beta.md"),
      "# CRLF Beta\r\n\r\nbeta line with CRLF\r\n",
    );
    userGit(repo, ["add", "docs"]);
    userGit(repo, ["commit", "-m", "add docs"]);

    const r = runCli(["build", src], repo);
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);

    // The wiki leaves for crlf-* live inside per-outlier
    // subcategories (X.11 containment). Read the blob through the
    // skill's isolated git so we bypass any filesystem-level
    // transformations. The tracked content under HEAD must still
    // contain CRLF byte sequences — regardless of which subcategory
    // X.11 assigned.
    const wiki = join(repo, "docs.wiki");
    // Locate the containment-assigned path for crlf-alpha.md via
    // `git ls-tree` on the private repo.
    const lsTree = spawnSync(
      "git",
      ["ls-tree", "-r", "--name-only", "HEAD"],
      {
        cwd: wiki,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: join(wiki, ".llmwiki", "git"),
          GIT_WORK_TREE: wiki,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    assert.equal(lsTree.status, 0, `git ls-tree failed: ${lsTree.stderr}`);
    const alphaPath = lsTree.stdout
      .split("\n")
      .find((line) => line.endsWith("/crlf-alpha.md") || line === "crlf-alpha.md");
    assert.ok(alphaPath, `crlf-alpha.md not found in tree:\n${lsTree.stdout}`);
    const show = spawnSync(
      "git",
      ["show", `HEAD:${alphaPath}`],
      {
        cwd: wiki,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_DIR: join(wiki, ".llmwiki", "git"),
          GIT_WORK_TREE: wiki,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
    assert.equal(show.status, 0, `git show failed: ${show.stderr}`);
    const content = show.stdout;
    // The body lines we seeded with CRLF must still carry CRLF in
    // the wiki's tracked blob. A regression removing
    // `-c core.autocrlf=false` from the skill's FORCED_CONFIG_FLAGS
    // would replace them with LF and this assertion would fail.
    assert.ok(
      content.includes("\r\n"),
      `wiki leaf content lost CRLF bytes. Got:\n${content.toString("utf8")}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("hostile hooksPath does not affect the skill's build", () => {
  const repo = tmpDir("hostile-hooks");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);

    // Seed + commit fixture content BEFORE planting the hostile
    // hooksPath, so the hook cannot interfere with the fixture setup.
    writeFileSync(join(repo, "README.md"), "# p\n");
    userGit(repo, ["add", "README.md"]);
    userGit(repo, ["commit", "-m", "init"]);
    const src = join(repo, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    userGit(repo, ["add", "docs"]);
    userGit(repo, ["commit", "-m", "docs"]);

    // Working tree is clean — plant the hostile hook OUTSIDE the repo
    // so it doesn't show up as untracked and trip INT-08 on the build.
    // core.hooksPath can point anywhere on disk.
    const hookDir = tmpDir("hostile-hook-dir");
    const sentinel = join(tmpdir(), `coex-sentinel-${Date.now()}.txt`);
    writeFileSync(
      join(hookDir, "pre-commit"),
      `#!/bin/sh\necho "hook fired" > "${sentinel}"\nexit 1\n`,
      { mode: 0o755 },
    );
    userGit(repo, ["config", "core.hooksPath", hookDir]);

    // Now run the skill. Two expectations:
    //   1. Build completes (exit 0).
    //   2. The hostile pre-commit hook never fires — its sentinel
    //      file must not exist afterwards.
    const r = runCli(["build", src], repo);
    assert.equal(r.status, 0, `build failed: ${r.stderr}`);
    assert.equal(
      existsSync(sentinel),
      false,
      "hostile hook must not have fired",
    );
    if (existsSync(sentinel)) rmSync(sentinel);
    rmSync(hookDir, { recursive: true, force: true });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("wiki-local .gitignore prevents user git from tracking .llmwiki/", () => {
  const repo = tmpDir("gitignore-respect");
  try {
    userGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    userGit(repo, ["config", "user.name", "Test"]);
    userGit(repo, ["config", "user.email", "test@example.com"]);

    const src = join(repo, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    // Commit the fixture so the user's working tree is clean before
    // the skill runs (INT-08 would otherwise refuse).
    userGit(repo, ["add", "docs"]);
    userGit(repo, ["commit", "-m", "add docs"]);

    const r = runCli(["build", src], repo);
    assert.equal(r.status, 0, r.stderr);

    // Stage everything the wiki created, then check-ignore `.llmwiki/`.
    userGit(repo, ["add", "-N", "docs.wiki"]);
    const ignored = spawnSync(
      "git",
      ["check-ignore", "-v", "docs.wiki/.llmwiki/git/HEAD"],
      { cwd: repo, encoding: "utf8" },
    );
    // Exit 0 means the path matches an ignore rule.
    assert.equal(
      ignored.status,
      0,
      "user git must recognise .llmwiki/ as ignored via the wiki-local .gitignore",
    );
    assert.match(ignored.stdout, /\.llmwiki/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
