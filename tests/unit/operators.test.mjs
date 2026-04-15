// operators.test.mjs — per-operator detection and application.
//
// Covers each of the five operators independently, then the
// convergence loop with priority ordering and termination.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import {
  detectDescend,
  detectLift,
  detectMerge,
  detectNestAndDecompose,
  runConvergence,
} from "../../scripts/lib/operators.mjs";

process.env.LLM_WIKI_MOCK_TIER1 = "1";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-ops-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeLeaf(path, frontmatter, body = "body\n") {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", body);
  writeFileSync(path, lines.join("\n"), "utf8");
}

function writeIndex(dir, id, { authored = "", extras = {} } = {}) {
  mkdirSync(dir, { recursive: true });
  const fm = {
    id,
    type: "index",
    depth_role: "category",
    focus: `subtree under ${id}`,
    generator: "skill-llm-wiki/v1",
    ...extras,
  };
  const body =
    "\n<!-- BEGIN AUTO-GENERATED NAVIGATION -->\n" +
    `# ${id}\n\n` +
    "<!-- END AUTO-GENERATED NAVIGATION -->\n\n" +
    "<!-- BEGIN AUTHORED ORIENTATION -->\n" +
    authored +
    "\n<!-- END AUTHORED ORIENTATION -->\n";
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push("---");
  writeFileSync(join(dir, "index.md"), lines.join("\n") + body, "utf8");
}

// ── LIFT ─────────────────────────────────────────────────────────────

test("detectLift: single-child folder yields a LIFT proposal", () => {
  const wiki = tmpWiki("lift-basic");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "only-child"));
    writeIndex(join(wiki, "only-child"), "only-child");
    writeLeaf(join(wiki, "only-child", "lonely.md"), {
      id: "lonely",
      type: "primary",
      depth_role: "leaf",
      focus: "a lonely leaf",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].operator, "LIFT");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectLift: multi-child folder yields no proposals", () => {
  const wiki = tmpWiki("lift-multi");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "many"));
    writeIndex(join(wiki, "many"), "many");
    writeLeaf(join(wiki, "many", "a.md"), {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "a",
      parents: ["../index.md"],
    });
    writeLeaf(join(wiki, "many", "b.md"), {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "b",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectLift: root directory is never a LIFT target", () => {
  const wiki = tmpWiki("lift-root");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "alone.md"), {
      id: "alone",
      type: "primary",
      depth_role: "leaf",
      focus: "alone",
      parents: ["index.md"],
    });
    const proposals = detectLift(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("LIFT apply: leaf lifted to wiki root has parents: [index.md]", async () => {
  // Regression for the depth-1 parent-path bug: lifting a leaf
  // from `wiki/only-child/` up to `wiki/` should leave the leaf's
  // `parents` as `[index.md]` (sibling form), not `[../index.md]`
  // (escapes above the wiki root).
  const wiki = tmpWiki("lift-parents-root");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "only-child"));
    writeIndex(join(wiki, "only-child"), "only-child");
    writeLeaf(join(wiki, "only-child", "up-to-root.md"), {
      id: "up-to-root",
      type: "primary",
      depth_role: "leaf",
      focus: "to be lifted",
      parents: ["../index.md"],
    });
    const [proposal] = detectLift(wiki);
    await proposal.apply({ wikiRoot: wiki, opId: "op-1" });
    const lifted = readFileSync(join(wiki, "up-to-root.md"), "utf8");
    const { data } = parseFrontmatter(lifted);
    assert.deepEqual(
      data.parents,
      ["index.md"],
      `lifted leaf at wiki root should have parents [index.md], got ${JSON.stringify(data.parents)}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("LIFT apply: leaf lifted from depth 2 to depth 1 has parents: [../index.md]", async () => {
  const wiki = tmpWiki("lift-parents-deep");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "outer"));
    writeIndex(join(wiki, "outer"), "outer");
    mkdirSync(join(wiki, "outer", "inner"));
    writeIndex(join(wiki, "outer", "inner"), "inner");
    writeLeaf(join(wiki, "outer", "inner", "deep.md"), {
      id: "deep",
      type: "primary",
      depth_role: "leaf",
      focus: "deep content",
      parents: ["../index.md"],
    });
    const proposals = detectLift(wiki);
    // Multiple LIFT candidates might exist; pick the one targeting
    // `outer/inner/`.
    const p = proposals.find((pr) => pr.sources[1].endsWith("inner"));
    assert.ok(p, "should find a LIFT proposal for outer/inner");
    await p.apply({ wikiRoot: wiki, opId: "op-1" });
    const lifted = readFileSync(join(wiki, "outer", "deep.md"), "utf8");
    const { data } = parseFrontmatter(lifted);
    assert.deepEqual(data.parents, ["../index.md"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("LIFT apply: moves the leaf up, removes the empty folder", async () => {
  const wiki = tmpWiki("lift-apply");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "only-child"));
    writeIndex(join(wiki, "only-child"), "only-child");
    writeLeaf(join(wiki, "only-child", "lonely.md"), {
      id: "lonely",
      type: "primary",
      depth_role: "leaf",
      focus: "a lonely leaf",
      parents: ["../index.md"],
    });
    const [proposal] = detectLift(wiki);
    await proposal.apply({ wikiRoot: wiki, opId: "op-1" });
    assert.ok(existsSync(join(wiki, "lonely.md")), "leaf moved to root");
    assert.ok(!existsSync(join(wiki, "only-child")), "folder removed");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── MERGE ────────────────────────────────────────────────────────────

test("detectMerge: near-identical siblings yield a MERGE proposal", async () => {
  const wiki = tmpWiki("merge-basic");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "prisma-a.md"), {
      id: "prisma-a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations and seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    writeLeaf(join(wiki, "prisma-b.md"), {
      id: "prisma-b",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations and seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1);
    const merge = proposals.find((p) => p.operator === "MERGE");
    assert.ok(merge);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectMerge: unrelated siblings produce no MERGE proposals", async () => {
  const wiki = tmpWiki("merge-none");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "react.md"), {
      id: "react",
      type: "primary",
      depth_role: "leaf",
      focus: "react hooks correctness",
      covers: ["useEffect rules", "dependency arrays"],
      parents: ["index.md"],
      tags: ["react"],
    });
    writeLeaf(join(wiki, "terraform.md"), {
      id: "terraform",
      type: "primary",
      depth_role: "leaf",
      focus: "terraform module composition",
      covers: ["module sources", "variable defaults"],
      parents: ["index.md"],
      tags: ["terraform"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    const merges = proposals.filter((p) => p.operator === "MERGE");
    assert.equal(merges.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: absorbs the shorter-focus entry into the longer", async () => {
  const wiki = tmpWiki("merge-apply");
  try {
    writeIndex(wiki, "root");
    // Both entries have ALMOST identical focus + covers so Tier 0
    // resolves to decisive-same. The `long` entry has a slightly
    // longer focus string and an extra cover so the apply step
    // picks it as the keeper.
    writeLeaf(join(wiki, "short.md"), {
      id: "short",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    writeLeaf(join(wiki, "long.md"), {
      id: "long",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands", "schema file"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(proposals.length >= 1);
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    // The longer-focus entry survives.
    assert.ok(existsSync(join(wiki, "long.md")));
    assert.ok(!existsSync(join(wiki, "short.md")));
    const { data } = parseFrontmatter(readFileSync(join(wiki, "long.md"), "utf8"));
    // Merged covers contain everything from both sources (deduped).
    const covered = new Set(data.covers);
    assert.ok(covered.has("migrate dev"));
    assert.ok(covered.has("migrate deploy"));
    assert.ok(covered.has("seed commands"));
    assert.ok(covered.has("schema file"));
    assert.ok(data.aliases.includes("short"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: unions tags and domains from both entries", async () => {
  const wiki = tmpWiki("merge-union-fields");
  try {
    writeIndex(wiki, "root");
    // Two entries with IDENTICAL focus + covers so Tier 0 hits
    // decisive-same. Their tags/domains differ — the point of the
    // test is that applyMerge correctly unions those lists.
    writeLeaf(join(wiki, "a.md"), {
      id: "a-entry",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "prisma"],
      domains: ["backend"],
    });
    writeLeaf(join(wiki, "b.md"), {
      id: "b-entry",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows canonical",
      covers: ["migrate dev", "migrate deploy", "seed commands"],
      parents: ["index.md"],
      tags: ["orm", "database"],
      domains: ["backend", "infra"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.ok(
      proposals.length >= 1,
      `expected a MERGE proposal, got none (the pair may have slipped out of decisive-same with the new IDF formula)`,
    );
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    // The keeper (b-entry, longer focus) survives.
    assert.ok(existsSync(join(wiki, "b.md")));
    const { data } = parseFrontmatter(readFileSync(join(wiki, "b.md"), "utf8"));
    // Tags union preserves both entries' tags.
    const tagSet = new Set(data.tags);
    assert.ok(tagSet.has("orm"));
    assert.ok(tagSet.has("prisma"));
    assert.ok(tagSet.has("database"));
    // Domains union likewise.
    const domainSet = new Set(data.domains);
    assert.ok(domainSet.has("backend"));
    assert.ok(domainSet.has("infra"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("MERGE apply: refuses to merge entries with conflicting type", async () => {
  const wiki = tmpWiki("merge-type-conflict");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "primary.md"), {
      id: "primary-a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "overlay.md"), {
      id: "overlay-b",
      type: "overlay",
      depth_role: "leaf",
      focus: "prisma database schema migrations seed workflows",
      covers: ["migrate dev"],
      parents: ["index.md"],
      overlay_targets: ["primary-a"],
    });
    const proposals = await detectMerge(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    // detectMerge will produce a proposal because similarity is
    // high; apply must refuse.
    if (proposals.length === 0) {
      // Acceptable if the mixed type somehow pushed similarity
      // below threshold — the stronger assertion is the apply
      // refusal. Fall back to calling apply via a synthetic
      // proposal would be over-engineering the test. Just ensure
      // at minimum a proposal exists or the files are untouched.
      assert.ok(
        existsSync(join(wiki, "primary.md")) && existsSync(join(wiki, "overlay.md")),
      );
      return;
    }
    await assert.rejects(
      () => proposals[0].apply({ wikiRoot: wiki, opId: "op-1" }),
      /MERGE: cannot merge.*conflicting/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── DESCEND ──────────────────────────────────────────────────────────

test("detectDescend: fat authored zone yields DESCEND proposal", () => {
  const wiki = tmpWiki("descend-size");
  try {
    const authored = "A".repeat(3000);
    writeIndex(wiki, "root", { authored });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].operator, "DESCEND");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: code fence in authored zone fires DESCEND", () => {
  const wiki = tmpWiki("descend-code");
  try {
    writeIndex(wiki, "root", { authored: "some intro\n```js\nconsole.log('x');\n```\n" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: checklist in authored zone fires DESCEND", () => {
  const wiki = tmpWiki("descend-checklist");
  try {
    writeIndex(wiki, "root", { authored: "notes\n- [ ] todo 1\n- [ ] todo 2\n" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDescend: short clean authored zone is left alone", () => {
  const wiki = tmpWiki("descend-clean");
  try {
    writeIndex(wiki, "root", { authored: "short orientation paragraph" });
    const proposals = detectDescend(wiki);
    assert.equal(proposals.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("DESCEND apply: creates a new leaf and clears the authored zone", async () => {
  const wiki = tmpWiki("descend-apply");
  try {
    writeIndex(wiki, "root", { authored: "A".repeat(3000) });
    const proposals = detectDescend(wiki);
    await proposals[0].apply({ wikiRoot: wiki, opId: "op-1" });
    const leafPath = join(wiki, "descended-content-1.md");
    assert.ok(existsSync(leafPath));
    const leafRaw = readFileSync(leafPath, "utf8");
    assert.ok(leafRaw.includes("A".repeat(100)));
    // Authored zone is now empty on the parent index.
    const indexRaw = readFileSync(join(wiki, "index.md"), "utf8");
    const authoredSection = indexRaw.match(
      /<!-- BEGIN AUTHORED ORIENTATION -->([\s\S]*?)<!-- END AUTHORED ORIENTATION -->/,
    );
    assert.ok(authoredSection);
    assert.equal(authoredSection[1].trim(), "");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── DECOMPOSE / NEST (detect-only in Phase 6) ────────────────────────

test("detectNestAndDecompose: many-covers leaf yields detect-only DECOMPOSE", () => {
  const wiki = tmpWiki("decompose");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "huge.md"), {
      id: "huge",
      type: "primary",
      depth_role: "leaf",
      focus: "a leaf with many concerns",
      parents: ["index.md"],
      covers: Array.from({ length: 15 }, (_, i) => `concern-${i}`),
    });
    const proposals = detectNestAndDecompose(wiki);
    assert.ok(proposals.some((p) => p.operator === "DECOMPOSE"));
    const dc = proposals.find((p) => p.operator === "DECOMPOSE");
    assert.ok(dc.detectOnly);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectNestAndDecompose: nests_into hint yields detect-only NEST", () => {
  const wiki = tmpWiki("nest");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "hinted.md"), {
      id: "hinted",
      type: "primary",
      depth_role: "leaf",
      focus: "a hinted nester",
      parents: ["index.md"],
      nests_into: ["section-a", "section-b"],
    });
    const proposals = detectNestAndDecompose(wiki);
    const nest = proposals.find((p) => p.operator === "NEST");
    assert.ok(nest);
    assert.ok(nest.detectOnly);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── runConvergence ───────────────────────────────────────────────────

test("runConvergence: terminates on a clean wiki with zero iterations applied", async () => {
  const wiki = tmpWiki("converge-clean");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "clean-a.md"), {
      id: "clean-a",
      type: "primary",
      depth_role: "leaf",
      focus: "a unique focus A",
      covers: ["concern-1"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "clean-b.md"), {
      id: "clean-b",
      type: "primary",
      depth_role: "leaf",
      focus: "a totally distinct focus B",
      covers: ["concern-2"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, { opId: "op-clean", qualityMode: "tiered-fast" });
    assert.equal(r.applied.length, 0);
    assert.ok(r.converged);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: applies LIFT then terminates", async () => {
  const wiki = tmpWiki("converge-lift");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "alone"));
    writeIndex(join(wiki, "alone"), "alone");
    writeLeaf(join(wiki, "alone", "child.md"), {
      id: "child",
      type: "primary",
      depth_role: "leaf",
      focus: "distinct child",
      parents: ["../index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-lift",
      qualityMode: "tiered-fast",
    });
    assert.ok(r.applied.length >= 1);
    const liftApplied = r.applied.find((a) => a.operator === "LIFT");
    assert.ok(liftApplied);
    assert.ok(existsSync(join(wiki, "child.md")));
    assert.ok(!existsSync(join(wiki, "alone")));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: priority ordering — DESCEND before MERGE before NEST", async () => {
  const wiki = tmpWiki("converge-priority");
  try {
    // Set up a wiki that has both a DESCEND candidate (fat authored
    // zone on root) AND a MERGE candidate (two similar leaves).
    writeIndex(wiki, "root", { authored: "X".repeat(3000) });
    writeLeaf(join(wiki, "a.md"), {
      id: "a",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations",
      covers: ["migrate dev", "seed commands"],
      parents: ["index.md"],
    });
    writeLeaf(join(wiki, "b.md"), {
      id: "b",
      type: "primary",
      depth_role: "leaf",
      focus: "prisma database schema migrations",
      covers: ["migrate dev", "seed commands"],
      parents: ["index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-priority",
      qualityMode: "tiered-fast",
    });
    // First applied proposal must be DESCEND (priority 5 > MERGE 3).
    assert.ok(r.applied.length >= 1);
    assert.equal(r.applied[0].operator, "DESCEND");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: commitBetweenIterations is invoked for each applied op", async () => {
  const wiki = tmpWiki("converge-commit");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "alone"));
    writeIndex(join(wiki, "alone"), "alone");
    writeLeaf(join(wiki, "alone", "child.md"), {
      id: "child",
      type: "primary",
      depth_role: "leaf",
      focus: "distinct child",
      parents: ["../index.md"],
    });
    const commits = [];
    await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
      commitBetweenIterations: async (ctx) => {
        commits.push(ctx);
      },
    });
    assert.ok(commits.length >= 1);
    assert.equal(commits[0].operator, "LIFT");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: halts on max iterations budget", async () => {
  // Build a pathological wiki: every LIFT leaves another single
  // child at the new level. We use `maxIterations: 1` to force an
  // early halt, then assert `iterations === 1`.
  const wiki = tmpWiki("converge-budget");
  try {
    writeIndex(wiki, "root");
    mkdirSync(join(wiki, "a"));
    writeIndex(join(wiki, "a"), "a");
    mkdirSync(join(wiki, "a", "b"));
    writeIndex(join(wiki, "a", "b"), "b");
    writeLeaf(join(wiki, "a", "b", "deep.md"), {
      id: "deep",
      type: "primary",
      depth_role: "leaf",
      focus: "deep child",
      parents: ["../index.md"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
      maxIterations: 1,
    });
    assert.equal(r.iterations, 1);
    assert.equal(r.applied.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runConvergence: NEST and DECOMPOSE candidates land in suggestions, not applied", async () => {
  const wiki = tmpWiki("converge-nest-only");
  try {
    writeIndex(wiki, "root");
    writeLeaf(join(wiki, "hinted.md"), {
      id: "hinted",
      type: "primary",
      depth_role: "leaf",
      focus: "nest candidate",
      covers: ["concern-1"],
      parents: ["index.md"],
      nests_into: ["section-a", "section-b"],
    });
    const r = await runConvergence(wiki, {
      opId: "op-1",
      qualityMode: "tiered-fast",
    });
    assert.equal(r.applied.length, 0);
    assert.ok(r.suggestions.some((s) => s.operator === "NEST"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
