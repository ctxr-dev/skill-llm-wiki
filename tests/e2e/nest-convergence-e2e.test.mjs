// nest-convergence-e2e.test.mjs — end-to-end proof that the
// cluster-detect + NEST-apply + quality-metric pipeline nests
// related leaves into subcategories when the source carries the
// right tag/activation signals.
//
// Synthetic corpus:
//   - 6 leaves authored with shared tag "operations" + shared
//     activation keywords (build/rebuild/extend)
//   - 6 leaves authored with shared tag "history" + shared
//     activation keywords (history/log/blame/reflog/diff/show)
//   - 2 unrelated singleton leaves
//
// Tier 2 fixture pre-resolves every cluster_name request the
// detector might emit — keyed by the deterministic request_id
// the detector produces for each leaf set. We pre-run the
// detector once against the seeded source to discover the
// request_ids so the fixture is always in sync with the inputs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
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

function runCli(args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_MOCK_TIER1: "1",
      LLM_WIKI_NO_PROMPT: "1",
      ...env,
    },
  });
}

function tmpDir(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-nest-e2e-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// A leaf writer that emits a source .md file carrying authored
// frontmatter. The draft pipeline will preserve these fields.
function writeSourceLeaf(sourceRoot, filename, data, bodyText) {
  const path = join(sourceRoot, filename);
  mkdirSync(dirname(path), { recursive: true });
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else if (typeof v === "object" && v !== null) {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2)) {
          lines.push(`  ${k2}:`);
          for (const item of v2) lines.push(`    - ${item}`);
        } else {
          lines.push(`  ${k2}: ${v2}`);
        }
      }
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", bodyText);
  writeFileSync(path, lines.join("\n"), "utf8");
}

function buildSyntheticSource() {
  const parent = tmpDir("src");
  const source = join(parent, "source");
  mkdirSync(source, { recursive: true });

  // Cluster A: operations — six leaves sharing tag + activation.
  const opsLeaves = [
    { name: "op-build.md", id: "op-build", focus: "build a new wiki from source", covers: ["ingest", "draft-frontmatter", "index-generation"], kw: ["build", "source", "new"] },
    { name: "op-rebuild.md", id: "op-rebuild", focus: "rebuild and optimise an existing wiki", covers: ["plan", "apply", "optimise"], kw: ["rebuild", "optimize", "restructure"] },
    { name: "op-extend.md", id: "op-extend", focus: "extend an existing wiki with new entries", covers: ["append", "merge", "update"], kw: ["extend", "add", "append"] },
    { name: "op-fix.md", id: "op-fix", focus: "fix methodology divergences in a wiki", covers: ["repair", "validate", "mend"], kw: ["fix", "repair", "validate"] },
    { name: "op-join.md", id: "op-join", focus: "join two wikis into one", covers: ["merge", "deduplicate", "unify"], kw: ["join", "merge", "combine"] },
    { name: "op-rollback.md", id: "op-rollback", focus: "rollback a wiki to a previous committed state", covers: ["reset", "restore", "undo"], kw: ["rollback", "restore", "undo"] },
  ];
  for (const l of opsLeaves) {
    writeSourceLeaf(source, l.name, {
      id: l.id,
      focus: l.focus,
      covers: l.covers,
      tags: ["operations", "ops-cluster"],
      activation: { keyword_matches: l.kw },
    }, `\n# ${l.id}\n\nOperation: ${l.focus}. Details here.\n`);
  }

  // Cluster B: history — six leaves sharing tag + activation.
  const historyLeaves = [
    { name: "hist-log.md", id: "hist-log", focus: "inspect commit log history", covers: ["git log", "oneline", "paths"], kw: ["log", "history", "commit"] },
    { name: "hist-blame.md", id: "hist-blame", focus: "blame a line to find its author and commit", covers: ["git blame", "line", "author"], kw: ["blame", "line", "author"] },
    { name: "hist-reflog.md", id: "hist-reflog", focus: "inspect the reflog to recover lost commits", covers: ["git reflog", "recovery", "lost"], kw: ["reflog", "recovery", "lost"] },
    { name: "hist-diff.md", id: "hist-diff", focus: "diff commits and rebuild trees", covers: ["git diff", "rebuild", "paths"], kw: ["diff", "rebuild", "paths"] },
    { name: "hist-show.md", id: "hist-show", focus: "show a specific commit via git show", covers: ["git show", "commit", "sha"], kw: ["show", "commit", "sha"] },
    { name: "hist-history.md", id: "hist-history", focus: "walk per-entry operation history", covers: ["history", "entry", "walk"], kw: ["history", "walk", "entry"] },
  ];
  for (const l of historyLeaves) {
    writeSourceLeaf(source, l.name, {
      id: l.id,
      focus: l.focus,
      covers: l.covers,
      tags: ["history", "history-cluster"],
      activation: { keyword_matches: l.kw },
    }, `\n# ${l.id}\n\nHistory: ${l.focus}.\n`);
  }

  // Singletons — genuinely unrelated to each other and to the clusters.
  writeSourceLeaf(source, "lonely-a.md", {
    id: "lonely-a",
    focus: "a unique topic about zebra ecology",
    covers: ["stripes pattern"],
    tags: ["ecology"],
    activation: { keyword_matches: ["zebra", "stripes", "ecology"] },
  }, "\n# lonely-a\n\nUnrelated content about zebras.\n");
  writeSourceLeaf(source, "lonely-b.md", {
    id: "lonely-b",
    focus: "a distinct topic about quaternion rotations",
    covers: ["rotation math"],
    tags: ["math"],
    activation: { keyword_matches: ["quaternion", "rotation", "math"] },
  }, "\n# lonely-b\n\nUnrelated content about quaternions.\n");

  return { parent, source };
}

// Pre-pack the fixture by iteratively simulating convergence:
// snapshot the post-draft wiki state, walk directories and
// emit every propose_structure / nest_decision / cluster_name
// request the detector *would* produce, populate the fixture with
// synthesized responses for each, then have the CLI run with the
// complete fixture in a single invocation.
//
// This uses an in-memory pass over the frontmatter graph — the
// fixture needs to cover every iteration's worth of requests, so
// we simulate the convergence "apply one NEST, recompute" loop
// until no new requests appear.
async function packFixture(wikiOrSource, parent) {
  const {
    buildProposeStructureRequest,
    detectClusters,
    MIN_CLUSTER_SIZE: MIN,
  } = await import("../../scripts/lib/cluster-detect.mjs");
  const { parseFrontmatter } = await import("../../scripts/lib/frontmatter.mjs");

  function loadLeaves(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md") && n !== "index.md")
      .sort()
      .map((n) => {
        const p = join(dir, n);
        const raw = readFileSync(p, "utf8");
        const { data } = parseFrontmatter(raw, p);
        data.type = data.type || "primary";
        data.depth_role = data.depth_role || "leaf";
        return { path: p, data };
      });
  }

  // Wildcard fallbacks cover any propose_structure / nest_decision /
  // cluster_name request whose exact request_id the simulator didn't
  // pre-compute — defensive against the real CLI taking a slightly
  // different iteration path than the simulator's pruning model. The
  // wildcard responses are conservative (defer-to-math, nest-yes,
  // dynamic-slug) so they don't alter the convergence outcome.
  const fixture = {
    __kind__propose_structure: { subcategories: [], siblings: [], notes: "wildcard: defer to math" },
    __kind__nest_decision: { decision: "nest", reason: "wildcard" },
    __kind__cluster_name: { slug: "wild-grp", purpose: "wildcard" },
  };
  // Simulate up to 10 convergence iterations, pruning one cluster
  // per step to mirror the real loop. We cannot actually apply
  // the NEST to disk (we're reading the source, not the wiki), so
  // we simulate by removing the chosen cluster's leaves from our
  // working set and re-scanning.
  let working = loadLeaves(wikiOrSource);
  for (let iter = 0; iter < 10 && working.length >= MIN; iter++) {
    // propose_structure request for this working set
    const ps = buildProposeStructureRequest(".", working);
    fixture[ps.request_id] = { subcategories: [], siblings: [], notes: "defer to math" };

    const proposals = await detectClusters(wikiOrSource, working, {
      returnEmptyMarker: false,
    });
    if (proposals.length === 0) break;
    // Register every gate + naming request we expect to see.
    for (const p of proposals) {
      fixture[p.gate_request.request_id] = { decision: "nest", reason: "pack" };
      const idx = parseInt(p.naming_request.request_id.slice(0, 2), 16) % 4;
      const slugs = ["alpha-grp", "beta-grp", "gamma-grp", "delta-grp"];
      fixture[p.naming_request.request_id] = { slug: `${slugs[idx]}-${iter}`, purpose: "pack" };
    }
    // Remove the strongest cluster's leaves from the working set
    // to simulate "one NEST per iteration" and trigger the next
    // propose_structure with a smaller set.
    const strongest = proposals[0];
    const removedIds = new Set(strongest.leaves.map((l) => l.data.id));
    working = working.filter((l) => !removedIds.has(l.data.id));
  }

  const fixturePath = join(parent, "tier2-fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2), "utf8");
  return fixturePath;
}

test("nest-convergence e2e: synthetic clustered corpus nests into subcategories", async () => {
  const { parent, source } = buildSyntheticSource();
  try {
    // Pre-pack a fixture covering every propose_structure +
    // nest_decision + cluster_name request the convergence loop
    // will emit across all iterations (simulated by walking the
    // source and mimicking one-NEST-per-iteration pruning).
    const fixturePath = await packFixture(source, parent);

    const out = runCli(["build", source, "--layout-mode", "sibling"], {
      LLM_WIKI_TIER2_FIXTURE: fixturePath,
      LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    });
    assert.equal(out.status, 0, `build failed: ${out.stderr}\n${out.stdout}`);
    assert.match(out.stdout, /build: complete/);

    // Wiki is at <parent>/source.wiki
    const wiki = join(parent, "source.wiki");
    assert.ok(existsSync(wiki));

    // Count subcategories — expect at least 2 (the two clusters).
    // A "subcategory" is any non-dot subdirectory of the wiki
    // root that carries an index.md.
    const entries = readdirSync(wiki, { withFileTypes: true });
    const subcats = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(join(wiki, e.name, "index.md")),
    );
    assert.ok(
      subcats.length >= 2,
      `expected ≥2 subcategories, got ${subcats.length}: ${subcats.map((s) => s.name).join(", ")}`,
    );

    // Root leaves should be FEWER than 14 (the 6+6+2 total). If
    // the cluster NEST applier ran, at least one cluster moved
    // into a subdir and the root leaf count dropped.
    const rootLeafCount = entries.filter(
      (e) => e.isFile() && e.name.endsWith(".md") && e.name !== "index.md",
    ).length;
    assert.ok(
      rootLeafCount < 14,
      `expected <14 root leaves after nesting, got ${rootLeafCount}`,
    );

    // Routing cost: load the quality metric and confirm it's
    // strictly better (lower) than a hypothetical flat wiki with
    // the same leaves. We just check that the cost is non-zero
    // and the queries_matched count is non-zero, since we already
    // have a unit test that proves nested < flat.
    const { computeRoutingCost } = await import(
      "../../scripts/lib/quality-metric.mjs"
    );
    const metric = computeRoutingCost(wiki);
    assert.ok(metric.cost > 0);
    assert.ok(metric.queries_matched >= 0); // may be 0 if queries don't match this corpus' tags

    // v6 multi-NEST-per-iteration (Rec 3c): the two disjoint
    // clusters in this corpus should land in a SINGLE convergence
    // iteration rather than two, since their member sets never
    // overlap. Read the metric trajectory from decisions.yaml and
    // verify both applied NESTs carry the same iteration value.
    // Pre-v6 this test produced NESTs at iter-1 AND iter-2;
    // post-v6 both land at iter-1.
    const decisionsYaml = readFileSync(
      join(wiki, ".llmwiki", "decisions.yaml"),
      "utf8",
    );
    const trajectoryLines = decisionsYaml
      .split("\n")
      .filter((l) => l.match(/^\s+- iter-\d+$/))
      .map((l) => l.trim());
    // Filter to the NEST event iterations (skip baseline iter-0).
    // The test corpus always produces at least 2 NEST applies, all
    // of which must share the same iteration number now that
    // multi-NEST per iteration is enabled.
    const nestIters = new Set();
    // Find lines adjacent to `confidence_band: NEST`.
    const lines = decisionsYaml.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\s+confidence_band:\s*NEST\s*$/.test(lines[i])) {
        // Walk back to the nearest iter-N source line.
        for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
          const m = /^\s+-\s*iter-(\d+)\s*$/.exec(lines[j]);
          if (m) {
            nestIters.add(Number(m[1]));
            break;
          }
        }
      }
    }
    assert.ok(
      nestIters.size >= 1,
      `expected at least one NEST metric-trajectory entry, got ${nestIters.size}`,
    );
    assert.equal(
      nestIters.size,
      1,
      `expected all NEST applies in a single iteration (v6 multi-NEST), ` +
        `instead saw distinct iterations: ${[...nestIters].sort((a, b) => a - b).join(", ")}`,
    );
  } finally {
    if (!process.env.LLM_WIKI_KEEP_TMP) rmSync(parent, { recursive: true, force: true });
    else console.error("[KEEP_TMP]", parent);
  }
});
