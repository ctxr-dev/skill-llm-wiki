// testkit.test.mjs — smoke-test the consumer testkit helpers.
//
// These modules are what consumers import into their own test
// suites, so their happy path must be rock-solid. Each helper is
// small; the tests exercise the contract once each.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { SKILL_ROOT } from "../../scripts/lib/where.mjs";
import { stubSkill, STUB_SKILL_NAME } from "../../scripts/testkit/stub-skill.mjs";
import { mktmp } from "../helpers/tmp.mjs";
import { makeWikiFixture } from "../../scripts/testkit/make-wiki-fixture.mjs";
import {
  assertFrontmatterShape,
  readLeafFrontmatter,
} from "../../scripts/testkit/assert-frontmatter.mjs";
import { runCli, runCliOk } from "../../scripts/testkit/cli-run.mjs";

const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

// ─── stub-skill ─────────────────────────────────────────────

test("stubSkill seeds SKILL.md under the claude-skills layout", async () => {
  const home = mktmp("stub-claude");
  try {
    const r = await stubSkill({ home });
    assert.equal(r.layout, "claude-skills");
    assert.equal(
      r.dir,
      join(home, ".claude", "skills", STUB_SKILL_NAME),
    );
    assert.ok(existsSync(r.skillMd));
    const body = readFileSync(r.skillMd, "utf8");
    assert.match(body, /^---\nname: skill-llm-wiki/);
    assert.match(body, /format_version: 1/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stubSkill seeds under the agents-skills layout", async () => {
  const home = mktmp("stub-agents");
  try {
    const r = await stubSkill({ home, layout: "agents-skills" });
    assert.equal(
      r.dir,
      join(home, ".agents", "skills", STUB_SKILL_NAME),
    );
    assert.ok(existsSync(r.skillMd));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("stubSkill refuses to write through a symlinked intermediate segment", async () => {
  // A hostile fixture plants `${home}/.claude -> elsewhere`
  // BEFORE stubSkill runs. The recursive mkdir would otherwise
  // follow that symlink and create the stub under the attacker-
  // controlled directory. The segment walker must lstat every
  // intermediate path from home down to the stub directory.
  const home = mktmp("stub-intermediate");
  const elsewhere = mktmp("stub-elsewhere");
  try {
    // Plant the attack: home/.claude is a symlink to elsewhere.
    symlinkSync(elsewhere, join(home, ".claude"), "dir");
    await assert.rejects(
      () => stubSkill({ home }),
      /symbolic link/,
    );
    // Confirm the symlink target was NOT populated.
    assert.equal(existsSync(join(elsewhere, "skills")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("stubSkill rejects unknown layouts", async () => {
  await assert.rejects(
    () => stubSkill({ home: "/tmp/irrelevant", layout: "not-a-layout" }),
    /unknown layout/,
  );
});

// ─── make-wiki-fixture ──────────────────────────────────────

test("makeWikiFixture copies the reports template for kind=dated", async () => {
  const path = join(mktmp("fixture-dated"), "wiki");
  try {
    const r = await makeWikiFixture({ path, kind: "dated" });
    assert.equal(r.template, "reports");
    assert.ok(existsSync(r.contract_path));
    const body = readFileSync(r.contract_path, "utf8");
    assert.match(body, /mode:\s*hosted/);
    assert.match(body, /\{yyyy\}/);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("makeWikiFixture copies the runbooks template for kind=subject", async () => {
  const path = join(mktmp("fixture-subject"), "wiki");
  try {
    const r = await makeWikiFixture({ path, kind: "subject" });
    assert.equal(r.template, "runbooks");
    const body = readFileSync(r.contract_path, "utf8");
    assert.doesNotMatch(body, /dynamic_subdirs:/);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("makeWikiFixture honours explicit --template", async () => {
  const path = join(mktmp("fixture-adrs"), "wiki");
  try {
    const r = await makeWikiFixture({ path, template: "adrs" });
    assert.equal(r.template, "adrs");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("makeWikiFixture refuses a symlinked ancestor on the path TO rootAbs", async () => {
  // Attack: `<tmpRoot>/parent -> elsewhere` exists BEFORE the
  // fixture root (`<tmpRoot>/parent/wiki`) is ever created. A
  // naive `mkdir(rootAbs, {recursive:true})` would follow the
  // symlink and create the fixture under the attacker target.
  // The new ancestor walker catches this before mkdir runs.
  const tmpRoot = mktmp("fixture-ancestor");
  const realTarget = join(tmpRoot, "elsewhere");
  const hostileParent = join(tmpRoot, "parent");
  mkdirSync(realTarget, { recursive: true });
  symlinkSync(realTarget, hostileParent, "dir");
  try {
    await assert.rejects(
      () => makeWikiFixture({ path: join(hostileParent, "wiki"), kind: "dated" }),
      /symbolic link/,
    );
    // Real target remained empty — no fixture was written through the symlink.
    assert.equal(existsSync(join(realTarget, "wiki")), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("makeWikiFixture refuses symlinks in intermediate path segments", async () => {
  // A lexical `..`-traversal check cannot detect this shape: the
  // attacker plants a symlinked sub-directory INSIDE the fixture
  // root, then passes a seed path under it. Every segment along
  // the resolved path must be lstat-checked.
  const root = mktmp("fixture-intermediate-symlink");
  const realTarget = join(root, "elsewhere");
  const fixturePath = join(root, "wiki");
  mkdirSync(realTarget, { recursive: true });
  mkdirSync(fixturePath, { recursive: true });
  const hostileSub = join(fixturePath, "sub");
  // First build the wiki so we have a well-formed contract.
  const fixture = await makeWikiFixture({ path: fixturePath, kind: "dated" });
  assert.ok(fixture);
  // Plant a symlinked sub-dir inside the wiki.
  symlinkSync(realTarget, hostileSub, "dir");
  try {
    await assert.rejects(
      () =>
        makeWikiFixture({
          path: fixturePath,
          kind: "dated",
          seedLeaves: ["sub/inner.md"],
        }),
      /symbolic link/,
    );
    // The real target outside the fixture root was not written to.
    assert.equal(existsSync(join(realTarget, "inner.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeWikiFixture refuses seed-leaf paths that escape the fixture root", async () => {
  const path = join(mktmp("fixture-traversal"), "wiki");
  try {
    await assert.rejects(
      () =>
        makeWikiFixture({
          path,
          kind: "dated",
          seedLeaves: ["../../evil.md"],
        }),
      /resolves outside the fixture root/,
    );
    await assert.rejects(
      () =>
        makeWikiFixture({
          path,
          kind: "dated",
          seedLeaves: [{ path: "/tmp/evil.md", body: "x" }],
        }),
      /must be relative to the fixture root/,
    );
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("makeWikiFixture seeds leaves from strings and objects", async () => {
  const path = join(mktmp("fixture-seed"), "wiki");
  try {
    const r = await makeWikiFixture({
      path,
      kind: "dated",
      seedLeaves: [
        "2026/04/18/example.md",
        { path: "2026/04/19/custom.md", body: "hand-written body" },
      ],
    });
    assert.equal(r.seeded_leaves.length, 2);
    const defaulted = readFileSync(r.seeded_leaves[0], "utf8");
    assert.match(defaulted, /^---\n/);
    assert.match(defaulted, /id: example/);
    const custom = readFileSync(r.seeded_leaves[1], "utf8");
    assert.equal(custom, "hand-written body");
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

// ─── assert-frontmatter ─────────────────────────────────────

test("readLeafFrontmatter parses id, type, depth_role, focus, covers", () => {
  const leaf = join(mktmp("fm-read"), "leaf.md");
  writeFileSync(
    leaf,
    `---
id: my-leaf
type: primary
depth_role: leaf
focus: "hello world"
covers: [alpha, "beta word"]
parents:
  - ../index.md
tags: []
---

body
`,
    "utf8",
  );
  try {
    const data = readLeafFrontmatter(leaf);
    assert.equal(data.id, "my-leaf");
    assert.equal(data.type, "primary");
    assert.equal(data.depth_role, "leaf");
    assert.equal(data.focus, "hello world");
    assert.deepEqual(data.covers, ["alpha", "beta word"]);
    assert.deepEqual(data.parents, ["../index.md"]);
    assert.deepEqual(data.tags, []);
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("readLeafFrontmatter parses CRLF-line-ended frontmatter", () => {
  // Simulates a leaf written on Windows or checked out via git
  // with native line endings. The fence regexes and split must
  // tolerate \r\n transparently.
  const leaf = join(mktmp("fm-crlf"), "leaf.md");
  writeFileSync(
    leaf,
    ["---", "id: crlf-leaf", "type: primary", "depth_role: leaf", 'focus: "crlf"', "---", "", "body", ""].join("\r\n"),
    "utf8",
  );
  try {
    const data = readLeafFrontmatter(leaf);
    assert.equal(data.id, "crlf-leaf");
    assert.equal(data.type, "primary");
    assert.equal(data.focus, "crlf");
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("readLeafFrontmatter throws on missing frontmatter", () => {
  const leaf = join(mktmp("fm-missing"), "leaf.md");
  writeFileSync(leaf, "no frontmatter here\n", "utf8");
  try {
    assert.throws(() => readLeafFrontmatter(leaf), /no frontmatter block/);
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("readLeafFrontmatter parses a nested `source` object", () => {
  // The skill's canonical leaf frontmatter emits `source:` as a
  // one-level-nested object (origin/path/hash). Consumers must be
  // able to inspect those fields, not just see an empty string.
  const leaf = join(mktmp("fm-nested"), "leaf.md");
  writeFileSync(
    leaf,
    `---
id: my-leaf
type: primary
depth_role: leaf
source:
  origin: file
  path: my-leaf.md
  hash: sha256:abc123
focus: "has a nested source"
---

body
`,
    "utf8",
  );
  try {
    const data = readLeafFrontmatter(leaf);
    assert.ok(data.source && typeof data.source === "object");
    assert.equal(data.source.origin, "file");
    assert.equal(data.source.path, "my-leaf.md");
    assert.equal(data.source.hash, "sha256:abc123");
    assert.equal(data.focus, "has a nested source");
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("assertFrontmatterShape compares nested source keys", () => {
  const leaf = join(mktmp("fm-nested-assert"), "leaf.md");
  writeFileSync(
    leaf,
    `---
id: x
source:
  origin: file
  path: x.md
---
`,
    "utf8",
  );
  try {
    // Happy path: matching nested subset.
    assertFrontmatterShape(leaf, {
      id: "x",
      source: { origin: "file", path: "x.md" },
    });
    // Mismatch on a sub-key surfaces the dotted path.
    assert.throws(
      () =>
        assertFrontmatterShape(leaf, {
          source: { origin: "wrong" },
        }),
      /source\.origin: expected "wrong", got "file"/,
    );
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("assertFrontmatterShape passes when expected subset matches", () => {
  const leaf = join(mktmp("fm-assert"), "leaf.md");
  writeFileSync(
    leaf,
    `---
id: x
type: primary
depth_role: leaf
focus: "hi"
---
body
`,
    "utf8",
  );
  try {
    assertFrontmatterShape(leaf, { id: "x", depth_role: "leaf" });
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

test("assertFrontmatterShape throws with a clear message on mismatch", () => {
  const leaf = join(mktmp("fm-mismatch"), "leaf.md");
  writeFileSync(
    leaf,
    `---
id: actual
type: primary
---
`,
    "utf8",
  );
  try {
    assert.throws(
      () => assertFrontmatterShape(leaf, { id: "expected" }),
      /id: expected "expected", got "actual"/,
    );
  } finally {
    rmSync(dirname(leaf), { recursive: true, force: true });
  }
});

// ─── cli-run ────────────────────────────────────────────────

test("runCli returns stdout + status for a plain invocation", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  assert.equal(r.envelope, null);
});

test("runCli parses the envelope when --json is passed", () => {
  const r = runCli(["contract", "--json"]);
  assert.equal(r.status, 0);
  assert.ok(r.envelope);
  assert.equal(r.envelope.schema, "skill-llm-wiki/contract/v1");
  assert.equal(r.envelope.format_version, 1);
});

test("runCliOk throws on a non-zero exit with stderr in the message", () => {
  // Invoke an unknown subcommand to get a non-zero exit.
  assert.throws(
    () => runCliOk(["definitely-not-a-real-subcommand"]),
    /exited/,
  );
});

test("runCli surfaces spawn errors via the error field", () => {
  // Force a spawn failure by pointing at a non-existent working
  // directory. spawnSync returns r.error with ENOENT (macOS/Linux)
  // or similar on Windows. The testkit must expose this to callers
  // rather than silently returning status: null.
  const r = runCli(["--version"], { cwd: "/does/not/exist/anywhere" });
  // Either spawnSync populated r.error, or the child ran and then
  // reported the cwd problem via stderr + non-zero exit — both
  // outcomes are platform-dependent but we must see one of them.
  assert.ok(
    r.error !== null || r.status !== 0,
    `expected a spawn error or non-zero exit, got status=${r.status} error=${r.error}`,
  );
});

test("runCliOk surfaces spawn errors (not just non-zero exits)", () => {
  // We can't easily force a true spawn ENOENT against process.execPath
  // without renaming node, but we can assert the error-field code path
  // still throws a descriptive message when cwd doesn't exist.
  assert.throws(
    () => runCliOk(["--version"], { cwd: "/does/not/exist/anywhere" }),
    /spawn|exited/,
  );
});

test("runCli result includes the error field (even when null)", () => {
  const r = runCli(["--version"]);
  assert.ok("error" in r, "runCli result must include an `error` field");
  assert.equal(r.error, null, "clean run should have error: null");
});

// ─── CLI shorthand: `testkit-stub --at <dir>` ───────────────

test("`testkit-stub --at <dir>` seeds a stub install", () => {
  const home = mktmp("shorthand");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "testkit-stub", "--at", home],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `testkit-stub exited ${r.status}: ${r.stderr}`);
    const expected = join(home, ".claude", "skills", STUB_SKILL_NAME, "SKILL.md");
    assert.equal(r.stdout.trim(), expected);
    assert.ok(existsSync(expected));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`testkit-stub --at <dir> --layout agents-skills` respects the layout flag", () => {
  const home = mktmp("shorthand-agents");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "testkit-stub", "--at", home, "--layout", "agents-skills"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0);
    // Compare by path.join so the test is platform-agnostic —
    // Windows uses "\" as a separator, POSIX uses "/". An
    // `includes(".agents/skills")` check fails on Windows runners.
    const expected = join(home, ".agents", "skills", STUB_SKILL_NAME, "SKILL.md");
    assert.equal(r.stdout.trim(), expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`testkit-stub` is exempt from the runtime-dep preflight", () => {
  const home = mktmp("shorthand-nodep");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "testkit-stub", "--at", home],
      {
        encoding: "utf8",
        env: { ...process.env, LLM_WIKI_TEST_FORCE_DEPS_MISSING: "gray-matter" },
      },
    );
    assert.equal(r.status, 0, `should succeed with forced missing dep: ${r.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
