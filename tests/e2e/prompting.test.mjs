// prompting.test.mjs — walk the CLI through every ambiguity scenario and
// verify each exits 2 with a machine-parseable JSON error when
// `--json-errors` is passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function parentDir(tag) {
  const dir = join(
    tmpdir(),
    `skill-llm-wiki-prompt-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function plantManagedWiki(dir) {
  mkdirSync(join(dir, ".llmwiki", "git"), { recursive: true });
  writeFileSync(join(dir, ".llmwiki", "git", "HEAD"), "ref: main\n");
  writeFileSync(
    join(dir, "index.md"),
    "---\ngenerator: skill-llm-wiki/v1\nid: root\ntype: index\ndepth_role: category\nfocus: root\n---\n\n",
  );
}

test("INT-06: build with no positional", () => {
  const r = runCli(["build", "--json-errors"]);
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stderr);
  assert.equal(parsed.error.code, "INT-06");
});

test("INT-10: unknown --layout-mode value", () => {
  const parent = parentDir("int10");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli([
      "build",
      src,
      "--layout-mode",
      "sideways",
      "--json-errors",
    ]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-10");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-09a: --layout-mode in-place + --target", () => {
  const parent = parentDir("int09a");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli([
      "build",
      src,
      "--layout-mode",
      "in-place",
      "--target",
      join(parent, "other"),
      "--json-errors",
    ]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-09a");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-09b: --layout-mode hosted without --target", () => {
  const parent = parentDir("int09b");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli([
      "build",
      src,
      "--layout-mode",
      "hosted",
      "--json-errors",
    ]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-09b");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-11: empty --flag=value rejected", () => {
  const parent = parentDir("int11-empty");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli(["build", src, "--layout-mode=", "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-11");
    assert.match(parsed.error.message, /non-empty value/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-11: --flag with no value rejected", () => {
  const parent = parentDir("int11-missing");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli(["build", src, "--target", "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-11");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-05: rollback without --to", () => {
  const parent = parentDir("int05");
  try {
    const wiki = join(parent, "docs.wiki");
    mkdirSync(wiki);
    plantManagedWiki(wiki);
    const r = runCli(["rollback", wiki, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-05");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-07: multi-source build", () => {
  const parent = parentDir("int07");
  try {
    const a = join(parent, "docs");
    const b = join(parent, "specs");
    mkdirSync(a);
    mkdirSync(b);
    const r = runCli(["build", a, b, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-07");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-04: legacy .llmwiki.vN folder", () => {
  const parent = parentDir("int04");
  try {
    const legacy = join(parent, "docs.llmwiki.v2");
    mkdirSync(legacy);
    const r = runCli(["build", legacy, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-04");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-02: implicit in-place on a managed wiki", () => {
  const parent = parentDir("int02");
  try {
    const wiki = join(parent, "already");
    mkdirSync(wiki);
    plantManagedWiki(wiki);
    const r = runCli(["build", wiki, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-02");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-01: default sibling target collides with foreign directory", () => {
  const parent = parentDir("int01");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const foreign = join(parent, "docs.wiki");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "unrelated.md"), "foreign\n");
    const r = runCli(["build", src, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-01");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-01b: --target at a foreign non-empty directory", () => {
  const parent = parentDir("int01b");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    const foreign = join(parent, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "unrelated.txt"), "not a wiki\n");
    const r = runCli([
      "build",
      src,
      "--layout-mode",
      "hosted",
      "--target",
      foreign,
      "--json-errors",
    ]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-01b");
    assert.match(
      parsed.error.resolving_flag,
      /accept-foreign-target/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-03: build against an existing managed wiki", () => {
  const parent = parentDir("int03");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    const target = join(parent, "docs.wiki");
    mkdirSync(target);
    plantManagedWiki(target);
    const r = runCli(["build", src, "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    // INT-03 surfaces when the DEFAULT sibling is already a managed wiki;
    // the user should pick extend / rebuild / fix instead.
    assert.equal(parsed.error.code, "INT-03");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("rebuild --review in non-interactive mode falls through (does not fire INT-12)", () => {
  // INT-12 is the cli.mjs safety net for a NonInteractiveError
  // escaping runOperation. The `rebuild --review` path is the only
  // code that currently uses interactive prompts, and by design it
  // CATCHES the NonInteractiveError internally and returns
  // `outcome: "non-interactive"` instead of propagating. This test
  // pins that contract: a CI invocation of rebuild --review must
  // succeed (non-interactive fallthrough), NOT hit INT-12. A
  // regression that removed the catch in runReviewCycle would flip
  // this behaviour and the test would catch it.
  const parent = parentDir("review-non-tty");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(join(src, "alpha.md"), "# Alpha\n\nalpha content\n");
    writeFileSync(join(src, "beta.md"), "# Beta\n\nbeta content\n");
    const build = runCli(["build", src], {
      env: { LLM_WIKI_MOCK_TIER1: "1" },
    });
    assert.equal(build.status, 0, `build failed: ${build.stderr}`);
    const wiki = join(parent, "corpus.wiki");
    const r = runCli(["rebuild", wiki, "--review"], {
      env: { LLM_WIKI_MOCK_TIER1: "1" },
    });
    // Must succeed (rebuild --review in CI just approves automatically)
    // OR exit 2 with a non-INT-12 validation diagnostic. INT-12 would
    // be a genuine regression.
    assert.ok(
      !/INT-12/.test(r.stderr),
      `rebuild --review in non-TTY must not fire INT-12; got stderr:\n${r.stderr}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("INT-13: unknown --quality-mode value", () => {
  const parent = parentDir("int13");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# a\n");
    const r = runCli([
      "build",
      src,
      "--quality-mode",
      "lightning-fast",
      "--json-errors",
    ]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-13");
    assert.match(parsed.error.message, /unknown --quality-mode/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("unknown flag surfaces INT-11", () => {
  const parent = parentDir("unknown-flag");
  try {
    const src = join(parent, "docs");
    mkdirSync(src);
    const r = runCli(["build", src, "--bogus", "--json-errors"]);
    assert.equal(r.status, 2);
    const parsed = JSON.parse(r.stderr);
    assert.equal(parsed.error.code, "INT-11");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("text-mode error output is human-readable", () => {
  const r = runCli(["build"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /error:/);
  assert.match(r.stderr, /INT-06/);
  assert.match(r.stderr, /Disambiguating flag:/);
});

test("--help writes to stdout (not stderr) and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skill-llm-wiki CLI v/);
  assert.match(r.stdout, /Top-level operations:/);
  assert.equal(r.stderr, "");
});

test("empty invocation writes usage to stderr and exits 1", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skill-llm-wiki CLI v/);
  assert.equal(r.stdout, "");
});
