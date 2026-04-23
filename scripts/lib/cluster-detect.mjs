// cluster-detect.mjs — multi-signal cluster detection for NEST.
//
// Given a set of leaves at a single depth (one directory's worth
// of children), compute an affinity matrix using several signals,
// find candidate clusters as connected components under a
// threshold, and propose NEST applications.
//
// Cluster naming depends on the active quality mode:
//   - tiered-fast / claude-first / tier0-only: proposals are named
//     by asking Tier 2 (the `cluster_name` request kind), because
//     the point of Tier 2 is to let the sub-agent exercise judgment
//     at naming time.
//   - deterministic: naming is derived locally from member
//     frontmatters via `generateDeterministicSlug` +
//     `deterministicPurpose`, bypassing the `cluster_name` request
//     entirely so the mode's "no LLM in the loop" contract holds
//     end-to-end. See these helpers' doc comments for the algorithm.
//
// Signals used for the affinity matrix:
//
//   1. Tier 0 TF-IDF cosine on focus + covers + tags
//   2. Tier 1 embedding cosine on focus + covers + first ~1 KB of body
//   3. Authored tag overlap (Jaccard)
//   4. Authored activation.keyword_matches overlap (Jaccard)
//
// Each signal is normalized into [0, 1] and summed with
// configurable weights. The default weights are:
//
//   tier0:        0.25
//   tier1:        0.40
//   tag_jaccard:  0.20
//   act_jaccard:  0.15
//
// The affinity matrix is symmetric and zero-diagonal. Clustering
// finds connected components using a union-find over edges whose
// affinity exceeds a threshold. We try multiple thresholds
// (0.30 / 0.38 / 0.46) and pick whichever partition produces the
// lowest routing_cost when we test it against the quality metric —
// so the threshold is not hand-tuned for any specific corpus, it's
// corpus-adaptive by construction.
//
// Justification for the threshold range:
//
//   0.30 is a weak floor: Tier 1 alone needs to be borderline-
//        related for this to fire when the other signals are
//        absent. Below this is noise territory.
//
//   0.38 is the midpoint of the Tier 1 decisive-same threshold
//        (0.80) and the Tier 1 decisive-different threshold
//        (0.45). Anything above this is more likely related than
//        unrelated under pure embedding evidence.
//
//   0.46 mirrors the Tier 1 decisive-different threshold
//        projected through the weighted combination — signals
//        stronger than this level in combination are a strong
//        cluster indicator.
//
// Picking the best threshold is a "use the quality metric" loop,
// not a constant — document-corpus-independent.
//
// Cluster size constraints:
//
//   - Minimum cluster size: 3. Two-leaf clusters are better
//     handled by MERGE or by the existing pairwise-merge path.
//   - Maximum cluster size: 8. Larger clusters likely hide a
//     multi-level structure that convergence will discover by
//     iterating.
//   - Single-cluster preference: if every leaf in the parent
//     ends up in the SAME cluster, we reject the proposal — the
//     parent is already a coherent category by itself.

import { readFileSync } from "node:fs";
import {
  embed as tier1Embed,
  embeddingCosine,
} from "./embeddings.mjs";
import {
  buildComparisonModel,
  computeIdf,
  cosine,
  entryText,
  tfidfVector,
  tokenize,
} from "./similarity.mjs";
import { makeRequest } from "./tier2-protocol.mjs";

// Weights for the affinity fusion. Exported so tests can swap them.
export const DEFAULT_AFFINITY_WEIGHTS = Object.freeze({
  tier0: 0.25,
  tier1: 0.40,
  tag_jaccard: 0.20,
  act_jaccard: 0.15,
});

// Candidate thresholds the detector tries. A WIDE range is the
// point of the aggressive scan: sparse-signal corpora (hand-
// authored wikis with modest pairwise similarities) will never
// cross the 0.30+ band on tf-idf-dominated affinity, so if the
// skill only scanned the conservative range it would leave every
// natural grouping flat. We push the floor down to 0.10 — "any
// detectable overlap is a candidate" — and let Tier 2 + the
// quality-metric gate filter out the noise.
//
// Why 0.10 as the floor: it's well above pure-noise affinity
// (random 300-token corpora score in the 0.00–0.04 range on tf-
// idf cosine) but low enough that a single shared tag + modest
// embedding overlap will cross it. The math proposal still has
// to pass Tier 2's nest_decision gate AND improve the routing-
// cost metric before any NEST is applied, so a false positive
// at 0.10 is caught at two later gates.
//
// Thresholds remain corpus-independent; picking a different one
// per corpus would make the algorithm non-deterministic.
export const CANDIDATE_THRESHOLDS = Object.freeze([
  0.10, 0.15, 0.20, 0.25, 0.30, 0.38, 0.46,
]);

// Minimum cluster size is split by proposal source:
//
//   - Math-only candidates need at least 3 members. Pairwise
//     similarity on two leaves is a noisy signal — a random TF-IDF
//     collision between two terse frontmatters can score > 0.10 and
//     would clutter the tree with false 2-member nests.
//
//   - Tier 2-proposed clusters can have 2 members. Tier 2 is a
//     structural judgment call by a language model that has read
//     both frontmatters; it can defend a pair on conceptual grounds
//     (e.g. "invariants + safety are the correctness substrate")
//     even when the math-based similarity alone wouldn't be
//     decisive. Pairing Tier 2's structural judgment with the
//     relaxed metric gate (5% regression tolerance) is how the
//     engine surfaces maximum nesting on hand-authored corpora with
//     heterogeneous terse frontmatters.
//
// Consumers choose the right constant based on proposal source.
// `MIN_CLUSTER_SIZE` is kept as the math default for backwards
// compatibility; size-2 Tier 2 clusters flow through a separate
// path that uses `MIN_TIER2_CLUSTER_SIZE`.
export const MIN_CLUSTER_SIZE = 3;
export const MIN_MATH_CLUSTER_SIZE = 3;
export const MIN_TIER2_CLUSTER_SIZE = 2;
export const MAX_CLUSTER_SIZE = 8;

// Reject partitions where a single component swallows more than
// this fraction of the leaves. The "one giant blob" case is
// usually a noise floor hit and is structurally useless.
export const GIANT_BLOB_FRACTION = 0.75;

// ── Coarse-partition pre-pass for flat large-diverse directories ──
//
// The HAC path above (`findComponents` + `partitionShapeScore`) is
// tuned for FINE-GRAINED sub-clustering inside already-bounded
// directories: it maximises the count of 3-8-size components at
// some candidate threshold. On a flat 600-leaf root that's the
// wrong optimisation — the best partition at any threshold is
// dominated by one giant component plus many singletons, and the
// handful of 3-8-size clusters that do emerge score poorly.
// Practical symptom: a 596-leaf hand-authored corpus observed in
// the field produced zero NEST proposals during convergence under
// `--quality-mode deterministic`, which left the balance phase to
// carve categories linearly and hit its 20-iter cap far short of
// convergence.
//
// The coarse-partition pre-pass uses deterministic K-means (farthest-
// first init + mean-member-similarity assignment) to force K top-
// level clusters when the directory's leaf count exceeds
// `COARSE_PARTITION_THRESHOLD`. K is chosen as
// `ceil(N / COARSE_TARGET_CLUSTER_SIZE)` so the average cluster
// lands around the `COARSE_TARGET_CLUSTER_SIZE` mark. Clusters
// smaller than `MIN_CLUSTER_SIZE` or larger than
// `MAX_COARSE_CLUSTER_SIZE` are rejected post-hoc — small ones
// aren't worth nesting (the `MIN_CLUSTER_SIZE` floor) and giant
// ones are usually noise-floor hits that would themselves need
// sub-clustering (the `MAX_COARSE_CLUSTER_SIZE` ceiling, 30, is
// ~4× the target so only egregiously-concentrated clusters get
// pruned — the rest pass through and balance enforcement can
// refine them in a second pass if `--fanout-target` is tight).
//
// Determinism: all ordering uses lex-first tie-breaking (first
// seed is always index 0, subsequent seeds via farthest-first,
// members iterate in leaf-array order). Two runs on the same
// corpus produce byte-identical cluster membership.
export const COARSE_PARTITION_THRESHOLD = 50;
export const COARSE_TARGET_CLUSTER_SIZE = 8;
export const MAX_COARSE_CLUSTER_SIZE = 30;
export const COARSE_KMEANS_MAX_ITERS = 20;

// Read the first ~1 KB of a leaf's body for the Tier 1 signal.
// We skip the frontmatter (between the first two `---` lines)
// and take a prefix of the remaining bytes. Short-body leaves
// return their whole body.
function readBodySample(leafPath, maxBytes = 1024) {
  try {
    const raw = readFileSync(leafPath, "utf8");
    // Strip frontmatter fence if present.
    if (raw.startsWith("---\n")) {
      const end = raw.indexOf("\n---\n", 4);
      if (end !== -1) {
        const body = raw.slice(end + 5);
        return body.slice(0, maxBytes);
      }
    }
    return raw.slice(0, maxBytes);
  } catch {
    return "";
  }
}

// Jaccard similarity between two sets (or arrays). Returns 0 for
// empty inputs so the contribution to the affinity is zero when
// the authored metadata is absent.
function jaccard(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const uni = sa.size + sb.size - inter;
  if (uni === 0) return 0;
  return inter / uni;
}

function activationKeywords(data) {
  if (!data || typeof data !== "object") return [];
  const act = data.activation;
  if (act && Array.isArray(act.keyword_matches)) {
    return act.keyword_matches.map((k) => String(k).toLowerCase());
  }
  return [];
}

// Build the affinity matrix. Each entry [i][j] is the weighted
// fusion of Tier 0, Tier 1, tag-Jaccard and activation-Jaccard
// for leaves i and j.
//
// Tier 1 embeddings are generated once per leaf and cached on
// disk via `embed()`, so calling this repeatedly on overlapping
// leaf sets is cheap after the first run.
export async function computeAffinityMatrix(wikiRoot, leaves, opts = {}) {
  const { weights = DEFAULT_AFFINITY_WEIGHTS } = opts;
  const n = leaves.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));

  // Precompute Tier 0 once across the whole leaf set.
  const corpus = leaves.map((l) => l.data);
  const model = buildComparisonModel(corpus);

  // Precompute Tier 1 vectors for each leaf. The "text" for the
  // embedding is focus + covers + tags + first ~1 KB of body.
  const tier1Texts = leaves.map((leaf) => {
    const d = leaf.data;
    const parts = [];
    if (d.focus) parts.push(d.focus);
    if (Array.isArray(d.covers)) parts.push(d.covers.join(" "));
    if (Array.isArray(d.tags)) parts.push(d.tags.join(" "));
    parts.push(readBodySample(leaf.path));
    return parts.join("\n\n");
  });
  const tier1Vectors = await Promise.all(
    tier1Texts.map((t) => tier1Embed(wikiRoot, t)),
  );

  // Precompute Tier 0 tf-idf vectors per leaf (against the
  // precomputed model).
  const tier0Vectors = leaves.map((leaf) => {
    const text = entryText(leaf.data);
    const tokens = tokenize(text);
    return tfidfVector(tokens, model.idfMap);
  });

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t0 = cosine(tier0Vectors[i], tier0Vectors[j]);
      const t1 = embeddingCosine(tier1Vectors[i], tier1Vectors[j]);
      const tagJ = jaccard(
        leaves[i].data.tags || [],
        leaves[j].data.tags || [],
      );
      const actJ = jaccard(
        activationKeywords(leaves[i].data),
        activationKeywords(leaves[j].data),
      );
      const affinity =
        weights.tier0 * clamp01(t0) +
        weights.tier1 * clamp01(t1) +
        weights.tag_jaccard * tagJ +
        weights.act_jaccard * actJ;
      matrix[i][j] = affinity;
      matrix[j][i] = affinity;
    }
  }
  return matrix;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Find connected components under a threshold using union-find.
// Returns an array of components, each is an array of leaf
// indices.
export function findComponents(matrix, threshold) {
  const n = matrix.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (matrix[i][j] >= threshold) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return Array.from(groups.values());
}

// Given a partition and the affinity matrix, produce a shape
// score used to pick the BEST threshold for a directory. The
// convergence loop still uses the real routing_cost metric as
// the final gate; this score is only for comparing candidate
// thresholds against each other inside one directory.
//
// Scoring components:
//
//   coverage        — fraction of leaves that landed in an
//                     acceptable-size component (3–8). Higher
//                     is better.
//   cluster_count   — number of acceptable-size components.
//                     Favour partitions that surface MULTIPLE
//                     clusters over ones that find only one.
//   cohesion        — average intra-cluster affinity across all
//                     acceptable components. Higher is better.
//   giant_penalty   — partitions where any component holds more
//                     than GIANT_BLOB_FRACTION of the leaves
//                     score 0. That's the "everything lumped
//                     together" degenerate case.
//
// All four components are combined into a single scalar:
//
//   score = coverage * (1 + 0.25 * (cluster_count - 1)) * (0.5 + 0.5 * cohesion)
//
// The + 0.25 * (cluster_count - 1) multiplier rewards partitions
// that find 2+ clusters — we WANT multiple clusters per pass when
// possible, since the alternative is doing nothing at this depth.
// The cohesion multiplier keeps the score sensitive to average
// intra-cluster strength even when coverage is equal across
// thresholds, so "two tight triangles at threshold 0.30" beats
// "two loose triangles at threshold 0.10" when coverage ties.
export function partitionShapeScore(partition, n, matrix = null) {
  if (partition.length === 1 && partition[0].length === n) return 0;
  const accepted = partition.filter(
    (c) => c.length >= MIN_CLUSTER_SIZE && c.length <= MAX_CLUSTER_SIZE,
  );
  if (accepted.length === 0) return 0;
  // Giant-blob rejection — any single component (even outside
  // the accepted band) that holds more than 75% of leaves kills
  // the score entirely.
  for (const c of partition) {
    if (c.length / n > GIANT_BLOB_FRACTION) return 0;
  }
  const totalInClusters = accepted.reduce((a, c) => a + c.length, 0);
  const coverage = totalInClusters / Math.max(1, n);
  const clusterMultiplier = 1 + 0.25 * (accepted.length - 1);
  let cohesion = 0;
  if (matrix) {
    let pairSum = 0;
    let pairCount = 0;
    for (const component of accepted) {
      for (let i = 0; i < component.length; i++) {
        for (let j = i + 1; j < component.length; j++) {
          pairSum += matrix[component[i]][component[j]];
          pairCount++;
        }
      }
    }
    cohesion = pairCount > 0 ? pairSum / pairCount : 0;
  }
  const cohesionMultiplier = matrix ? (0.5 + 0.5 * cohesion) : 1;
  return coverage * clusterMultiplier * cohesionMultiplier;
}

// Build a NEST proposal for a single component. Returns a proposal
// object carrying:
//
//   {
//     operator: "NEST",
//     leaves:   [<leaf>, <leaf>, ...] (the cluster members)
//     naming_request: Tier 2 cluster_name request (to be queued)
//     resolved_slug:  optional, set when fixture/runtime provides
//     average_affinity: confidence proxy
//   }
//
// The caller is responsible for enqueueing the naming request via
// tier2-protocol and, when the answer is available, invoking the
// NEST applier.
export function buildNestProposal(componentLeaves, matrix, componentIndices) {
  // Average pairwise affinity within the component.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < componentIndices.length; i++) {
    for (let j = i + 1; j < componentIndices.length; j++) {
      sum += matrix[componentIndices[i]][componentIndices[j]];
      count++;
    }
  }
  const avg = count > 0 ? sum / count : 0;

  // Build the Tier 2 naming request.
  const inputs = {
    leaves: componentLeaves.map((leaf) => ({
      id: leaf.data.id,
      focus: leaf.data.focus || "",
      covers: leaf.data.covers || [],
      tags: leaf.data.tags || [],
    })),
  };
  const request = makeRequest("cluster_name", {
    prompt:
      "These leaves are candidates for grouping into a single subcategory. " +
      "Return a short kebab-case slug (one or two words, e.g., 'history' or " +
      "'layout-modes') and a one-line purpose. The slug must be a valid " +
      "directory name and should describe the CONCEPTUAL grouping. If the " +
      "leaves are clearly unrelated, return decision 'reject' with a reason.",
    inputs,
  });

  // Companion nest_decision request: "should these N leaves
  // actually nest together, or stay flat?" The convergence loop
  // uses this as a mandatory GO/NO-GO gate on math-proposed
  // clusters — no math-only proposal is ever applied without a
  // Tier 2 nest_decision returning "nest". Tier-2-proposed
  // clusters (from propose_structure) skip this gate since
  // Tier 2 already approved them structurally.
  const gateRequest = makeRequest("nest_decision", {
    prompt:
      "Given these N sibling leaves, should they be grouped " +
      "together under a new parent subcategory? Answer 'nest' " +
      "if they share a defensible conceptual grouping that would " +
      "meaningfully improve routing, 'keep_flat' if the overlap " +
      "is incidental and nesting would add noise, or " +
      "'undecidable' if you cannot tell from the frontmatter.",
    inputs,
  });

  return {
    operator: "NEST",
    leaves: componentLeaves,
    naming_request: request,
    gate_request: gateRequest,
    average_affinity: avg,
    size: componentLeaves.length,
  };
}

// Build a propose_structure request for a whole directory. Used
// by the convergence loop as the FIRST pass on every directory:
// Tier 2 gets first dibs on the optimal partition. The response
// carries an array of subcategories (slug + purpose + member
// ids) plus siblings that should stay at root level. See
// tier2-protocol.mjs::TIER2_DEFAULTS.propose_structure for the
// response schema.
export function buildProposeStructureRequest(relativeDir, leaves) {
  const inputs = {
    directory: relativeDir || ".",
    leaves: leaves.map((leaf) => ({
      id: leaf.data.id,
      focus: leaf.data.focus || "",
      covers: Array.isArray(leaf.data.covers) ? leaf.data.covers : [],
      tags: Array.isArray(leaf.data.tags) ? leaf.data.tags : [],
      activation_keywords: activationKeywords(leaf.data),
    })),
  };
  return makeRequest("propose_structure", {
    prompt:
      "Given these N leaves in a directory, propose the optimal " +
      "nested structure. Group related leaves into named " +
      "subcategories (slug + purpose + member ids). Leaves that " +
      "genuinely stand alone should be reported as siblings. " +
      "Favour nesting over flatness whenever 2+ leaves share a " +
      "defensible conceptual grouping — err on the side of " +
      "nesting if in doubt. Return STRICT JSON matching the " +
      "response_schema; do not include any commentary.",
    inputs,
  });
}

// Coarse-partition K-means for flat large-diverse directories.
// Called from `detectClusters` when `leaves.length` exceeds
// `COARSE_PARTITION_THRESHOLD`. The HAC path used for ≤-threshold
// directories can't produce usable 3-8-sized clusters on a flat
// 600-leaf root (see the constant block at the top of the file);
// this function forces K top-level clusters via deterministic
// K-means with farthest-first seed init.
//
// Algorithm:
//
//   1. Compute the same NxN affinity matrix `detectClusters` uses
//      (Tier 0 + Tier 1 blend via `computeAffinityMatrix`). Reused
//      downstream — we do NOT recompute it in the HAC path when
//      we dispatch here.
//
//   2. Pick K = ceil(N / COARSE_TARGET_CLUSTER_SIZE) seeds via
//      farthest-first selection. First seed is leaves[0] (lex-first
//      by the caller's ordering). Each subsequent seed maximises
//      its minimum similarity-distance (1 - max(sim-to-existing))
//      so seeds spread across the similarity space.
//
//   3. Iterate assignment: each leaf → cluster whose current
//      members have the highest MEAN similarity to it. Using mean
//      member similarity rather than vector-centroid distance lets
//      us work with the existing `matrix` directly — no need to
//      expose or recompute per-leaf vectors. Stops when assignments
//      stop changing or the iteration cap fires.
//
//   4. Build proposals via `buildNestProposal`. Clusters smaller
//      than `MIN_CLUSTER_SIZE` or larger than
//      `MAX_COARSE_CLUSTER_SIZE` are rejected (small: not worth
//      nesting; giant: noise-floor concentration, leave to a
//      second pass or to balance enforcement).
//
// Returns an array of NEST proposals in
// `(average_affinity desc, member-path asc)` order. Returns `[]`
// if no cluster passed filters — the caller decides whether to
// fall back to HAC or escalate.
export async function detectCoarseClusters(wikiRoot, leaves, opts = {}) {
  if (leaves.length < MIN_CLUSTER_SIZE) return [];
  const matrix =
    opts.precomputedMatrix ??
    (await computeAffinityMatrix(wikiRoot, leaves, opts));
  const N = leaves.length;
  const K = Math.min(
    Math.ceil(N / COARSE_TARGET_CLUSTER_SIZE),
    // Guard: K cannot exceed N (degenerate) or produce clusters
    // smaller than MIN on average. ceil(N / TARGET) hits both
    // floors naturally, but pin the upper bound so a user tuning
    // TARGET down to 1 doesn't blow up.
    Math.floor(N / MIN_CLUSTER_SIZE),
  );
  if (K < 2) return []; // nothing meaningful to partition into

  // Step 1: deterministic farthest-first seeds. First seed is the
  // lex-first leaf (index 0). Each subsequent seed maximises its
  // minimum similarity-distance (1 - max(sim-to-any-existing-seed))
  // so seeds don't pile up in a dense region of the affinity graph.
  // Ties broken by index-ascending, preserving determinism.
  const seeds = [0];
  while (seeds.length < K) {
    let bestIdx = -1;
    let bestMinDist = -1;
    for (let i = 0; i < N; i++) {
      if (seeds.includes(i)) continue;
      let maxSimToSeed = -Infinity;
      for (const s of seeds) {
        if (matrix[i][s] > maxSimToSeed) maxSimToSeed = matrix[i][s];
      }
      const minDistToSeed = 1 - maxSimToSeed;
      if (minDistToSeed > bestMinDist) {
        bestMinDist = minDistToSeed;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    seeds.push(bestIdx);
  }

  // Step 2: initial assignment = nearest-seed (max similarity).
  const assignments = new Array(N);
  for (let i = 0; i < N; i++) {
    let bestK = 0;
    let bestSim = -Infinity;
    for (let k = 0; k < seeds.length; k++) {
      const sim = matrix[i][seeds[k]];
      if (sim > bestSim) {
        bestSim = sim;
        bestK = k;
      }
    }
    assignments[i] = bestK;
  }

  // Step 3: iterate. Each leaf re-assigns to the cluster whose
  // current members have the highest mean similarity to it.
  // Converges in a handful of iterations on most corpora; the
  // COARSE_KMEANS_MAX_ITERS cap is defensive against pathological
  // oscillation.
  for (let iter = 0; iter < COARSE_KMEANS_MAX_ITERS; iter++) {
    const members = Array.from({ length: seeds.length }, () => []);
    for (let i = 0; i < N; i++) members[assignments[i]].push(i);
    let changed = false;
    for (let i = 0; i < N; i++) {
      let bestK = assignments[i];
      let bestMean = -Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const mem = members[k];
        if (mem.length === 0) continue;
        let sum = 0;
        for (const m of mem) sum += matrix[i][m];
        const mean = sum / mem.length;
        if (mean > bestMean) {
          bestMean = mean;
          bestK = k;
        }
      }
      if (bestK !== assignments[i]) {
        assignments[i] = bestK;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Step 4: build proposals from each non-trivial cluster.
  const proposals = [];
  for (let k = 0; k < seeds.length; k++) {
    const componentIndices = [];
    for (let i = 0; i < N; i++) {
      if (assignments[i] === k) componentIndices.push(i);
    }
    if (componentIndices.length < MIN_CLUSTER_SIZE) continue;
    if (componentIndices.length > MAX_COARSE_CLUSTER_SIZE) continue;
    if (componentIndices.length === N) continue; // single-cluster-everything
    const componentLeaves = componentIndices.map((i) => leaves[i]);
    const proposal = buildNestProposal(componentLeaves, matrix, componentIndices);
    proposal.threshold = null; // n/a for K-means; left null to signal coarse-mode
    proposal.source = "math-coarse";
    proposals.push(proposal);
  }
  // Deterministic sort: highest-affinity clusters first, ties
  // broken by the lex-first member path so the on-disk apply
  // order is stable across runs.
  proposals.sort((a, b) => {
    if (b.average_affinity !== a.average_affinity) {
      return b.average_affinity - a.average_affinity;
    }
    const aKey = a.leaves?.[0]?.path ?? "";
    const bKey = b.leaves?.[0]?.path ?? "";
    return aKey.localeCompare(bKey);
  });
  return proposals;
}

// Detect all NEST proposals for a single parent directory's
// leaves. Tries each candidate threshold (aggressive range), picks
// the best by shape score, and emits a proposal for each
// acceptable component. If NO threshold produces a usable
// partition, returns an array carrying a single `empty_partition:
// true` marker proposal so the caller can trigger a whole-
// directory Tier 2 `propose_structure` escalation.
//
// `opts.returnEmptyMarker = false` suppresses the empty-partition
// marker and returns `[]` instead — used by tests and the
// cluster_name unit tests that don't want the marker in their
// output.
//
// Dispatch: for directories above `COARSE_PARTITION_THRESHOLD`
// leaves, skip the HAC path entirely and run the coarse K-means
// partitioner. The HAC path's shape-score optimiser is tuned for
// fine-grained sub-clustering (3-8-size components), which can't
// structure a flat large-diverse root — see the constant block.
// Coarse clusters returned in the same shape the HAC path would
// emit, so downstream (operators.mjs::tryClusterNestIteration,
// balance.mjs::runBalance) is untouched.
export async function detectClusters(wikiRoot, leaves, opts = {}) {
  const { returnEmptyMarker = true } = opts;
  if (leaves.length < MIN_CLUSTER_SIZE) return [];

  // Coarse-partition dispatch for flat large-diverse roots. This
  // path doesn't honour `returnEmptyMarker` (no empty-partition
  // marker is emitted) because Tier 2's propose_structure is the
  // wrong tool for these inputs anyway — the LLM would be asked
  // to partition 500+ leaves in one shot, which is both a huge
  // token cost and typically produces worse structure than the
  // deterministic K-means. If coarse produces zero valid clusters,
  // return empty; the caller (balance / operators) handles zero-
  // proposal days gracefully.
  if (leaves.length > COARSE_PARTITION_THRESHOLD) {
    return detectCoarseClusters(wikiRoot, leaves, opts);
  }

  const matrix = await computeAffinityMatrix(wikiRoot, leaves, opts);
  let bestPartition = null;
  let bestScore = -1;
  let bestThreshold = null;
  for (const t of CANDIDATE_THRESHOLDS) {
    const parts = findComponents(matrix, t);
    const score = partitionShapeScore(parts, leaves.length, matrix);
    if (score > bestScore) {
      bestScore = score;
      bestPartition = parts;
      bestThreshold = t;
    }
  }
  if (!bestPartition || bestScore <= 0) {
    if (returnEmptyMarker) {
      return [
        {
          operator: "NEST",
          empty_partition: true,
          leaves,
          reason:
            "aggressive threshold scan [" +
            CANDIDATE_THRESHOLDS.join(", ") +
            "] produced no acceptable partition — escalate to propose_structure",
        },
      ];
    }
    return [];
  }
  const proposals = [];
  for (const component of bestPartition) {
    if (component.length < MIN_CLUSTER_SIZE) continue;
    if (component.length > MAX_CLUSTER_SIZE) continue;
    // Reject single-cluster-everything case
    if (component.length === leaves.length) continue;
    const componentLeaves = component.map((i) => leaves[i]);
    const proposal = buildNestProposal(componentLeaves, matrix, component);
    proposal.threshold = bestThreshold;
    proposal.source = "math";
    proposals.push(proposal);
  }
  // Sort by average_affinity descending so the strongest proposal
  // is applied first each iteration.
  proposals.sort((a, b) => b.average_affinity - a.average_affinity);
  return proposals;
}

// Deterministic slug generator for the `deterministic` quality mode.
// Given a cluster's member leaves and optional corpus context (for
// IDF), returns a reproducible kebab-case slug derived from the
// members' frontmatter terms alone — no LLM, no network, no
// randomness. Repeated invocations on the same inputs always return
// the same slug; shuffling the member order never changes the output.
//
// Algorithm:
//
//   1. Build a TF-IDF vector over each member's `entryText` (focus +
//      covers + tags + domains) using the supplied corpus context
//      for IDF weighting. Without context, members form their own
//      micro-corpus — less semantically interesting but still
//      deterministic.
//   2. Sum the per-member vectors (weights stay dominated by terms
//      that are rare in the corpus but common inside the cluster —
//      exactly the "distinguishing" terms we want in the slug).
//   3. Rank terms by (weight desc, term asc). The lex tie-break is
//      the ONLY source of determinism when two terms share a weight.
//   4. Walk the ranked list, taking the first 1–2 terms that are
//      valid slug components (lowercase, ≥ 2 chars, start with a
//      letter, pass the `SLUG_RE` check when joined).
//   5. If still no valid slug (terse frontmatters, every top term
//      numeric/short), fall back to a 7-hex-char content hash of
//      the sorted member ids — deterministic in its inputs, but NOT
//      globally unique. Seven hex characters is ~28 bits of entropy
//      from a truncated FNV-1a-32 output, so hash collisions are
//      mathematically possible (~0.1% collision rate at 1000 distinct
//      clusters per the birthday bound). That's fine at this layer:
//      the caller passes every slug — hash-derived or term-derived —
//      through `resolveNestSlug` next, which auto-suffixes any
//      collision with an existing id / alias / directory basename
//      into the `-group`/`-group-N` deterministic sequence. The hash
//      fallback just needs to be reproducible from the same inputs,
//      not collision-free across the whole corpus.
//
// The caller (operators.mjs::tryClusterNestIteration) passes the
// result through `resolveNestSlug` so collisions with existing ids
// auto-suffix deterministically.
//
// `opts.precomputedIdf` lets the caller share an IDF map across
// sibling clusters in the same directory — cuts the per-candidate
// cost from `O(|corpus|)` tokenization + IDF to `O(|cluster|)`
// tokenization alone. Semantically identical to a fresh derivation
// from the passed `corpusContext`; pass whichever you already have.
export function generateDeterministicSlug(
  componentLeaves,
  corpusContext,
  opts = {},
) {
  // Sort members by a stable key BEFORE building text/token lists.
  // Floating-point summation is order-sensitive, so an unsorted input
  // could theoretically flip near-tie ordering under shuffled input.
  // Sorting on leaf id (path fallback for tests that omit id) removes
  // that entire class of ambiguity at trivial cost.
  // Normalise each member: accept either a leaf wrapper `{ path, data }`
  // or a plain frontmatter object (the shape corpusContext also
  // tolerates below). Without this, a caller passing plain frontmatter
  // would hit `entryText(undefined)` for every member, producing empty
  // token lists and collapsing every such cluster onto the identical
  // `cluster-<hash>` fallback — so multiple unrelated clusters could
  // end up with the same slug. Symmetrising with the corpusContext
  // path closes that footgun.
  const normalisedMembers = componentLeaves.map((leaf) => ({
    data: leaf?.data ?? leaf,
    path: leaf?.path,
  }));
  const stableMembers = [...normalisedMembers].sort((a, b) => {
    const ka = a?.data?.id ?? a?.path ?? "";
    const kb = b?.data?.id ?? b?.path ?? "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const tokenLists = stableMembers.map((leaf) => tokenize(entryText(leaf.data)));
  // IDF context: precomputed > corpusContext > cluster itself.
  const idfMap =
    opts.precomputedIdf ??
    (corpusContext && corpusContext.length > 0
      ? computeIdf(
          corpusContext.map((e) => tokenize(entryText(e.data ?? e))),
        )
      : computeIdf(tokenLists));
  // Per-member tf-idf, then sum into a single cluster-wide vector.
  // Stable member order + lex tie-break on the final ranking below
  // means the output is byte-identical regardless of caller-side
  // ordering.
  const sum = new Map();
  for (const tokens of tokenLists) {
    const vec = tfidfVector(tokens, idfMap);
    for (const [term, weight] of vec) {
      sum.set(term, (sum.get(term) ?? 0) + weight);
    }
  }
  // Rank: weight desc, term asc (lex tie-break → determinism).
  const ranked = Array.from(sum.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;
  const VALID_TOKEN = /^[a-z][a-z0-9]*$/;
  // Collect up to MAX_TOKENS_TO_CONSIDER ranked tokens, bounded to
  // keep the O(n²) pair search below fast on corpora with many
  // distinct terms. The pair search checks `C(n, 2) = n·(n−1)/2`
  // combinations, so with n=16 that's at most 120 candidate slugs
  // to test — trivial, and far more than practical frontmatters
  // actually supply in their combined focus + covers + tags
  // token bag.
  const MAX_TOKENS_TO_CONSIDER = 16;
  const takeable = [];
  for (const [term] of ranked) {
    if (!VALID_TOKEN.test(term)) continue;
    takeable.push(term);
    if (takeable.length >= MAX_TOKENS_TO_CONSIDER) break;
  }
  // Priority 1: highest-ranked TWO tokens that, when joined with "-",
  // produce a valid SLUG_RE slug. The outer loop walks rank-first;
  // the inner loop fills the second slot. Because both axes march
  // top-to-bottom in ranked order, the first valid combo we find is
  // the one carrying the highest total rank weight — semantically
  // the "best" two-term slug.
  //
  // Bugfix vs. the v1 impl, which stopped after the top 2 ranked
  // tokens and fell back to the hash whenever that specific combo
  // overflowed SLUG_RE's 64-char cap. Walking further ranked terms
  // surfaces a valid slug in every case where member frontmatters
  // supply at least one kebab-compatible short pair, instead of
  // producing an opaque `cluster-<hash>` when a valid slug was
  // reachable just one rank away.
  for (let i = 0; i < takeable.length; i++) {
    for (let j = i + 1; j < takeable.length; j++) {
      const candidate = `${takeable[i]}-${takeable[j]}`;
      if (SLUG_RE.test(candidate)) return candidate;
    }
  }
  // Priority 2: highest-ranked SINGLE token that passes SLUG_RE.
  // Walks in ranked order for the same reason.
  for (const term of takeable) {
    if (SLUG_RE.test(term)) return term;
  }
  // Deterministic hash fallback — member ids sorted lex, hashed.
  // Use the normalisedMembers we built earlier so plain-frontmatter
  // callers get a stable hash too (their id lives at `.data.id` after
  // normalisation, not `.id` directly).
  const sortedIds = normalisedMembers
    .map((leaf) => leaf?.data?.id ?? leaf?.path ?? "")
    .filter(Boolean)
    .sort();
  const hash = hashString(sortedIds.join("|")).slice(0, 7);
  return `cluster-${hash}`;
}

// Build an IDF map over a sibling leaf set once, for reuse across
// multiple `generateDeterministicSlug` calls on clusters within the
// same parent directory. Every candidate cluster under a given parent
// shares the same corpus context, so computing IDF once per directory
// — rather than once per candidate — is strictly better for any
// directory with ≥ 2 candidate clusters. Drop the return value into
// `generateDeterministicSlug(.., .., { precomputedIdf: idfMap })`.
export function buildSiblingIdfContext(siblings) {
  const tokenLists = siblings.map((leaf) =>
    tokenize(entryText(leaf?.data ?? leaf)),
  );
  return computeIdf(tokenLists);
}

// Deterministic purpose for the NEST stub's `focus:` field. Picks the
// single cover phrase that appears in the most member frontmatters
// (with lex tie-breaking for reproducibility). When members share no
// covers, falls back to the focus of the member whose id sorts first
// — still deterministic, still driven by member content alone.
//
// Accepts either `{ path, data }` leaf wrappers or plain frontmatter
// objects. Input is normalised via `leaf?.data ?? leaf` at the top so
// this helper matches `generateDeterministicSlug` + `buildSiblingIdfContext`'s
// API shape — callers can pass whichever form they already have
// without getting silent empty results for the plain-object path.
export function deterministicPurpose(componentLeaves) {
  const normalised = componentLeaves.map((leaf) => leaf?.data ?? leaf);
  const counts = new Map();
  for (const data of normalised) {
    const covers = Array.isArray(data?.covers) ? data.covers : [];
    const seenInLeaf = new Set();
    for (const cover of covers) {
      const key = typeof cover === "string" ? cover.trim() : "";
      if (!key || seenInLeaf.has(key)) continue;
      seenInLeaf.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size > 0) {
    const ranked = Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    return ranked[0][0];
  }
  const sorted = normalised
    .map((data) => ({ id: data?.id ?? "", focus: data?.focus ?? "" }))
    .filter((x) => x.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted[0]?.focus ?? "";
}

// Local helper — a simple, stable non-crypto hash. `createHash` would
// be fine but adds a node:crypto import and is overkill for a 7-char
// slug suffix. FNV-1a 32-bit is widely used, stable across Node
// versions, and deterministic on the same string input.
function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

