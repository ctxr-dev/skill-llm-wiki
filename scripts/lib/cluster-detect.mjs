// cluster-detect.mjs — multi-signal cluster detection for NEST.
//
// Given a set of leaves at a single depth (one directory's worth
// of children), compute an affinity matrix using several signals,
// find candidate clusters as connected components under a
// threshold, and propose NEST applications. Every proposal is
// named by asking Tier 2 (cluster_name kind) — we never invent
// names from keyword shortcuts, because the whole point of Tier 2
// is to let the sub-agent exercise judgment at naming time.
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
export async function detectClusters(wikiRoot, leaves, opts = {}) {
  const { returnEmptyMarker = true } = opts;
  if (leaves.length < MIN_CLUSTER_SIZE) return [];
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
