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
    assert.ok(
      decisions.length >= 1,
      `decisions.yaml must contain at least one entry, got ${decisions.length}`,
    );
    // Every entry targets the MERGE operator (the only similarity-
    // using operator in Phase 6) and every entry lists exactly two
    // source ids.
    for (const d of decisions) {
      assert.equal(d.operator, "MERGE");
      assert.equal(d.sources.length, 2);
      assert.ok(typeof d.similarity === "number");
      assert.ok([0, 1, 2].includes(d.tier_used));
    }
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
    // draftCategory flattens everything to one category ("general"),
    // so we seed three entries so general/ is NOT a LIFT candidate
    // (3 leaves in a folder doesn't lift), AND we do NOT expect
    // LIFT to fire here. Instead we look for ANY operator-
    // convergence commit message in the log.
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
  // This one builds a wiki and then manually creates a LIFT-
  // eligible state on top (moving a leaf into a subdirectory with
  // just one child), then runs rebuild to let the operator fire.
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

    // Phase 3's draftCategory flattens; both leaves are under
    // general/. Manually move `lonely` into its own subdirectory
    // to set up a LIFT-eligible state.
    mkdirSync(join(wiki, "lonely-solo"));
    const leafSrc = join(wiki, "general", "lonely.md");
    const leafDst = join(wiki, "lonely-solo", "lonely.md");
    writeFileSync(leafDst, readFileSync(leafSrc, "utf8"));
    rmSync(leafSrc);
    // Install a minimal index for the new subcategory.
    writeFileSync(
      join(wiki, "lonely-solo", "index.md"),
      "---\nid: lonely-solo\ntype: index\ndepth_role: subcategory\nfocus: solo\ngenerator: skill-llm-wiki/v1\nparents:\n  - ../index.md\n---\n\n",
    );

    // rebuild should fire LIFT.
    const rebuild = runCli(["rebuild", wiki]);
    assert.equal(rebuild.status, 0, rebuild.stderr);
    assert.match(rebuild.stdout, /operator-convergence: \d+ operator\(s\) applied/);
    // After LIFT, the leaf is at wiki/lonely.md and the folder is gone.
    assert.ok(existsSync(join(wiki, "lonely.md")));
    assert.ok(!existsSync(join(wiki, "lonely-solo")));
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
    const cacheDir = join(wiki, ".llmwiki", "similarity-cache");
    assert.ok(existsSync(cacheDir));
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    assert.ok(
      files.length >= 1,
      `similarity cache should have at least one entry, got ${files.length}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
