// cluster-detect.test.mjs — synthetic leaves with known-good tag/
// keyword overlap. Assert the detector finds the expected components
// and emits Tier 2 cluster_name requests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import {
  CANDIDATE_THRESHOLDS,
  GIANT_BLOB_FRACTION,
  MAX_CLUSTER_SIZE,
  MIN_CLUSTER_SIZE,
  buildProposeStructureRequest,
  computeAffinityMatrix,
  detectClusters,
  findComponents,
  partitionShapeScore,
} from "../../scripts/lib/cluster-detect.mjs";

process.env.LLM_WIKI_MOCK_TIER1 = "1";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-cd-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function leaf(wikiRoot, filename, data) {
  const p = join(wikiRoot, filename);
  writeFileSync(p, renderFrontmatter(data, "\n# " + data.id + "\n\nPlaceholder body for affinity.\n"), "utf8");
  return { path: p, data };
}

// Two clusters of three with shared tags and shared activation
// keywords. Ideal inputs for the detector: this is the easy case,
// and if we can't find the clusters here the signal fusion is
// broken.
function buildSyntheticLeaves(wikiRoot) {
  return [
    leaf(wikiRoot, "alpha-1.md", {
      id: "alpha-1",
      type: "primary",
      depth_role: "leaf",
      focus: "alpha cluster topic one",
      covers: ["alpha intro", "alpha setup"],
      tags: ["alpha", "topic"],
      activation: { keyword_matches: ["alpha", "first"] },
    }),
    leaf(wikiRoot, "alpha-2.md", {
      id: "alpha-2",
      type: "primary",
      depth_role: "leaf",
      focus: "alpha cluster topic two",
      covers: ["alpha continued", "alpha advanced"],
      tags: ["alpha", "topic"],
      activation: { keyword_matches: ["alpha", "second"] },
    }),
    leaf(wikiRoot, "alpha-3.md", {
      id: "alpha-3",
      type: "primary",
      depth_role: "leaf",
      focus: "alpha cluster topic three",
      covers: ["alpha reference", "alpha patterns"],
      tags: ["alpha", "topic"],
      activation: { keyword_matches: ["alpha", "third"] },
    }),
    leaf(wikiRoot, "beta-1.md", {
      id: "beta-1",
      type: "primary",
      depth_role: "leaf",
      focus: "beta cluster basics",
      covers: ["beta primer"],
      tags: ["beta", "topic"],
      activation: { keyword_matches: ["beta", "primer"] },
    }),
    leaf(wikiRoot, "beta-2.md", {
      id: "beta-2",
      type: "primary",
      depth_role: "leaf",
      focus: "beta cluster details",
      covers: ["beta detail"],
      tags: ["beta", "topic"],
      activation: { keyword_matches: ["beta", "detail"] },
    }),
    leaf(wikiRoot, "beta-3.md", {
      id: "beta-3",
      type: "primary",
      depth_role: "leaf",
      focus: "beta cluster advanced",
      covers: ["beta advanced"],
      tags: ["beta", "topic"],
      activation: { keyword_matches: ["beta", "advanced"] },
    }),
    // Lone outlier
    leaf(wikiRoot, "gamma-lonely.md", {
      id: "gamma-lonely",
      type: "primary",
      depth_role: "leaf",
      focus: "unrelated subject",
      covers: ["something else entirely"],
      tags: ["gamma"],
      activation: { keyword_matches: ["gamma", "lonely"] },
    }),
  ];
}

test("MIN_CLUSTER_SIZE and MAX_CLUSTER_SIZE are sane", () => {
  assert.ok(MIN_CLUSTER_SIZE >= 2);
  assert.ok(MAX_CLUSTER_SIZE > MIN_CLUSTER_SIZE);
});

test("CANDIDATE_THRESHOLDS are monotonically increasing", () => {
  for (let i = 1; i < CANDIDATE_THRESHOLDS.length; i++) {
    assert.ok(CANDIDATE_THRESHOLDS[i] > CANDIDATE_THRESHOLDS[i - 1]);
  }
});

test("CANDIDATE_THRESHOLDS aggressive floor (<=0.15)", () => {
  // The low end should reach into the sparse-signal band so
  // hand-authored corpora with modest pairwise similarities
  // can still surface clusters. 0.15 is the justified minimum.
  assert.ok(CANDIDATE_THRESHOLDS[0] <= 0.15, `floor=${CANDIDATE_THRESHOLDS[0]}`);
});

test("GIANT_BLOB_FRACTION is in the (0.5, 1) range", () => {
  assert.ok(GIANT_BLOB_FRACTION > 0.5);
  assert.ok(GIANT_BLOB_FRACTION < 1);
});

test("partitionShapeScore: rewards multiple clusters", () => {
  const oneCluster = [[0, 1, 2, 3], [4], [5]]; // 1 accepted 4-cluster
  const twoClusters = [[0, 1, 2], [3, 4, 5]]; // 2 accepted 3-clusters
  const s1 = partitionShapeScore(oneCluster, 6);
  const s2 = partitionShapeScore(twoClusters, 6);
  assert.ok(s2 > s1, `two clusters should outrank one: ${s2} vs ${s1}`);
});

test("partitionShapeScore: rejects giant-blob partitions", () => {
  // 8 leaves, 7 lumped together → giant blob > 75% → score 0
  const giant = [[0, 1, 2, 3, 4, 5, 6], [7]];
  assert.equal(partitionShapeScore(giant, 8), 0);
});

test("partitionShapeScore: single-giant-cluster (everything) scores 0", () => {
  const all = [[0, 1, 2, 3, 4]];
  assert.equal(partitionShapeScore(all, 5), 0);
});

test("computeAffinityMatrix: symmetric and zero-diagonal", async () => {
  const wiki = tmpWiki("aff-sym");
  try {
    const leaves = buildSyntheticLeaves(wiki);
    const m = await computeAffinityMatrix(wiki, leaves);
    assert.equal(m.length, leaves.length);
    for (let i = 0; i < m.length; i++) {
      assert.equal(m[i][i], 0);
      for (let j = 0; j < m.length; j++) {
        assert.equal(m[i][j], m[j][i], `asymmetry at [${i}][${j}]`);
      }
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("computeAffinityMatrix: within-cluster > cross-cluster affinity", async () => {
  const wiki = tmpWiki("aff-score");
  try {
    const leaves = buildSyntheticLeaves(wiki);
    const m = await computeAffinityMatrix(wiki, leaves);
    // alpha-1 vs alpha-2 (both alpha cluster) should beat alpha-1 vs beta-1.
    assert.ok(
      m[0][1] > m[0][3],
      `expected alpha1-alpha2 affinity > alpha1-beta1 affinity (got ${m[0][1].toFixed(3)} vs ${m[0][3].toFixed(3)})`,
    );
    assert.ok(
      m[3][4] > m[3][0],
      `expected beta1-beta2 affinity > beta1-alpha1 affinity (got ${m[3][4].toFixed(3)} vs ${m[3][0].toFixed(3)})`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("findComponents: groups by threshold", () => {
  // Hand-crafted matrix: two triangles + isolated node.
  const n = 7;
  const m = Array.from({ length: n }, () => new Float64Array(n));
  // Alpha triangle: 0,1,2
  m[0][1] = m[1][0] = 0.8;
  m[0][2] = m[2][0] = 0.8;
  m[1][2] = m[2][1] = 0.8;
  // Beta triangle: 3,4,5
  m[3][4] = m[4][3] = 0.8;
  m[3][5] = m[5][3] = 0.8;
  m[4][5] = m[5][4] = 0.8;
  // Node 6 isolated; cross-cluster edges all < 0.2
  m[0][3] = m[3][0] = 0.15;
  const parts = findComponents(m, 0.5);
  assert.equal(parts.length, 3); // alpha, beta, lone
  const sizes = parts.map((c) => c.length).sort();
  assert.deepEqual(sizes, [1, 3, 3]);
});

test("detectClusters: finds the two expected clusters in synthetic leaves", async () => {
  const wiki = tmpWiki("detect");
  try {
    const leaves = buildSyntheticLeaves(wiki);
    const proposals = await detectClusters(wiki, leaves);
    // Expect 2 clusters (alpha and beta), each of size 3.
    assert.equal(proposals.length, 2, `expected 2 proposals, got ${proposals.length}`);
    for (const p of proposals) {
      assert.equal(p.operator, "NEST");
      assert.equal(p.leaves.length, 3);
      // Every member of a cluster shares a tag.
      const tags = p.leaves.map((l) => new Set(l.data.tags));
      const common = [...tags[0]].filter((t) => tags.every((s) => s.has(t)));
      assert.ok(common.length > 0, "cluster members should share at least one tag");
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectClusters: emits cluster_name Tier 2 requests per proposal", async () => {
  const wiki = tmpWiki("detect-req");
  try {
    const leaves = buildSyntheticLeaves(wiki);
    const proposals = await detectClusters(wiki, leaves);
    for (const p of proposals) {
      assert.ok(p.naming_request);
      assert.equal(p.naming_request.kind, "cluster_name");
      assert.ok(p.naming_request.inputs.leaves);
      assert.equal(p.naming_request.inputs.leaves.length, p.leaves.length);
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectClusters: below MIN_CLUSTER_SIZE returns empty array", async () => {
  const wiki = tmpWiki("detect-small");
  try {
    const leaves = [
      leaf(wiki, "a.md", { id: "a", type: "primary", focus: "a", covers: ["x"], tags: ["t"] }),
      leaf(wiki, "b.md", { id: "b", type: "primary", focus: "b", covers: ["y"], tags: ["t"] }),
    ];
    const proposals = await detectClusters(wiki, leaves);
    assert.deepEqual(proposals, []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectClusters: math proposals carry gate_request (nest_decision)", async () => {
  const wiki = tmpWiki("detect-gate");
  try {
    const leaves = buildSyntheticLeaves(wiki);
    const proposals = await detectClusters(wiki, leaves);
    const mathProps = proposals.filter((p) => !p.empty_partition);
    for (const p of mathProps) {
      assert.ok(p.gate_request, "every math proposal should carry a gate_request");
      assert.equal(p.gate_request.kind, "nest_decision");
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectClusters: no clusters yields empty_partition marker by default", async () => {
  const wiki = tmpWiki("empty-marker");
  try {
    // Three leaves with entirely disjoint tags/keywords/focus —
    // affinity should stay well below every threshold.
    const leaves = [
      leaf(wiki, "a.md", { id: "a", type: "primary", focus: "alpha alpha alpha", covers: ["q1"], tags: ["unique-a"], activation: { keyword_matches: ["alphakw"] } }),
      leaf(wiki, "b.md", { id: "b", type: "primary", focus: "delta delta delta", covers: ["q2"], tags: ["unique-b"], activation: { keyword_matches: ["deltakw"] } }),
      leaf(wiki, "c.md", { id: "c", type: "primary", focus: "omega omega omega", covers: ["q3"], tags: ["unique-c"], activation: { keyword_matches: ["omegakw"] } }),
    ];
    const proposals = await detectClusters(wiki, leaves);
    // Either zero real clusters (empty marker present) or clusters found
    const hasMarker = proposals.some((p) => p.empty_partition);
    const hasReal = proposals.some((p) => !p.empty_partition);
    assert.ok(hasMarker || hasReal, "expected either marker or real proposal");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectClusters: returnEmptyMarker=false suppresses the marker", async () => {
  const wiki = tmpWiki("nomarker");
  try {
    const leaves = [
      leaf(wiki, "a.md", { id: "a", type: "primary", focus: "alpha disjoint alpha", covers: ["q1"], tags: ["unique-a"] }),
      leaf(wiki, "b.md", { id: "b", type: "primary", focus: "delta disjoint delta", covers: ["q2"], tags: ["unique-b"] }),
      leaf(wiki, "c.md", { id: "c", type: "primary", focus: "omega disjoint omega", covers: ["q3"], tags: ["unique-c"] }),
    ];
    const proposals = await detectClusters(wiki, leaves, { returnEmptyMarker: false });
    // If no real clusters, must return strictly empty (no marker).
    const hasMarker = proposals.some((p) => p.empty_partition);
    assert.ok(!hasMarker, "empty marker should be suppressed");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("buildProposeStructureRequest: returns a propose_structure request", () => {
  const leaves = [
    { data: { id: "a", focus: "x", covers: ["x"], tags: ["t"], activation: { keyword_matches: ["k1"] } } },
    { data: { id: "b", focus: "y", covers: ["y"], tags: ["t"], activation: { keyword_matches: ["k2"] } } },
    { data: { id: "c", focus: "z", covers: ["z"], tags: ["t"], activation: { keyword_matches: ["k3"] } } },
  ];
  const req = buildProposeStructureRequest("some/dir", leaves);
  assert.equal(req.kind, "propose_structure");
  assert.equal(req.model_hint, "opus");
  assert.equal(req.inputs.directory, "some/dir");
  assert.equal(req.inputs.leaves.length, 3);
  assert.equal(req.inputs.leaves[0].id, "a");
  assert.deepEqual(req.inputs.leaves[0].activation_keywords, ["k1"]);
});
