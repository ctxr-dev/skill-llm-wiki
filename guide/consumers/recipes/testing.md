---
id: recipe-testing
type: primary
depth_role: leaf
focus: "Use the shipped testkit in consumer test suites"
parents:
  - ../index.md
tags:
  - testing
  - testkit
  - fixtures
  - consumers
activation:
  keyword_matches:
    - test harness
    - consumer tests
    - testkit
    - stub skill
    - wiki fixture
  tag_matches:
    - testing
    - testkit

generator: "skill-llm-wiki/v1"
---

# Recipe: testing with the shipped testkit

## Trigger

Your consumer has tests that interact with `skill-llm-wiki` (e.g. your installer refuses without the skill present, your wiki-write workflow post-heal classifies verdicts). Use the shipped testkit instead of hand-rolling fixtures.

## Commands to locate the testkit

```bash
skill-llm-wiki where --json | jq -r '.testkit_dir'
```

The returned absolute path contains:

- `stub-skill.mjs` — seed a presence-only skill under `.claude/skills/` or `.agents/skills/`.
- `make-wiki-fixture.mjs` — build a minimal hosted-mode wiki at a temp path using the shipped templates.
- `assert-frontmatter.mjs` — parse a leaf's frontmatter and assert expected fields.
- `cli-run.mjs` — spawn the CLI, capture stdout/stderr/status, auto-parse the envelope.

## Consumer test code

### Presence stub (replaces hand-rolled `wikiSkillStub`)

```js
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubSkill } from "<testkit_dir>/stub-skill.mjs";

test("installer refuses when skill is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "test-"));
  // Do NOT call stubSkill — simulate the absent case.
  const r = await runInstaller({ env: { HOME: home } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skill-llm-wiki is not installed/);
});

test("installer proceeds when stub is present", async () => {
  const home = mkdtempSync(join(tmpdir(), "test-"));
  await stubSkill({ home });
  const r = await runInstaller({ env: { HOME: home } });
  assert.equal(r.status, 0);
});
```

### Fixture wiki (for exercising write workflows)

```js
import { makeWikiFixture } from "<testkit_dir>/make-wiki-fixture.mjs";

test("my consumer writes a report leaf in the right shape", async () => {
  const wiki = await makeWikiFixture({
    path: join(tmpdir(), `reports-${Date.now()}`),
    kind: "dated",
    template: "reports",
    seedLeaves: ["2026/04/18/example.md"],
  });
  // Now drive your consumer write code against `wiki.path`.
  await writeMyLeaf(wiki.path, "2026/04/18/new-report.md", "content");
  assert.ok(existsSync(join(wiki.path, "2026/04/18/new-report.md")));
});
```

### CLI run (for end-to-end verdict-handling tests)

```js
import { runCli } from "<testkit_dir>/cli-run.mjs";

test("heal on a fresh wiki returns verdict=ok", async () => {
  const wiki = await makeWikiFixture({ path: tmpWiki(), kind: "dated" });
  const r = runCli(["heal", wiki.path, "--json"]);
  assert.equal(r.envelope.verdict, "ok");
});
```

### Frontmatter assertions

```js
import { assertFrontmatterShape } from "<testkit_dir>/assert-frontmatter.mjs";

test("my consumer writes the expected frontmatter", async () => {
  await writeMyLeaf(wiki.path, "2026/04/18/leaf.md", "content");
  assertFrontmatterShape(join(wiki.path, "2026/04/18/leaf.md"), {
    type: "primary",
    depth_role: "leaf",
    focus: "leaf",
  });
});
```

## Failure modes

- `testkit_dir` is `null`: you are running against an old skill version without the testkit. Gate on `format_version >= 1` in CI.
- `stubSkill` fails with "unknown layout": pass one of `"claude-skills"` or `"agents-skills"`.
- `makeWikiFixture` fails on the template lookup: pass a name matching one of the shipped templates (see [dated-wiki.md](dated-wiki.md) / [subject-wiki.md](subject-wiki.md)).

## Do not

- Import from `scripts/lib/` in your tests. Those are internal; only `scripts/testkit/` is part of the consumer contract.
- Hand-roll parallel stub helpers once this testkit exists. Drift between your stub and the skill's canonical shape is a real bug source.
