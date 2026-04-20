// operators.mjs — the four (plus one) rewrite operators from
// methodology §3.5:
//
//   DESCEND — push leaf-style content out of a parent index down
//             into a new or existing child leaf.
//   LIFT    — flatten a folder that contains exactly one entry by
//             moving the entry up to the parent directory.
//   MERGE   — fuse two siblings whose focus/covers overlap enough
//             that keeping them separate is pure redundancy.
//   NEST    — extract multiple H2 specialisations out of one leaf
//             into a child folder (stubbed in Phase 6 — H2 body
//             reading is not yet wired through the chunked iterator
//             so we detect but do not apply).
//   DECOMPOSE — split one leaf into multiple peer entries when its
//             `covers[]` cluster into disjoint groups (stubbed for
//             the same reason).
//
// Tie-break priority (methodology §3.5): DESCEND > LIFT > MERGE >
// NEST > DECOMPOSE. Reducing moves (DESCEND, LIFT, MERGE) fire
// before expanding moves (NEST, DECOMPOSE) so expansion never
// wastes effort on structure that was going to collapse anyway.
//
// Phase 6 ships: LIFT, MERGE, DESCEND detection + application.
// NEST and DECOMPOSE are detected and reported as suggestions for
// the shape-check audit trail but NOT applied — their application
// requires frontmatter rewrites + folder creation that Phase 6's
// scope deliberately keeps out of the operator loop.
//
// Every similarity decision flows through `tiered.mjs`. Every
// operator application goes through `git add` + `git commit` via
// the orchestrator between iterations.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { collectFrontmatterOnly } from "./chunk.mjs";
import { listChildren, rebuildAllIndices } from "./indices.mjs";
import { buildComparisonModel } from "./similarity.mjs";
import {
  countPendingRequests,
  decide,
  enqueuePending,
  getResolvedResponse,
  takePendingRequests,
} from "./tiered.mjs";
import {
  buildProposeStructureRequest,
  detectClusters,
  MAX_CLUSTER_SIZE,
  MIN_CLUSTER_SIZE,
  MIN_MATH_CLUSTER_SIZE,
  MIN_TIER2_CLUSTER_SIZE,
} from "./cluster-detect.mjs";
import { applyNest, resolveNestSlug, validateSlug } from "./nest-applier.mjs";
import { computeRoutingCost } from "./quality-metric.mjs";
import { loadFixture, resolveFromFixture } from "./tier2-protocol.mjs";
import { appendMetricTrajectory, appendNestDecision } from "./decision-log.mjs";

// Max iterations the convergence loop will run before declaring
// termination. The methodology's convergence argument proves it
// halts, but we still cap defensively in case two operators
// interact pathologically.
const MAX_CONVERGENCE_ITERATIONS = 20;

// Each operator returns an array of `Proposal` objects describing
// a change to apply. The loop priority-orders proposals, applies
// the highest-priority one, commits, and re-runs detection.
//
// A proposal has:
//   operator  — "LIFT" | "MERGE" | "DESCEND" | "NEST" | "DECOMPOSE"
//   priority  — numeric: higher = applied first
//   sources   — array of absolute paths affected
//   apply     — function({ wikiRoot, opId, decisionCtx }) → Promise<{ summary }>
//   describe  — short human-readable description for the commit message

const PRIORITY = {
  DESCEND: 5,
  LIFT: 4,
  MERGE: 3,
  NEST: 2,
  DECOMPOSE: 1,
};

// ── LIFT ──────────────────────────────────────────────────────────────
//
// Detection: a non-root directory that contains exactly one leaf
// file and no indexed subdirs. Apply: move the leaf up one level,
// delete the now-empty folder.
export function detectLift(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    if (dir === wikiRoot) continue;
    const { leaves, subdirs } = listChildren(dir);
    if (leaves.length === 1 && subdirs.length === 0) {
      const leaf = leaves[0];
      proposals.push({
        operator: "LIFT",
        priority: PRIORITY.LIFT,
        sources: [leaf.path, dir],
        describe: `LIFT ${basename(leaf.path)} out of ${basename(dir)}/`,
        apply: async () => applyLift(wikiRoot, dir, leaf),
      });
    }
  }
  return proposals;
}

async function applyLift(wikiRoot, dir, leaf) {
  const parentDir = dirname(dir);
  const newPath = join(parentDir, basename(leaf.path));
  if (existsSync(newPath)) {
    throw new Error(
      `LIFT: target ${newPath} already exists; refusing to overwrite`,
    );
  }
  // Update the leaf's parents[] to point at the new parent index.
  // When the new location is the wiki root, the parent path is
  // `index.md` (sibling-form). When the new location is still
  // nested, the parent path is `../index.md`. Writing the canonical
  // form here matches `rebuildIndex.parents` derivation and avoids
  // escape-above-root chains when lifting to depth 0.
  const raw = readFileSync(leaf.path, "utf8");
  const { data, body } = parseFrontmatter(raw, leaf.path);
  if (Array.isArray(data.parents)) {
    const liftedToRoot = parentDir === wikiRoot;
    data.parents = [liftedToRoot ? "index.md" : "../index.md"];
  }
  writeFileSync(newPath, renderFrontmatter(data, body), "utf8");
  rmSync(leaf.path, { force: true });
  // Remove the now-empty folder. If there's a stale index.md in it,
  // remove that too (it was just the category stub).
  const stubIndex = join(dir, "index.md");
  if (existsSync(stubIndex)) rmSync(stubIndex, { force: true });
  // Only remove the directory if it's empty — defensive in case
  // the detector saw 1 leaf but a newer file appeared. We use
  // recursive+force for the remove because `rmSync(..., { recursive:
  // false })` silently no-ops on any non-empty dir (including one
  // with a hidden .DS_Store), which would leave a stale folder
  // behind and break the test and the convergence loop.
  try {
    const remaining = readdirSync(dir);
    if (remaining.length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
  return { summary: `lifted ${data.id} to ${relative(wikiRoot, newPath)}` };
}

// ── MERGE ─────────────────────────────────────────────────────────────
//
// Detection: pairs of sibling leaves whose tiered similarity check
// says "same". Apply: produce a merged entry carrying the union
// of covers[] (deduped), the more general focus, both source ids as
// aliases, and delete the second source leaf.
export async function detectMerge(wikiRoot, ctx) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const { leaves } = listChildren(dir);
    if (leaves.length < 2) continue;
    // Compute the sibling-corpus IDF model ONCE per directory and
    // reuse it across every pair. This changes detectMerge's inner
    // cost from O(N² × N) tokenise+idf to O(N) tokenise+idf + O(N²)
    // cosine. For a 1000-entry directory that's the difference
    // between 10⁹ and 10⁶ operations.
    const corpus = leaves.map((l) => l.data);
    const model = buildComparisonModel(corpus);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i];
        const b = leaves[j];
        const r = await decide(a.data, b.data, corpus, {
          wikiRoot,
          opId: ctx.opId,
          operator: "MERGE",
          qualityMode: ctx.qualityMode,
          interactive: ctx.interactive,
          tier2Handler: ctx.tier2Handler,
          precomputedModel: model,
        });
        if (r.decision === "same") {
          proposals.push({
            operator: "MERGE",
            priority: PRIORITY.MERGE,
            sources: [a.path, b.path],
            describe: `MERGE ${a.data.id} + ${b.data.id} (tier ${r.tier}, sim ${r.similarity.toFixed(2)})`,
            apply: async () => applyMerge(wikiRoot, a, b, r),
          });
        }
      }
    }
  }
  return proposals;
}

async function applyMerge(wikiRoot, a, b, decision) {
  // Keep the entry with the longer focus (more specific + usually
  // more authored) as the survivor. The other becomes an alias.
  const [keeper, absorbed] =
    (a.data.focus?.length ?? 0) >= (b.data.focus?.length ?? 0)
      ? [a, b]
      : [b, a];
  const rawKeeper = readFileSync(keeper.path, "utf8");
  const { data, body } = parseFrontmatter(rawKeeper, keeper.path);

  // Refuse to merge if the entries carry incompatible structural
  // metadata — we cannot silently pick one over the other.
  const structuralFields = ["type", "depth_role"];
  for (const field of structuralFields) {
    const kv = data[field];
    const av = absorbed.data[field];
    if (kv !== undefined && av !== undefined && kv !== av) {
      throw new Error(
        `MERGE: cannot merge ${keeper.data.id} and ${absorbed.data.id}: ` +
          `conflicting "${field}" (${kv} vs ${av})`,
      );
    }
  }

  // Union array-valued authored fields (covers, tags, domains)
  // preserving keeper order first, then absorbed's unique entries.
  const unionArray = (keeperField, absorbedField) => {
    const merged = new Set(Array.isArray(keeperField) ? keeperField : []);
    if (Array.isArray(absorbedField)) {
      for (const item of absorbedField) merged.add(item);
    }
    return Array.from(merged);
  };
  data.covers = unionArray(data.covers, absorbed.data.covers);
  if (Array.isArray(data.tags) || Array.isArray(absorbed.data.tags)) {
    data.tags = unionArray(data.tags, absorbed.data.tags);
  }
  if (Array.isArray(data.domains) || Array.isArray(absorbed.data.domains)) {
    data.domains = unionArray(data.domains, absorbed.data.domains);
  }

  // Union parents[] so the absorbed's cross-references survive.
  // The methodology's DAG semantics make `parents[0]` canonical, so
  // the keeper's first parent wins; additional parents from absorbed
  // are appended as soft parents.
  if (Array.isArray(absorbed.data.parents)) {
    const parents = new Set(data.parents ?? []);
    for (const p of absorbed.data.parents) parents.add(p);
    data.parents = Array.from(parents);
  }

  // Aliases: absorbed's id + any aliases it already had, deduped,
  // and we never alias the keeper to itself.
  const aliases = new Set(data.aliases ?? []);
  aliases.add(absorbed.data.id);
  for (const al of absorbed.data.aliases ?? []) aliases.add(al);
  aliases.delete(data.id);
  data.aliases = Array.from(aliases);

  writeFileSync(keeper.path, renderFrontmatter(data, body), "utf8");
  rmSync(absorbed.path, { force: true });
  return {
    summary:
      `merged ${absorbed.data.id} into ${keeper.data.id} ` +
      `(tier ${decision.tier}, sim ${decision.similarity.toFixed(3)})`,
  };
}

// ── DESCEND ───────────────────────────────────────────────────────────
//
// Detection: an index.md whose body authored zone exceeds a byte
// budget OR contains leaf-content signatures (code fences, checklists,
// multi-paragraph domain exposition).
//
// Apply: carve the authored zone into a new leaf file under the same
// directory, clear the authored zone on the index, and link the leaf
// from the parent.
const DESCEND_AUTHORED_BUDGET = 2048;
const LEAF_SIGNATURES = [
  /^\s*```/m,          // code fence
  /^\s*- \[ \]/m,      // checkbox list
  /^\s*\d+\.\s+\S+\n\s*\d+\.\s+\S+/m, // numbered list with 2+ items
];

export function detectDescend(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const indexPath = join(dir, "index.md");
    if (!existsSync(indexPath)) continue;
    const raw = readFileSync(indexPath, "utf8");
    let parsed;
    try {
      parsed = parseFrontmatter(raw, indexPath);
    } catch {
      continue;
    }
    const authored = extractAuthoredZone(parsed.body);
    if (!authored) continue;
    let reason = null;
    if (authored.length > DESCEND_AUTHORED_BUDGET) {
      reason = `authored zone is ${authored.length} bytes (budget ${DESCEND_AUTHORED_BUDGET})`;
    }
    for (const re of LEAF_SIGNATURES) {
      if (re.test(authored)) {
        reason = reason || "authored zone contains leaf-content signature";
        break;
      }
    }
    if (!reason) continue;
    proposals.push({
      operator: "DESCEND",
      priority: PRIORITY.DESCEND,
      sources: [indexPath],
      describe: `DESCEND content from ${relative(wikiRoot, indexPath)}: ${reason}`,
      apply: async () => applyDescend(wikiRoot, indexPath, parsed, authored, reason),
    });
  }
  return proposals;
}

function extractAuthoredZone(body) {
  if (!body) return "";
  const start = body.indexOf("<!-- BEGIN AUTHORED ORIENTATION -->");
  const end = body.indexOf("<!-- END AUTHORED ORIENTATION -->");
  if (start === -1 || end === -1) return "";
  return body.slice(start + "<!-- BEGIN AUTHORED ORIENTATION -->".length, end).trim();
}

async function applyDescend(wikiRoot, indexPath, parsed, authored, reason) {
  const dir = dirname(indexPath);
  // Create a leaf named `descended-content-<N>.md` where N is the
  // lowest free number. Deterministic and stable.
  let n = 1;
  let leafPath;
  while (true) {
    leafPath = join(dir, `descended-content-${n}.md`);
    if (!existsSync(leafPath)) break;
    n++;
  }
  const id = `descended-content-${n}`;
  const leafData = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: `content descended from ${parsed.data.id ?? basename(dir)}`,
    covers: ["content moved from parent index authored zone"],
    parents: ["index.md"],
    tags: ["descended"],
  };
  const leafBody = `\n${authored}\n`;
  writeFileSync(leafPath, renderFrontmatter(leafData, leafBody), "utf8");
  // Clear the authored zone in the parent index, leaving the
  // delimiter comments intact so future rebuilds preserve the
  // contract contract.
  const newBody = parsed.body.replace(
    /<!-- BEGIN AUTHORED ORIENTATION -->[\s\S]*?<!-- END AUTHORED ORIENTATION -->/,
    "<!-- BEGIN AUTHORED ORIENTATION -->\n<!-- END AUTHORED ORIENTATION -->",
  );
  writeFileSync(indexPath, renderFrontmatter(parsed.data, newBody), "utf8");
  return { summary: `descended content from ${relative(wikiRoot, indexPath)} into ${id}.md (${reason})` };
}

// ── NEST + DECOMPOSE (detection only in Phase 6) ─────────────────────

export function detectNestAndDecompose(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const { leaves } = listChildren(dir);
    for (const leaf of leaves) {
      // DECOMPOSE signal: covers[] >= 12 items. Phase 6 reports this
      // as a non-applying proposal so the shape-check log records it
      // but convergence does not rewrite the tree.
      const covers = leaf.data.covers ?? [];
      if (covers.length >= 12) {
        proposals.push({
          operator: "DECOMPOSE",
          priority: PRIORITY.DECOMPOSE,
          sources: [leaf.path],
          describe: `DECOMPOSE candidate ${leaf.data.id} (covers=${covers.length}) — application deferred`,
          apply: async () => ({ summary: "detect-only (Phase 6 defers application)" }),
          detectOnly: true,
        });
      }
      // NEST signal: explicit nests_into[] hint in frontmatter.
      const nestsInto = Array.isArray(leaf.data.nests_into)
        ? leaf.data.nests_into
        : null;
      if (nestsInto && nestsInto.length > 0) {
        proposals.push({
          operator: "NEST",
          priority: PRIORITY.NEST,
          sources: [leaf.path],
          describe: `NEST candidate ${leaf.data.id} (nests_into ${nestsInto.length}) — application deferred`,
          apply: async () => ({ summary: "detect-only (Phase 6 defers application)" }),
          detectOnly: true,
        });
      }
    }
  }
  return proposals;
}

// ── Orchestrator entry point ─────────────────────────────────────────
//
// `runConvergence(wikiRoot, ctx)` — called from orchestrator.mjs's
// operator-convergence phase. Runs detect → highest-priority apply
// → repeat until no applied proposals or the iteration budget is
// exhausted. Returns a summary of what happened for commit messages
// and phase records.
//
// Phase 8 overhaul: the loop now also runs the multi-signal
// cluster detector (cluster-detect.mjs) after the pairwise
// operators. When a cluster proposal survives and can be named
// (via fixture / runtime-resolved Tier 2 responses), the NEST
// applier rehouses the leaves into a new subcategory and the
// parent indices are regenerated. When naming cannot be resolved
// immediately, the request sits in the Tier 2 pending queue and
// the caller (orchestrator) can drain it into a batch + exit 7.
//
// Quality-metric gating: every proposed change is scored against
// the routing_cost metric. If the metric doesn't improve after
// applying the change, we roll back to the pre-change disk state
// and try the next proposal. This is the "let data pick the
// cluster" discipline — we never apply a cluster just because the
// affinity matrix liked it, we apply it only if the resulting
// tree routes queries more cheaply than the pre-change tree.

export async function runConvergence(wikiRoot, ctx = {}) {
  const {
    opId,
    qualityMode = "tiered-fast",
    maxIterations = MAX_CONVERGENCE_ITERATIONS,
    interactive = false,
    tier2Handler,
    commitBetweenIterations = async () => {},
    // tests that don't want cluster behaviour pass skipClusterNest
    // explicitly; `LLM_WIKI_SKIP_CLUSTER_NEST=1` is the env-var
    // shorthand for legacy tiered-build tests that exercise the
    // pairwise tiered-AI path without a propose_structure fixture.
    skipClusterNest = process.env.LLM_WIKI_SKIP_CLUSTER_NEST === "1",
  } = ctx;
  const applied = [];
  const suggestions = [];
  const metricTrajectory = [];
  // Directories that were freshly created by a NEST application
  // in this convergence run. We skip cluster detection inside
  // them for the remainder of the run to prevent noise-driven
  // infinite re-clustering: the newly-created subcategory
  // already represents a coherent group, and re-nesting within
  // it should wait for a separate run where the operator can
  // review the shape.
  const nestedParents = new Set();
  let iteration = 0;

  // Baseline metric (for the trajectory log).
  try {
    metricTrajectory.push({
      iteration: 0,
      cost: computeRoutingCost(wikiRoot).cost,
      event: "baseline",
    });
  } catch {
    /* empty wikis return 0 cost; ignore */
  }

  while (iteration < maxIterations) {
    iteration++;
    const proposals = [];
    // Detect in priority order. DESCEND first (reducing), then LIFT,
    // MERGE, and the detect-only NEST / DECOMPOSE at the bottom.
    proposals.push(...detectDescend(wikiRoot));
    proposals.push(...detectLift(wikiRoot));
    proposals.push(
      ...(await detectMerge(wikiRoot, { opId, qualityMode, interactive, tier2Handler })),
    );
    const nestDecompose = detectNestAndDecompose(wikiRoot);
    proposals.push(...nestDecompose);

    // Filter out detect-only proposals from the application queue
    // but keep them in the suggestion audit trail.
    for (const p of nestDecompose) {
      suggestions.push({
        operator: p.operator,
        sources: p.sources,
        reason: p.describe,
      });
    }
    const applicable = proposals.filter((p) => !p.detectOnly);

    if (applicable.length > 0) {
      // Pick the highest-priority proposal and apply it.
      applicable.sort((a, b) => b.priority - a.priority);
      const chosen = applicable[0];
      let result;
      try {
        result = await chosen.apply({ wikiRoot, opId });
      } catch (err) {
        throw new Error(
          `operator-convergence: ${chosen.operator} failed: ${err.message}`,
        );
      }
      applied.push({
        iteration,
        operator: chosen.operator,
        sources: chosen.sources,
        describe: chosen.describe,
        result,
      });
      await commitBetweenIterations({
        iteration,
        operator: chosen.operator,
        summary: result.summary,
      });
      try {
        metricTrajectory.push({
          iteration,
          cost: computeRoutingCost(wikiRoot).cost,
          event: chosen.operator,
        });
      } catch {
        /* ignore */
      }
      continue; // next iteration
    }

    // No pairwise operator fired. Try cluster-based NEST.
    if (skipClusterNest) break;
    const nestOutcome = await tryClusterNestIteration(wikiRoot, {
      opId,
      iteration,
      applied,
      suggestions,
      metricTrajectory,
      commitBetweenIterations,
      nestedParents,
    });
    if (nestOutcome === "applied") continue;
    if (nestOutcome === "pending-tier2") {
      // Unresolved cluster_name requests are parked on the pending
      // queue. The orchestrator picks them up via drainPending().
      break;
    }
    // "none" — nothing else to do, terminate.
    break;
  }

  const pendingTier2 = countPendingRequests(wikiRoot);

  // Write the metric trajectory into decisions.yaml. Runs even
  // for a single-point baseline (so an op that applied zero
  // operators still leaves a record that convergence ran + what
  // the baseline cost was). This is the "fix rebuild decision
  // logging" patch: rebuild didn't apply any pairwise operators,
  // so the old code never wrote a decision entry at all — the
  // trajectory writer now guarantees every op leaves an audit
  // trail regardless of whether it mutated anything.
  if (opId && metricTrajectory.length > 0) {
    try {
      appendMetricTrajectory(wikiRoot, opId, metricTrajectory);
    } catch {
      /* best effort — decision log is a nice-to-have for rebuild */
    }
  }

  return {
    iterations: iteration,
    applied,
    suggestions,
    metric_trajectory: metricTrajectory,
    needs_tier2: pendingTier2 > 0,
    pending_count: pendingTier2,
    converged:
      applied.length === 0 ||
      (iteration < maxIterations && pendingTier2 === 0),
  };
}

// Helper: given a wiki, try to apply a cluster NEST through the
// multi-tier propose_structure + math-detect pipeline.
//
// Per-directory flow (depth-first, root → subcategories):
//
//   1. Emit a propose_structure Tier 2 request for the directory's
//      leaves. Tier 2 proposes the "ideal" nested partition.
//   2. Run the math cluster detector (aggressive thresholds) as
//      a sanity check + source of additional proposals Tier 2
//      might have missed.
//   3. Merge: Tier 2 subcategories + math clusters, deduplicated
//      by member set.
//   4. For each math-only candidate, emit a `nest_decision`
//      request — Tier 2 must GO/NO-GO the math proposal before
//      it is applied.
//   5. For each approved candidate, either use Tier 2's slug
//      (propose_structure) or emit a `cluster_name` request
//      (math-only with no existing slug).
//   6. Apply each approved NEST through the applyNest helper.
//      The quality-metric gate rolls back any application that
//      regresses routing_cost.
//
// Returns one of:
//   "applied"       — a NEST fired, commit emitted.
//   "pending-tier2" — at least one Tier 2 request is still
//                     unresolved. The caller exits 7.
//   "none"          — no candidates, all candidates rejected, or
//                     all candidates failed the metric gate.
async function tryClusterNestIteration(wikiRoot, ctx) {
  const {
    opId,
    iteration,
    applied,
    suggestions,
    metricTrajectory,
    commitBetweenIterations,
    nestedParents = new Set(),
  } = ctx;

  // Collect candidate proposals across every parent directory.
  // For each directory:
  //   - propose_structure → Tier 2 subcategories (tier2-proposed)
  //   - math detector → math clusters (math-gated)
  //
  // Phase 5 batching overhaul: the loop walks EVERY directory in a
  // single pass and accumulates every pending Tier 2 request into
  // the shared pending queue. It does NOT short-circuit when a
  // propose_structure request parks — math cluster detection still
  // runs for that directory so any math-only candidates can emit
  // their own gate/naming requests in the same batch. The tree
  // state is identical across every directory visited in this
  // pass (no NEST has been applied yet), so every response that
  // comes back is consistent with the same base tree.
  //
  // The old "skip math if propose_structure parked" short-circuit
  // was a size-minimisation heuristic: it avoided enqueuing math
  // gate/naming requests for clusters that propose_structure might
  // reject outright. In practice that optimisation costs MORE
  // round trips than it saves, because each parked dir forces a
  // separate exit-7 cycle instead of being batched with its
  // siblings. The cost of a few "wasted" gate/naming requests is
  // one sub-agent per request (cheap) — the cost of an extra exit-7
  // cycle is an entire CLI preflight + resume rebuild (expensive).
  // We batch maximally and let `mergeClusterProposals` + the
  // stale-candidate guard deduplicate the fallout.
  const fixture = loadFixture();
  const dirs = walkDirs(wikiRoot);
  const allCandidates = [];
  for (const dir of dirs) {
    if (nestedParents.has(dir)) continue;
    const { leaves } = listChildren(dir);
    // Skip directories that cannot produce a non-trivial partition.
    // `MIN_TIER2_CLUSTER_SIZE` is the floor on ONE cluster's members —
    // a directory with only that many leaves could at most fold them
    // all into a single subcategory, which would be a trivial
    // rename rather than a structural improvement. We therefore
    // require strictly more than `MIN_TIER2_CLUSTER_SIZE` leaves
    // (i.e., ≥ MIN_TIER2_CLUSTER_SIZE + 1) before we even ask
    // Tier 2 for a structure proposal. Skipping the ≤-floor case
    // cuts a documented source of wasted Tier 2 round trips: every
    // newly-created subcategory that convergence visits on its next
    // pass gets this trivial keep-flat answer for free without
    // paying for a propose_structure request.
    if (leaves.length < MIN_TIER2_CLUSTER_SIZE + 1) continue;

    const relDir = relative(wikiRoot, dir) || ".";

    // Step 1: propose_structure Tier 2 request. Park on pending
    // without short-circuiting the math phase below.
    let tier2Clusters = [];
    const proposeReq = buildProposeStructureRequest(relDir, leaves);
    const proposeResp = resolveTier2Response(wikiRoot, fixture, proposeReq);
    if (proposeResp === "pending") {
      enqueuePending(wikiRoot, proposeReq);
      suggestions.push({
        operator: "NEST",
        sources: leaves.map((l) => l.path),
        reason: `propose_structure parked for ${relDir} (awaiting Tier 2)`,
      });
      // Fall through — math still runs so any cluster this dir
      // carries is evaluated (and its gate/naming requests are
      // batched alongside every other directory's) before we exit 7.
    } else {
      tier2Clusters = extractTier2Clusters(proposeResp, leaves, dir);
    }

    // Step 2: math cluster detection (aggressive scan).
    const mathProposals = await detectClusters(wikiRoot, leaves, {
      returnEmptyMarker: false,
    });
    const mathClusters = mathProposals
      .filter((p) => !p.empty_partition)
      .map((p) => ({
        ...p,
        parent_dir: dir,
        source: "math",
        leaves_set: new Set(p.leaves.map((l) => l.data.id)),
      }));

    // Step 3: merge proposals, dedup by member set.
    const merged = mergeClusterProposals(tier2Clusters, mathClusters);
    for (const c of merged) c.parent_dir = dir;
    allCandidates.push(...merged);
  }

  if (allCandidates.length === 0) {
    return countPendingRequests(wikiRoot) > 0 ? "pending-tier2" : "none";
  }

  // Step 4: math-only candidates go through a mandatory
  // nest_decision gate. Candidates that came from propose_structure
  // are already structurally approved by Tier 2 — skip the gate.
  const gatedCandidates = [];
  for (const cand of allCandidates) {
    if (cand.source === "tier2" || cand.source === "both") {
      gatedCandidates.push(cand);
      continue;
    }
    // math-only: first validate staleness before emitting the gate
    // request. A math candidate computed in an earlier directory pass
    // (or in a prior invocation that restored from pending state) may
    // reference leaves that a subsequent NEST has already moved out
    // of the expected parent. Sending such a stale candidate to a
    // Tier 2 sub-agent wastes a round trip and almost always comes
    // back rejected with "these leaves are no longer siblings".
    // Drop the candidate here and log the reason for the audit trail.
    if (!mathCandidateIsFresh(cand)) {
      dropStaleMathCandidate(wikiRoot, cand, opId, suggestions);
      continue;
    }
    // math-only: run the gate.
    const gateReq = cand.gate_request;
    const gateResp = resolveTier2Response(wikiRoot, fixture, gateReq);
    if (gateResp === "pending") {
      enqueuePending(wikiRoot, gateReq);
      suggestions.push({
        operator: "NEST",
        sources: cand.leaves.map((l) => l.path),
        reason: `nest_decision parked (math cluster, avg_affinity=${cand.average_affinity.toFixed(3)})`,
      });
      continue;
    }
    const decision = typeof gateResp?.decision === "string" ? gateResp.decision : "undecidable";
    if (decision === "nest") {
      cand.gate_reason = gateResp.reason || "tier2 approved";
      gatedCandidates.push(cand);
    } else {
      // keep_flat / undecidable — skip, log, continue.
      suggestions.push({
        operator: "NEST",
        sources: cand.leaves.map((l) => l.path),
        reason: `cluster rejected by nest_decision (${decision}): ${gateResp.reason || ""}`,
      });
      appendNestDecision(wikiRoot, {
        op_id: opId,
        sources: cand.leaves.map((l) => l.data.id),
        similarity: cand.average_affinity ?? 0,
        confidence_band: "math-gated",
        decision: "rejected-by-gate",
        reason: `nest_decision=${decision}: ${gateResp.reason || ""}`,
      });
    }
  }

  // Step 5: resolve naming. propose_structure already supplied a
  // slug for tier2 clusters. math-only clusters need a
  // cluster_name request.
  const resolvedProposals = [];
  for (const cand of gatedCandidates) {
    if (cand.slug && validateSlug(cand.slug)) {
      resolvedProposals.push(cand);
      continue;
    }
    // Math-only path: cluster_name request.
    if (!cand.naming_request) continue;
    const namingResp = resolveTier2Response(wikiRoot, fixture, cand.naming_request);
    if (namingResp === "pending") {
      enqueuePending(wikiRoot, cand.naming_request);
      suggestions.push({
        operator: "NEST",
        sources: cand.leaves.map((l) => l.path),
        reason: `cluster_name parked (size=${cand.leaves.length})`,
      });
      continue;
    }
    if (namingResp?.decision === "reject") {
      suggestions.push({
        operator: "NEST",
        sources: cand.leaves.map((l) => l.path),
        reason: `cluster_name rejected (size=${cand.leaves.length})`,
      });
      appendNestDecision(wikiRoot, {
        op_id: opId,
        sources: cand.leaves.map((l) => l.data.id),
        similarity: cand.average_affinity ?? 0,
        confidence_band: cand.source === "math" ? "math-gated" : "tier2-proposed",
        decision: "rejected-by-gate",
        reason: "cluster_name=reject",
      });
      continue;
    }
    if (typeof namingResp?.slug === "string" && validateSlug(namingResp.slug)) {
      // Forward purpose from the naming response if Tier 2 included
      // one, otherwise keep whatever the candidate already had
      // (which will be empty for math-only clusters). The applier
      // uses this as the subcat's `focus:` line.
      const purpose =
        typeof namingResp.purpose === "string" && namingResp.purpose.trim()
          ? namingResp.purpose
          : cand.purpose || "";
      resolvedProposals.push({ ...cand, slug: namingResp.slug, purpose });
    }
  }

  if (resolvedProposals.length === 0) {
    return countPendingRequests(wikiRoot) > 0 ? "pending-tier2" : "none";
  }

  // Apply proposals in confidence order. v6-multi-NEST: we now
  // apply a SET of non-conflicting proposals in a single iteration
  // instead of only the highest-confidence one. This collapses a
  // guide/-style 9-NEST convergence from ~9 iterations (= 8 exit-7
  // cycles on the Tier 2 fixture path) into 1–2 iterations and
  // fixes the novel-corpus partial-cluster bug where a second
  // cluster ("frontend/") was orphaned because its parent was
  // re-shaped by the first applied NEST before the re-scan.
  //
  // Selection rule for "non-conflicting":
  //
  //   - DISJOINT member sets. Two proposals that would move the
  //     same leaf into two different subdirs are obviously in
  //     conflict — whichever applied second would either fail in
  //     the applier or silently clobber the first.
  //
  //   Same parent_dir is ALLOWED when members are disjoint. The
  //   root-level 8-subcategory layout on guide/ is the canonical
  //   example: every NEST proposal targets `.` as its parent, but
  //   each carves out a disjoint subset of leaves, so applying
  //   them in sequence within one iteration is safe. NEST #1 moves
  //   its members + rewrites the parent index; NEST #2 takes a
  //   fresh snapshot of the parent index (captured at apply time)
  //   and moves its disjoint members on top of NEST #1's state.
  //   A regression-triggered rollback on NEST #2 restores the
  //   post-NEST-#1 snapshot, not the pre-NEST-#1 state, so
  //   NEST #1's effects survive a NEST #2 rollback.
  //
  //   The stricter "different parent_dir" rule is NOT enforced
  //   because enforcing it would serialise the guide/ nesting pass
  //   into 8 iterations = 7 exit-7 cycles — exactly the pre-v6
  //   pain point we're fixing.
  //
  // Ordering: sort by confidence (source rank then avg affinity),
  // then greedily pick each candidate that doesn't conflict with
  // any already-picked one. The greedy pick preserves the original
  // tie-break: a higher-ranked proposal blocks a lower-ranked one
  // that overlaps with it.
  //
  // Per-apply gates: every picked candidate gets its own pre/post
  // routing_cost measurement and its own rollback snapshot. The
  // same math-strict / tier2-tolerance policy applies per apply.
  // A rolled-back pick does NOT cancel subsequent picks in the
  // same iteration — each is judged on its own metric delta
  // against the tree state AFTER previous picks have landed.
  //
  // Re-freshness check: before each apply, re-run
  // `mathCandidateIsFresh` on the candidate. If a prior pick in
  // this iteration invalidated the candidate's member set
  // (members moved out of parent_dir into a new subdir), the
  // stale candidate is dropped via `dropStaleMathCandidate`,
  // which writes a `rejected-stale` audit entry. This is the
  // subtle case the 3b audit-log path was built for — before v6
  // it was latent because single-NEST-per-iteration never
  // produced stale candidates; with multi-NEST it's reachable.
  //
  // Commit topology: one commit per applied NEST. The iteration
  // count stays the same across all picks in a single iteration
  // (they share the outer `iteration` value) but each apply fires
  // `commitBetweenIterations` so the private git history shows
  // one commit per rewrite, matching pre-v6 behaviour.
  const sourceRank = (s) => (s === "both" ? 2 : s === "tier2" ? 1 : 0);
  resolvedProposals.sort((a, b) => {
    const ra = sourceRank(a.source);
    const rb = sourceRank(b.source);
    if (ra !== rb) return rb - ra;
    return (b.average_affinity ?? 0) - (a.average_affinity ?? 0);
  });

  // Non-conflict selection — greedy pick sorted by confidence.
  // Only disjoint member sets are required; same-parent picks are
  // allowed (see the block comment above for why).
  const picked = [];
  const takenMembers = new Set();
  for (const proposal of resolvedProposals) {
    const memberIds = proposal.leaves.map((l) => l.data?.id).filter(Boolean);
    let overlap = false;
    for (const m of memberIds) {
      if (takenMembers.has(m)) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    picked.push(proposal);
    for (const m of memberIds) takenMembers.add(m);
  }

  // Ensure the routing graph exists before we measure the
  // baseline. Without this, the very first iteration would see
  // a non-existent root index.md (returns cost=0) and treat the
  // first NEST's legitimate cost measurement as a regression.
  // Bootstraps stub indices anywhere there are leaves but no
  // index.md, then rebuilds the entire tree so entries[] is
  // populated. Idempotent: subsequent calls are cheap.
  try {
    bootstrapStubIndicesForMetric(wikiRoot);
    rebuildAllIndices(wikiRoot);
  } catch {
    /* best effort: indices may not be set up yet on a fresh wiki */
  }

  let appliedCount = 0;
  for (const proposal of picked) {
    // Re-check freshness RIGHT BEFORE apply. An earlier pick in the
    // same iteration may have moved leaves out of this candidate's
    // parent (e.g. an ancestor-directory cluster swept up members
    // that were also part of a descendant-directory candidate). A
    // stale pick would otherwise fail inside applyNest or produce
    // garbage state, and the audit trail would lose the reason.
    if (proposal.source === "math" && !mathCandidateIsFresh(proposal)) {
      dropStaleMathCandidate(wikiRoot, proposal, opId, suggestions);
      continue;
    }
    const confBand =
      proposal.source === "both"
        ? "tier2-and-math"
        : proposal.source === "tier2"
          ? "tier2-proposed"
          : "math-gated";
    const preMetric = computeRoutingCost(wikiRoot).cost;
    // Snapshot the files we're about to mutate so we can roll back
    // on a metric regression. We ONLY need the old leaf contents
    // and the parent dir's index.md — the NEST applier touches
    // those and creates a new subdir.
    const rollback = snapshotForRollback(proposal, wikiRoot);
    // Pre-resolve the slug against member + sibling ids. A Tier 2 or
    // math-named slug that equals one of its member leaves' ids (or a
    // non-member sibling's id in the same parent) would pass applyNest
    // and then trip DUP-ID at validate time, forcing a full pipeline
    // rollback. resolveNestSlug auto-suffixes deterministically
    // (`-group`, then `-group-N`) so the NEST lands on the first try.
    // An unchanged slug is a no-op. The audit-log entry for the rename
    // is written AFTER applyNest succeeds so decisions.yaml never
    // records a rename for an op that ultimately failed.
    const originalSlug = proposal.slug;
    const resolvedSlug = resolveNestSlug(originalSlug, proposal, wikiRoot);
    let result;
    try {
      result = applyNest(wikiRoot, proposal, resolvedSlug);
    } catch (err) {
      suggestions.push({
        operator: "NEST",
        sources: proposal.leaves.map((l) => l.path),
        reason: `cluster apply failed: ${err.message}`,
      });
      appendNestDecision(wikiRoot, {
        op_id: opId,
        sources: proposal.leaves.map((l) => l.data.id),
        similarity: proposal.average_affinity ?? 0,
        confidence_band: confBand,
        decision: "rejected-by-gate",
        reason: `applyNest threw: ${err.message}`,
      });
      continue;
    }
    rebuildAllIndices(wikiRoot);
    const postMetric = computeRoutingCost(wikiRoot).cost;
    // Acceptance policy — distinguishes Tier 2 structural proposals
    // from math-only candidates:
    //
    //   - Math-only candidates (`source === "math"`) need STRICT
    //     improvement (post < pre − 1e-9). Math signals alone are a
    //     weak proxy for whether a cluster is worth creating, so the
    //     metric must pay for the nest.
    //
    //   - Tier 2 proposals (`source === "tier2"` or `"both"`) are
    //     allowed to land on metric-NEUTRAL deltas: the cluster is a
    //     structural judgment call the model is making about
    //     conceptual organisation, and for hand-authored sparse-
    //     signal corpora the `routing_cost` metric is often neutral
    //     on such clusters because the authored activation keywords
    //     already disambiguate the leaves at the flat level. The
    //     metric stays as a REGRESSION safety net: Tier 2 nests are
    //     rolled back if they make routing worse by more than the
    //     tolerance (currently 5% relative), which prevents a model
    //     hallucination from wrecking the wiki but allows structural
    //     organisation to land.
    const isMathOnly = proposal.source === "math";
    const regressionTolerance = 0.05; // 5% relative slack for Tier 2 nests
    const postLimit = isMathOnly
      ? preMetric - 1e-9 // strict improvement
      : preMetric * (1 + regressionTolerance); // bounded regression
    if (postMetric > postLimit) {
      // Regression beyond policy. Roll back.
      restoreRollback(rollback, result);
      rebuildAllIndices(wikiRoot);
      const policyLabel = isMathOnly
        ? "strict-improvement"
        : `tier2-regression-tolerance<=${(regressionTolerance * 100).toFixed(0)}%`;
      suggestions.push({
        operator: "NEST",
        sources: proposal.leaves.map((l) => l.path),
        reason: `cluster rolled back: metric ${preMetric.toFixed(4)} → ${postMetric.toFixed(4)} (policy=${policyLabel})`,
      });
      appendNestDecision(wikiRoot, {
        op_id: opId,
        sources: proposal.leaves.map((l) => l.data.id),
        similarity: proposal.average_affinity ?? 0,
        confidence_band: confBand,
        decision: "rejected-by-metric",
        reason: `metric ${preMetric.toFixed(4)} → ${postMetric.toFixed(4)} exceeds ${policyLabel}`,
      });
      continue;
    }
    // Keep. Record application + commit.
    // If resolveNestSlug renamed the slug to dodge a collision, audit
    // the rename NOW (after the NEST has passed every gate and is
    // about to commit) so decisions.yaml never carries a slug-renamed
    // entry for an op that was subsequently rolled back by the metric
    // gate or rejected by applyNest.
    if (resolvedSlug !== originalSlug) {
      appendNestDecision(wikiRoot, {
        op_id: opId,
        sources: proposal.leaves.map((l) => l.data.id),
        similarity: proposal.average_affinity ?? 0,
        confidence_band: confBand,
        decision: "slug-renamed",
        reason: `slug "${originalSlug}" collided with existing id; renamed to "${resolvedSlug}"`,
      });
    }
    const affinityTag = Number.isFinite(proposal.average_affinity)
      ? `avg_affinity=${proposal.average_affinity.toFixed(3)}, `
      : "";
    applied.push({
      iteration,
      operator: "NEST",
      sources: proposal.leaves.map((l) => l.path),
      describe:
        `NEST ${proposal.leaves.length} leaves into ` +
        `${relative(wikiRoot, result.target_dir)} ` +
        `(${affinityTag}source=${proposal.source}, ` +
        `metric ${preMetric.toFixed(4)} → ${postMetric.toFixed(4)})`,
      result,
    });
    await commitBetweenIterations({
      iteration,
      operator: "NEST",
      summary: `nested ${proposal.leaves.length} leaves into ${relative(wikiRoot, result.target_dir)}`,
    });
    metricTrajectory.push({
      iteration,
      cost: postMetric,
      event: "NEST",
    });
    appendNestDecision(wikiRoot, {
      op_id: opId,
      sources: proposal.leaves.map((l) => l.data.id),
      similarity: proposal.average_affinity ?? 0,
      confidence_band: confBand,
      decision: "applied",
      reason:
        `slug=${proposal.slug}, ` +
        `metric ${preMetric.toFixed(4)} → ${postMetric.toFixed(4)}`,
    });
    // Mark the freshly-created subdirectory so we do not
    // recursively sub-cluster it in later iterations of the
    // same run.
    nestedParents.add(result.target_dir);
    appliedCount++;
  }

  if (appliedCount > 0) return "applied";
  return countPendingRequests(wikiRoot) > 0 ? "pending-tier2" : "none";
}

// Enqueue a cluster-naming request through the shared tiered
// pending queue. The orchestrator drains the queue after the
// phase finishes and decides whether to write a Tier 2 batch +
// exit 7 or to proceed (when a fixture resolved everything).
function enqueueNamingRequest(wikiRoot, request) {
  enqueuePending(wikiRoot, request);
}

// Resolve a Tier 2 request: fixture → runtime-resolved map → "pending".
// Returns the inner response object, or the literal string "pending"
// when neither path carries an answer. Does NOT enqueue; callers
// are responsible for calling `enqueuePending` on "pending".
function resolveTier2Response(wikiRoot, fixture, request) {
  if (fixture) {
    const fx = resolveFromFixture(fixture, request);
    if (fx !== null && fx !== undefined) return fx;
  }
  const runtime = getResolvedResponse(wikiRoot, request.request_id);
  if (runtime !== null && runtime !== undefined) return runtime;
  return "pending";
}

// Convert a propose_structure response into a canonical list of
// cluster candidates. Each candidate carries:
//
//   operator:    "NEST"
//   source:      "tier2"
//   leaves:      [<leaf>, ...]
//   slug:        "<validated kebab-case>"
//   leaves_set:  Set<leaf-id>  (for dedup against math)
//
// Subcategories with invalid slugs, missing members, or fewer than
// MIN_CLUSTER_SIZE members are dropped. Members referencing leaf
// ids that aren't in the directory are silently filtered.
function extractTier2Clusters(response, leaves, parentDir) {
  void parentDir;
  if (!response || typeof response !== "object") return [];
  const subcats = Array.isArray(response.subcategories)
    ? response.subcategories
    : [];
  const leafById = new Map();
  for (const l of leaves) {
    if (l.data && l.data.id) leafById.set(l.data.id, l);
  }
  const out = [];
  for (const sc of subcats) {
    if (!sc || typeof sc !== "object") continue;
    const slug = typeof sc.slug === "string" ? sc.slug : null;
    if (!slug || !validateSlug(slug)) continue;
    const members = Array.isArray(sc.members) ? sc.members : [];
    const resolved = [];
    for (const memberId of members) {
      const leaf = leafById.get(memberId);
      if (leaf) resolved.push(leaf);
    }
    // Tier 2 clusters can have as few as MIN_TIER2_CLUSTER_SIZE (2)
    // members. A language model that has read both frontmatters can
    // defend a pair on conceptual grounds — "invariants + safety are
    // the correctness substrate", "preflight + user-intent are UX
    // at op boundaries" — even when pairwise math similarity alone
    // would be noisy. The metric gate's 5% regression tolerance for
    // Tier 2 proposals catches hallucinations; size-2 pairs flow
    // through the same gate, so a genuinely bad pair still gets
    // rolled back.
    if (resolved.length < MIN_TIER2_CLUSTER_SIZE) continue;
    if (resolved.length > MAX_CLUSTER_SIZE) {
      // Oversized Tier 2 proposals get split — keep MAX members
      // and leave the rest for a subsequent iteration. This keeps
      // every nested subcategory in the 2..MAX_CLUSTER_SIZE band
      // without silently dropping members.
      resolved.length = MAX_CLUSTER_SIZE;
    }
    out.push({
      operator: "NEST",
      source: "tier2",
      leaves: resolved,
      slug,
      purpose: typeof sc.purpose === "string" ? sc.purpose : "",
      leaves_set: new Set(resolved.map((l) => l.data.id)),
      size: resolved.length,
    });
  }
  return out;
}

// Deduplicate Tier 2 + math cluster candidates by member set.
// When Tier 2 and math propose the same cluster (set equality on
// leaf ids), the merged candidate carries source="both" — this is
// the strongest signal, applied first in the resolved-proposal
// ordering. Math clusters that duplicate a Tier 2 cluster are
// dropped (the tier2 entry already has a slug). Math clusters
// that don't duplicate any Tier 2 cluster survive as source="math"
// and go through the nest_decision gate.
function mergeClusterProposals(tier2Clusters, mathClusters) {
  const merged = [];
  const usedMathIdx = new Set();
  for (const tc of tier2Clusters) {
    let matched = false;
    for (let i = 0; i < mathClusters.length; i++) {
      if (usedMathIdx.has(i)) continue;
      const mc = mathClusters[i];
      if (setsEqual(tc.leaves_set, mc.leaves_set)) {
        merged.push({
          ...tc,
          source: "both",
          average_affinity: mc.average_affinity,
          naming_request: mc.naming_request,
          gate_request: mc.gate_request,
        });
        usedMathIdx.add(i);
        matched = true;
        break;
      }
    }
    if (!matched) merged.push(tc);
  }
  for (let i = 0; i < mathClusters.length; i++) {
    if (usedMathIdx.has(i)) continue;
    merged.push(mathClusters[i]);
  }
  return merged;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Snapshot just the files that NEST is about to mutate. We store
// the raw bytes of each source leaf + the parent index (if any)
// so a regression rollback can restore them byte-exact. The NEST
// applier creates a new subdirectory — rollback deletes that dir.
function snapshotForRollback(proposal, wikiRoot) {
  void wikiRoot;
  const leafFiles = proposal.leaves.map((l) => ({
    path: l.path,
    content: readFileSync(l.path, "utf8"),
  }));
  const parentDir = dirname(proposal.leaves[0].path);
  const parentIndex = join(parentDir, "index.md");
  let parentIndexContent = null;
  if (existsSync(parentIndex)) {
    parentIndexContent = readFileSync(parentIndex, "utf8");
  }
  return { leafFiles, parentIndex, parentIndexContent };
}

function restoreRollback(rb, applyResult) {
  // Delete the new subdirectory (with the stub + moved leaves).
  if (applyResult && applyResult.target_dir && existsSync(applyResult.target_dir)) {
    rmSync(applyResult.target_dir, { recursive: true, force: true });
  }
  // Restore the leaves at their original paths.
  for (const lf of rb.leafFiles) {
    mkdirSync(dirname(lf.path), { recursive: true });
    writeFileSync(lf.path, lf.content, "utf8");
  }
  // Restore the parent index content, if any.
  if (rb.parentIndex && rb.parentIndexContent !== null) {
    writeFileSync(rb.parentIndex, rb.parentIndexContent, "utf8");
  }
}

// ── Local stub-index bootstrapper ────────────────────────────────────
//
// Minimal stub creator used by the cluster-NEST path so the
// routing-cost metric has an index.md to parse at every
// directory that carries leaves. This is the same idea as
// orchestrator.mjs's bootstrapIndexStubs but lives here so
// runConvergence can call it without importing from the
// orchestrator (which would create a dependency cycle). The
// orchestrator's version (called after convergence) carries
// more fields and handles hosted-mode markers; this local one
// is only about getting a valid index file on disk.
function bootstrapStubIndicesForMetric(wikiRoot) {
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const indexPath = join(dir, "index.md");
    if (existsSync(indexPath)) continue;
    const { leaves, subdirs } = listChildren(dir);
    if (leaves.length === 0 && subdirs.length === 0) continue;
    const isRoot = dir === wikiRoot;
    const id = isRoot ? basename(wikiRoot) : basename(dir);
    const stub =
      "---\n" +
      `id: ${id}\n` +
      "type: index\n" +
      (isRoot ? "depth_role: category\n" : "depth_role: subcategory\n") +
      `focus: "subtree under ${id}"\n` +
      "generator: skill-llm-wiki/v1\n" +
      "---\n\n";
    writeFileSync(indexPath, stub, "utf8");
  }
}

// Validate that every leaf on a math candidate is still a direct
// child of the candidate's expected parent_dir. Returns `false` if
// any leaf has moved to a different directory, been deleted, or
// was never resident there to begin with. Called just before a
// math-source nest_decision gate request is emitted so stale
// candidates don't burn a Tier 2 round trip.
//
// A fresh candidate (one produced in the same iteration from a
// fresh `listChildren` scan) always passes this check; the guard
// only catches candidates whose members drifted between the pass
// that produced them and the pass that would have gated them.
// Phase 5 audit-log hook for stale math-candidate drops. Called by
// `tryClusterNestIteration` when `mathCandidateIsFresh` returns
// false. Writes a `rejected-stale` entry into decisions.yaml
// (confidence_band="math-gated") and pushes a parallel record onto
// the in-memory suggestions[] list so the convergence summary
// mentions the drop. Exported so unit tests can exercise the append
// path without having to drive the full convergence loop.
//
// Error handling: the decision-log append is best-effort — the loop
// never fails a build because of a missing audit record. The guard
// catches any filesystem or validator error and moves on.
export function dropStaleMathCandidate(wikiRoot, cand, opId, suggestions) {
  if (Array.isArray(suggestions)) {
    suggestions.push({
      operator: "NEST",
      sources: cand.leaves.map((l) => l.path),
      reason: "math candidate dropped: members no longer co-resident in parent",
    });
  }
  try {
    appendNestDecision(wikiRoot, {
      op_id: opId,
      sources: cand.leaves.map((l) => l.data?.id ?? "anonymous"),
      similarity: Number.isFinite(cand.average_affinity)
        ? cand.average_affinity
        : 0,
      confidence_band: "math-gated",
      decision: "rejected-stale",
      reason: "members no longer co-resident in parent",
    });
  } catch {
    /* best effort — audit log is a nice-to-have */
  }
}

export function mathCandidateIsFresh(cand) {
  if (!cand || !cand.parent_dir) return false;
  if (!Array.isArray(cand.leaves) || cand.leaves.length === 0) return false;
  const parentDir = cand.parent_dir;
  for (const leaf of cand.leaves) {
    if (!leaf || typeof leaf.path !== "string") return false;
    if (!existsSync(leaf.path)) return false;
    if (dirname(leaf.path) !== parentDir) return false;
  }
  return true;
}

// ── Directory walk helper ────────────────────────────────────────────

function walkDirs(wikiRoot) {
  const out = [wikiRoot];
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (!e.isDirectory()) continue;
        const sub = join(dir, e.name);
        out.push(sub);
        stack.push(sub);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}
