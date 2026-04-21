// balance.mjs — post-convergence structural rebalance.
//
// Runs after the main convergence loop when the caller passed
// `--fanout-target=N` and/or `--max-depth=D`. Iterates until fixed
// point (or a maxIterations cap) applying two transform classes:
//
//   1. Sub-cluster overfull directories. Any directory whose fan-out
//      exceeds `fanout-target * 1.5` is a candidate: the math
//      cluster-detector carves out one coherent cluster and NEST
//      applies it. The "× 1.5" slack avoids thrashing on directories
//      that are just above target by one or two children — only
//      meaningfully-overfull dirs are touched.
//
//   2. Flatten overdeep single-child chains. Any branch that exceeds
//      `max-depth` AND whose terminal segment is a single-child
//      passthrough gets lifted. The collapsed segment is the nearest
//      ancestor index.md whose only routable content is a single
//      subcategory — these add zero routing value and were a
//      frequent offender in early-corpus hand-authored drafts.
//
// Every operation is deterministic in the inputs (lex-sorted dir
// iteration, lex-sorted cluster-member iteration, deterministic slug
// naming reused from the Phase X.3 deterministic-mode helpers). Two
// runs on the same tree produce the same output.
//
// The caller — orchestrator.mjs — invokes runBalance between the main
// convergence phase (Phase 4) and the index-regeneration phase
// (Phase 5). An optional `nestedParents` set can be passed in to
// opt specific directories out of the sub-cluster pass (balance
// adds its own newly-created subdirs to the same set across
// iterations so a freshly-created subdir never gets re-clustered
// on the next pass). The current orchestrator call site doesn't
// thread convergence's own nestedParents through — it passes an
// empty set — because balance targets overfull / overdeep dirs
// specifically, and convergence leaves exactly those as its
// residual "we didn't nest this deep enough" surface.

import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import {
  buildSiblingIdfContext,
  deterministicPurpose,
  detectClusters,
  generateDeterministicSlug,
} from "./cluster-detect.mjs";
import { listChildren, rebuildAllIndices } from "./indices.mjs";
import {
  applyNest,
  buildWikiForbiddenIndex,
  resolveNestSlug,
} from "./nest-applier.mjs";

// Balance-loop convergence cap. The rebalance is expected to terminate
// in a handful of iterations because each successful operation
// strictly reduces either |overfull dirs| or |overdeep branches|; the
// cap is defensive in case pathological inputs (e.g. a sub-clustering
// that produces a new overfull dir inside itself) trigger ping-pong.
const MAX_BALANCE_ITERATIONS = 20;

// Fanout trigger: we apply sub-clustering only when a directory's
// child count EXCEEDS this multiple of the user's target. Bare-equal
// dirs are left alone so the target is the landing zone, not the
// rejection threshold.
export const FANOUT_OVERLOAD_MULTIPLIER = 1.5;

// Compute the depth of each directory reachable from wikiRoot.
// Depth is the number of path segments between wikiRoot and the
// directory, so wikiRoot itself is depth 0 and any direct child
// subdirectory is depth 1. Dot-prefixed directories are skipped on
// the same blanket rule used elsewhere in the pipeline. Returns a
// Map<absolutePath, number>.
export function computeDepthMap(wikiRoot) {
  const out = new Map();
  out.set(wikiRoot, 0);
  const stack = [[wikiRoot, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    const { subdirs } = listChildren(dir);
    // Sort lex so traversal order is deterministic.
    subdirs.sort((a, b) => basename(a).localeCompare(basename(b)));
    for (const sub of subdirs) {
      const subDepth = depth + 1;
      out.set(sub, subDepth);
      stack.push([sub, subDepth]);
    }
  }
  return out;
}

// Get the maximum routable depth in the wiki. Useful for the
// orchestrator's audit-trail decision on whether the balance phase
// needs to run at all.
export function getMaxDepth(wikiRoot) {
  let max = 0;
  for (const d of computeDepthMap(wikiRoot).values()) {
    if (d > max) max = d;
  }
  return max;
}

// Compute fan-out statistics across every directory. Returns
//
//   { maxFanout, avgFanout, perDir: Map<dir, number> }
//
// where `perDir[dir]` counts the combined leaf + subdir children
// under each directory. The combined count matches what a
// Claude-navigating query faces when routing — an index lists both
// leaves and subcategories — so fan-out is the sum of both shapes,
// not just one.
export function computeFanoutStats(wikiRoot) {
  const perDir = new Map();
  let total = 0;
  let count = 0;
  let max = 0;
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    const { leaves, subdirs } = listChildren(dir);
    const fan = leaves.length + subdirs.length;
    perDir.set(dir, fan);
    total += fan;
    count++;
    if (fan > max) max = fan;
    for (const sub of subdirs) stack.push(sub);
  }
  const avg = count > 0 ? total / count : 0;
  return { maxFanout: max, avgFanout: avg, perDir };
}

// Detect directories whose fan-out EXCEEDS fanoutTarget × MULTIPLIER.
// Returned in lex order so the balance loop's apply sequence is
// byte-reproducible. `nestedParents` is an opt-out: directories
// created by the current balance pass (or by an earlier convergence
// pass in the same op) are left alone so we don't sub-cluster a
// freshly-created subcategory on the next iteration — that's the
// "let the op settle" discipline convergence already uses.
export function detectFanoutOverload(wikiRoot, fanoutTarget, nestedParents = new Set()) {
  const threshold = fanoutTarget * FANOUT_OVERLOAD_MULTIPLIER;
  const { perDir } = computeFanoutStats(wikiRoot);
  const dirs = Array.from(perDir.keys())
    .filter((d) => !nestedParents.has(d))
    .filter((d) => perDir.get(d) > threshold);
  dirs.sort((a, b) => relative(wikiRoot, a).localeCompare(relative(wikiRoot, b)));
  return dirs;
}

// Detect branches that exceed maxDepth and whose terminal subdir is a
// pure single-child passthrough (one subdir, zero leaves). Only
// single-child passthroughs are candidates because flattening a
// multi-child subcategory would lose structure; passthroughs, by
// definition, carry no information the parent doesn't already hold.
// Returns the absolute paths of the passthrough directories to
// collapse, in lex order. The caller applies LIFT-chain-style
// flattening via `applyBalanceFlatten`.
export function detectDepthOverage(wikiRoot, maxDepth) {
  const depths = computeDepthMap(wikiRoot);
  const candidates = [];
  for (const [dir, depth] of depths) {
    if (depth <= maxDepth) continue;
    const { leaves, subdirs } = listChildren(dir);
    // Single-child passthrough: no leaves, exactly one subdir. The
    // index.md carries only navigation pointing at that child, which
    // adds no routing value versus pointing directly at the grandchild.
    if (leaves.length === 0 && subdirs.length === 1) {
      candidates.push(dir);
    }
  }
  candidates.sort((a, b) =>
    relative(wikiRoot, a).localeCompare(relative(wikiRoot, b)),
  );
  return candidates;
}

// Promote a single-child passthrough's only subdir up one level,
// replacing the passthrough itself. The passthrough's index.md is
// removed; the promoted subdir's contents live directly under the
// passthrough's parent dir.
//
// The `parents[]` frontmatter field on every descendant is a POSIX-
// RELATIVE path to the file's DIRECT parent index.md — in practice
// either `"index.md"` (for leaves, pointing to their same-dir index)
// or `"../index.md"` (for subcategory index.md files, pointing to
// the index in the dir above). Because every file in the promoted
// subtree moves up by exactly one level TOGETHER — both the file
// and its direct-parent index.md — the relative path between them
// is invariant. A leaf at `pass/child/leaf.md` with
// `parents: ["index.md"]` becomes `child/leaf.md` after flatten, and
// `"index.md"` still resolves to its direct parent (which also
// moved). A subcategory index at `pass/child/index.md` with
// `parents: ["../index.md"]` becomes `child/index.md` post-flatten;
// its `"../index.md"` semantically shifts from "pass/index.md"
// (which is being deleted) to "parent/index.md" (the new direct
// parent), which is exactly the right re-parenting.
//
// In other words: no parents[] rewrite is needed. An earlier draft
// of this function attempted to strip one leading `"../"` from every
// parents[] entry, but that was wrong — it would rewrite valid
// `"../index.md"` references on subcategory indices into
// `"index.md"`, self-pointing. Leaving parents[] alone is both
// simpler and correct.
//
// Returns { promoted, removed } where:
//   promoted — the new absolute path of the promoted subdir.
//   removed — the absolute path that no longer exists (the old
//             passthrough).
export function applyBalanceFlatten(wikiRoot, passthroughDir) {
  const { subdirs, leaves } = listChildren(passthroughDir);
  if (leaves.length !== 0 || subdirs.length !== 1) {
    throw new Error(
      `balance-flatten: ${relative(wikiRoot, passthroughDir)} is not a single-child passthrough (leaves=${leaves.length}, subdirs=${subdirs.length})`,
    );
  }
  const child = subdirs[0];
  const parent = dirname(passthroughDir);
  const promotedPath = join(parent, basename(child));
  if (existsSync(promotedPath) && promotedPath !== child) {
    throw new Error(
      `balance-flatten: promote target ${relative(wikiRoot, promotedPath)} already exists`,
    );
  }
  // Atomically move the child into its grandparent's directory, then
  // drop the now-empty passthrough + its index.md.
  renameSync(child, promotedPath);
  const passIdx = join(passthroughDir, "index.md");
  if (existsSync(passIdx)) rmSync(passIdx, { force: true });
  rmSync(passthroughDir, { recursive: true, force: true });
  return { promoted: promotedPath, removed: passthroughDir };
}

// Run the balance phase to fixed point. Returns
//
//   {
//     iterations,
//     applied: [{ operator, sources, describe }, ...],
//     nestedParents: Set<absolutePath>,  // augmented
//     converged: boolean,
//   }
//
// Contract with the caller (orchestrator.mjs):
//   - `fanoutTarget` / `maxDepth` are the parsed flag values (already
//     validated at intent time). Either or both may be null — if
//     neither is set, runBalance is a no-op and returns
//     `{ iterations: 0, applied: [], nestedParents, converged: true }`.
//   - `nestedParents` is the Set passed through from the preceding
//     convergence phase. Dirs in it are not re-examined here. On
//     every successful sub-cluster apply we add the new subdir to
//     this set.
//   - `commitBetweenIterations({iteration, operator, summary})` is
//     the same callback runConvergence uses; orchestrator wires it
//     to the private-git commit machinery.
export async function runBalance(wikiRoot, ctx = {}) {
  const {
    fanoutTarget = null,
    maxDepth = null,
    opId,
    qualityMode = "tiered-fast",
    nestedParents = new Set(),
    commitBetweenIterations = async () => {},
  } = ctx;

  if (fanoutTarget == null && maxDepth == null) {
    return { iterations: 0, applied: [], nestedParents, converged: true };
  }

  const applied = [];
  let iteration = 0;
  let reachedFixedPoint = false;
  while (iteration < MAX_BALANCE_ITERATIONS) {
    iteration++;
    let didWork = false;

    // Depth pass first — flattening a branch is a reducing operation
    // that never creates a new overfull dir, so running it before the
    // fanout pass keeps the per-iteration working set shrinking
    // monotonically.
    if (maxDepth != null) {
      const overdeep = detectDepthOverage(wikiRoot, maxDepth);
      if (overdeep.length > 0) {
        const chosen = overdeep[0]; // lex-smallest, for determinism
        const result = applyBalanceFlatten(wikiRoot, chosen);
        rebuildAllIndices(wikiRoot);
        applied.push({
          iteration,
          operator: "BALANCE_FLATTEN",
          sources: [chosen],
          describe:
            `flattened passthrough ${relative(wikiRoot, chosen)} ` +
            `(promoted ${relative(wikiRoot, result.promoted)})`,
        });
        await commitBetweenIterations({
          iteration,
          operator: "BALANCE_FLATTEN",
          summary:
            `balance: flattened ${relative(wikiRoot, chosen)} → ${relative(wikiRoot, result.promoted)}`,
        });
        didWork = true;
        continue; // re-evaluate from scratch
      }
    }

    // Fanout pass. Pick the first (lex-smallest) overfull dir and
    // sub-cluster one math-detected cluster out of it. One apply per
    // iteration keeps the decision graph simple; the loop re-runs
    // detection each pass against the new tree.
    if (fanoutTarget != null) {
      const overfull = detectFanoutOverload(wikiRoot, fanoutTarget, nestedParents);
      if (overfull.length > 0) {
        const parentDir = overfull[0];
        const { leaves } = listChildren(parentDir);
        // Reuse the cluster detector + deterministic naming helpers
        // from Phase X.3. Math-mode only — balance never escalates to
        // Tier 2 even when the active quality mode is tiered-fast,
        // because this phase's contract is "algorithmic rebalance",
        // not "ask a model to restructure".
        const proposals = await detectClusters(wikiRoot, leaves, {
          returnEmptyMarker: false,
        });
        const live = proposals.filter((p) => !p.empty_partition);
        if (live.length > 0) {
          // Take the strongest (highest average_affinity) proposal.
          live.sort((a, b) => (b.average_affinity ?? 0) - (a.average_affinity ?? 0));
          const chosen = live[0];
          const deterministicIdf = buildSiblingIdfContext(leaves);
          const slug = generateDeterministicSlug(chosen.leaves, leaves, {
            precomputedIdf: deterministicIdf,
          });
          const purpose = deterministicPurpose(chosen.leaves);
          chosen.parent_dir = parentDir;
          chosen.source = "math";
          chosen.slug = slug;
          chosen.purpose = purpose;
          const wikiIndex = buildWikiForbiddenIndex(wikiRoot);
          const resolvedSlug = resolveNestSlug(slug, chosen, wikiRoot, {
            wikiIndex,
          });
          // Let applyNest's errors propagate up to the orchestrator's
          // pre-op snapshot rollback. applyNest performs several
          // non-atomic operations (mkdir, move-per-leaf, stub write)
          // after the cheap pre-checks, so a mid-apply failure leaves
          // a partially-mutated wiki. Swallowing the error here and
          // continuing the loop would commit that partial state; the
          // orchestrator's catch block restores the pre-op snapshot
          // cleanly.
          const result = applyNest(wikiRoot, chosen, resolvedSlug);
          rebuildAllIndices(wikiRoot);
          nestedParents.add(result.target_dir);
          applied.push({
            iteration,
            operator: "BALANCE_SUBCLUSTER",
            sources: chosen.leaves.map((l) => l.path),
            describe:
              `sub-clustered ${chosen.leaves.length} leaves from ` +
              `${relative(wikiRoot, parentDir)} → ${relative(wikiRoot, result.target_dir)} ` +
              `(avg_affinity=${(chosen.average_affinity ?? 0).toFixed(3)}, ` +
              `source=deterministic-math)`,
          });
          await commitBetweenIterations({
            iteration,
            operator: "BALANCE_SUBCLUSTER",
            summary:
              `balance: sub-clustered ${chosen.leaves.length} leaves into ${relative(wikiRoot, result.target_dir)}`,
          });
          didWork = true;
          // Suppress unused var warning on qualityMode — kept in the
          // signature for future per-mode variations, such as a
          // claude-first balance pass that re-enables Tier 2 naming.
          void qualityMode;
          void opId;
          continue;
        }
      }
    }

    if (!didWork) {
      // Fixed point: one full pass with neither phase finding work.
      // This is the *only* clean-exit signal — an iteration cap hit is
      // a non-convergence failure regardless of how many ops fired.
      reachedFixedPoint = true;
      break;
    }
  }

  return { iterations: iteration, applied, nestedParents, converged: reachedFixedPoint };
}
