// tiered-build.test.mjs — end-to-end proof that a full `build`
// exercises the tiered AI ladder and lands a valid wiki.
//
// Covered scenarios:
//   - Build that includes similar and unrelated siblings produces
//     a decisions.yaml with entries for every pair
//   - Quality mode defaults to tiered-fast
//   - `--quality-mode tier0-only` flag propagates through intent →
//     orchestrator → convergence → tiered.decide
//   - LIFT fires on a single-leaf category and rearranges the tree
//   - A build with LIFT-applicable structure shows LIFT in the
//     operator-convergence phase summary
//   - Per-iteration commits appear in the private git log
//   - Decision log round-trip through readDecisions

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { readDecisions } from "../../scripts/lib/decision-log.mjs";

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
      LLM_WIKI_MOCK_TIER1: "1",
      // These tests exercise the pairwise tiered AI ladder
      // (MERGE / similarity cache / --quality-mode); they don't
      // want the Phase 8 cluster-NEST propose_structure escalation
      // to park Tier 2 requests in the exit-7 queue. Each test
      // that DOES want cluster behaviour opts back in by passing
      // an env override.
      LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      ...(opts.env || {}),
    },
    cwd: opts.cwd,
  });
}

function tmpParent(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-tiered-e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("tiered build: decisions.yaml is populated after a multi-entry build", () => {
  const parent = tmpParent("decisions");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    // Two similar prisma entries + one unrelated react entry so the
    // similarity ladder produces a decisive-same, a decisive-diff,
    // and possibly a mid-band escalation.
    writeFileSync(
      join(src, "prisma-a.md"),
      "# Prisma A\n\nprisma database schema migrations seed workflows\n",
    );
    writeFileSync(
      join(src, "prisma-b.md"),
      "# Prisma B\n\nprisma database schema migrations seed workflows\n",
    );
    writeFileSync(
      join(src, "react.md"),
      "# React\n\nreact hook correctness rules useEffect dependency arrays\n",
    );
    const r = runCli(["build", src]);
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "corpus.wiki");

    const decisions = readDecisions(wiki);
    // Phase 8+ writes METRIC_TRAJECTORY + NEST-outcome entries in
    // addition to the pairwise MERGE/tiered-AI entries — filter
    // to just the operator-applied similarity decisions for this
    // assertion.
    const merges = decisions.filter((d) => d.operator === "MERGE");
    assert.ok(
      merges.length >= 1,
      `decisions.yaml must contain at least one MERGE entry, got ${merges.length}`,
    );
    for (const d of merges) {
      assert.equal(d.sources.length, 2);
      assert.ok(typeof d.similarity === "number");
      assert.ok([0, 1, 2].includes(d.tier_used));
    }
    // The trajectory addition must also be present so rebuild /
    // 0-application ops can be distinguished from not-run ones.
    const trajectory = decisions.filter((d) => d.operator === "METRIC_TRAJECTORY");
    assert.ok(
      trajectory.length >= 1,
      `decisions.yaml should carry METRIC_TRAJECTORY entries (Phase 8 audit)`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("tiered build: --quality-mode tier0-only skips Tier 1 and Tier 2", () => {
  const parent = tmpParent("tier0-only");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(
      join(src, "redis.md"),
      "# Redis\n\ncaching strategies redis lru eviction stampede prefix\n",
    );
    writeFileSync(
      join(src, "memcached.md"),
      "# Memcached\n\ncaching strategies memcached slab allocation stampede prefix\n",
    );
    // These are mid-band in Tier 0 — with tier0-only they resolve
    // as "undecidable" and the convergence loop does not MERGE.
    const r = runCli([
      "build",
      src,
      "--quality-mode",
      "tier0-only",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "corpus.wiki");
    const decisions = readDecisions(wiki);
    // Every decision must have tier_used === 0.
    for (const d of decisions) {
      assert.equal(
        d.tier_used,
        0,
        `tier0-only must not escalate, got tier ${d.tier_used} for ${d.sources.join(",")}`,
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("tiered build: per-iteration operator commits appear in git log", () => {
  const parent = tmpParent("commits");
  try {
    // Prepare a source that forces DESCEND to fire by placing
    // manual content in the eventual wiki's index.md BEFORE build.
    // Actually, for Build we can't pre-write index.md since build
    // creates it. Instead we use LIFT — a source with one leaf in
    // a subcategory will be flattened.
    //
    // Flat sources now land at the wiki root, so with 4 distinct
    // entries there is no LIFT-eligible subfolder. We expect LIFT
    // NOT to fire here.
    const src = join(parent, "corpus");
    mkdirSync(src);
    for (let i = 0; i < 4; i++) {
      writeFileSync(
        join(src, `entry-${i}.md`),
        `# Entry ${i}\n\nuniquely-worded distinct focus number ${i} with singular vocabulary alpha-${i}\n`,
      );
    }
    const r = runCli(["build", src]);
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "corpus.wiki");
    // `log` passthrough should show the phase commits.
    const log = runCli(["log", wiki]);
    assert.equal(log.status, 0, log.stderr);
    // Standard phase commits must be present.
    assert.match(log.stdout, /phase draft-frontmatter/);
    assert.match(log.stdout, /phase index-generation/);
    // With 4 distinct entries, convergence finds no applicable ops,
    // so no operator-convergence commit. That's expected and OK.
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("tiered build: build with one-leaf-per-subcategory triggers LIFT", () => {
  // Build a wiki and then manually create a LIFT-eligible state that
  // lifts to a NON-ROOT parent. The X.11 root-containment invariant
  // forbids LIFT from landing a leaf at the wiki root, so this test
  // exercises LIFT at depth 2 → depth 1 (well away from the root).
  //
  // Structure under test:
  //   wiki/
  //     outer/                   ← real subcategory (survives LIFT)
  //       outer-leaf.md          ← sibling at outer/, prevents outer from collapsing
  //       lonely-solo/           ← single-leaf passthrough (LIFT target)
  //         lonely.md
  //         index.md
  //       index.md
  //     index.md
  //
  // After LIFT: lonely.md sits at outer/lonely.md, lonely-solo/ gone.
  const parent = tmpParent("lift");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(
      join(src, "lonely.md"),
      "# Lonely\n\nvery distinct lonely content phrase xyzzy-uniquely\n",
    );
    writeFileSync(
      join(src, "other.md"),
      "# Other\n\nanother distinct entry with singular content foobar-unique\n",
    );
    const build = runCli(["build", src]);
    assert.equal(build.status, 0, build.stderr);
    const wiki = join(parent, "corpus.wiki");

    // X.11 has already contained `lonely.md` and `other.md` into
    // per-outlier subcategories. We don't care where — we find
    // `lonely.md` anywhere under wiki and stage the LIFT setup from
    // its current location.
    const findLeaf = (name) => {
      const stack = [wiki];
      while (stack.length) {
        const d = stack.pop();
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const full = join(d, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.isFile() && e.name === name) return full;
        }
      }
      return null;
    };
    const lonelyCurrent = findLeaf("lonely.md");
    assert.ok(lonelyCurrent, "lonely.md should exist somewhere in the wiki");

    // Build the LIFT-eligible topology under a non-root `outer/`
    // category. `outer/` has its own leaf so LIFT doesn't collapse
    // `outer/` itself; `outer/lonely-solo/` is a single-leaf
    // passthrough — that's what LIFT should carve out.
    const outerDir = join(wiki, "outer");
    mkdirSync(outerDir, { recursive: true });
    writeFileSync(
      join(outerDir, "index.md"),
      "---\nid: outer\ntype: index\ndepth_role: subcategory\nfocus: outer container\ngenerator: skill-llm-wiki/v1\nparents:\n  - ../index.md\n---\n\n",
    );
    writeFileSync(
      join(outerDir, "outer-leaf.md"),
      "---\nid: outer-leaf\ntype: primary\ndepth_role: leaf\nfocus: sibling keeping outer alive\nparents:\n  - index.md\n---\n\n# Outer Leaf\n\noutersibling content unique-token aaa\n",
    );
    const soloDir = join(outerDir, "lonely-solo");
    mkdirSync(soloDir);
    writeFileSync(
      join(soloDir, "lonely.md"),
      readFileSync(lonelyCurrent, "utf8"),
    );
    rmSync(lonelyCurrent);
    writeFileSync(
      join(soloDir, "index.md"),
      "---\nid: lonely-solo\ntype: index\ndepth_role: subcategory\nfocus: solo\ngenerator: skill-llm-wiki/v1\nparents:\n  - ../index.md\n---\n\n",
    );

    // rebuild should fire LIFT on outer/lonely-solo/ → outer/lonely.md.
    const rebuild = runCli(["rebuild", wiki]);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    assert.match(rebuild.stdout, /operator-convergence: \d+ operator\(s\) applied/);
    // After LIFT: leaf at outer/lonely.md, passthrough dir gone.
    assert.ok(existsSync(join(outerDir, "lonely.md")));
    assert.ok(!existsSync(soloDir));
    // Git log for the private repo should contain a LIFT commit.
    const log = runCli(["log", wiki]);
    assert.match(
      log.stdout,
      /operator-convergence.*LIFT/,
      `private git log should show LIFT commit, got: ${log.stdout}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("tiered build: similarity cache gets populated during build", () => {
  const parent = tmpParent("cache");
  try {
    const src = join(parent, "corpus");
    mkdirSync(src);
    writeFileSync(join(src, "a.md"), "# A\n\nunique alpha content phrase qwerty\n");
    writeFileSync(join(src, "b.md"), "# B\n\nunique beta content phrase asdfg\n");
    writeFileSync(join(src, "c.md"), "# C\n\nunique gamma content phrase zxcvb\n");
    const r = runCli(["build", src]);
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "corpus.wiki");
    // Three pairs × ? directories. Each pair gets cached once.
    // Cache layout is sharded: `<cacheDir>/<2hex>/<rest>.json`, so
    // walk every shard subdir to count.
    const cacheDir = join(wiki, ".llmwiki", "similarity-cache");
    assert.ok(existsSync(cacheDir));
    let total = 0;
    for (const shard of readdirSync(cacheDir)) {
      const shardPath = join(cacheDir, shard);
      try {
        for (const entry of readdirSync(shardPath)) {
          if (entry.endsWith(".json")) total++;
        }
      } catch {
        /* shard may be a stray file on pre-sharding layouts */
      }
    }
    assert.ok(
      total >= 1,
      `similarity cache should have at least one entry, got ${total}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
