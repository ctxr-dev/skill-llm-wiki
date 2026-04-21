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

import { existsSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
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
export const MAX_BALANCE_ITERATIONS = 20;

// Fanout trigger: we apply sub-clustering only when a directory's
// child count EXCEEDS this multiple of the user's target. Bare-equal
// dirs are left alone so the target is the landing zone, not the
// rejection threshold.
export const FANOUT_OVERLOAD_MULTIPLIER = 1.5;

// Platform-stable sort key for absolute paths. `relative(wikiRoot, p)`
// returns OS-native separators — `\\` on Windows, `/` on POSIX — which
// means raw string comparison across those strings produces different
// lex orders on different platforms and breaks the phase's
// byte-reproducibility guarantee. Normalise every `sep` to `/` before
// comparing so the sort key is identical on ubuntu-latest and
// windows-latest.
function posixSortKey(wikiRoot, p) {
  const rel = relative(wikiRoot, p);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

// Compute the depth of each directory reachable from wikiRoot.
// Depth is the number of path segments between wikiRoot and the
// directory, so wikiRoot itself is depth 0 and any direct child
// subdirectory is depth 1. Dot-prefixed directories are skipped on
// the same blanket rule used elsewhere in the pipeline. Returns a
// Map<absolutePath, number>.
//
// Implementation: directory-only scan via `readdirSync` + an
// `index.md` presence check. `listChildren` would also work but
// parses frontmatter for every `.md` leaf in each directory — depth
// computation doesn't need that data, so the lightweight walk here
// keeps `detectDepthOverage` (which calls `computeDepthMap` then
// `listChildren` only on candidate dirs) cheaper on large corpora.
export function computeDepthMap(wikiRoot) {
  const out = new Map();
  out.set(wikiRoot, 0);
  const stack = [[wikiRoot, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      // Mirror `listChildren`'s routable-subdir discipline: a directory
      // without `index.md` isn't a wiki node, so it can't be part of
      // the depth map.
      if (!existsSync(join(full, "index.md"))) continue;
      subdirs.push(full);
    }
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

// Get the maximum routable depth in the wiki. Small summary helper
// for diagnostics and unit tests — callers that only need the
// deepest reachable routable directory depth don't have to inflate
// a full `computeDepthMap` into userland. Not wired into the
// orchestrator today; kept on the exported surface so a future
// audit-trail or `--dry-run` pre-flight can surface "would balance
// do anything at all?" cheaply.
export function getMaxDepth(wikiRoot) {
  let max = 0;
  for (const d of computeDepthMap(wikiRoot).values()) {
    if (d > max) max = d;
  }
  return max;
}

// Compute fan-out statistics across every directory in a single
// traversal. Returns
//
//   {
//     maxFanout,
//     avgFanout,
//     perDir: Map<dir, number>,    // combined leaves+subdirs
//     leafCounts: Map<dir, number>, // leaves only
//   }
//
// `perDir` counts the combined leaf + subdir children — the Claude-
// routing-cost view (an index lists both shapes). `leafCounts` holds
// leaves only — the movable-fanout view consumed by
// `detectFanoutOverload`. Both maps are produced in the same
// `listChildren` sweep so callers that want both never pay a second
// walk on large corpora.
export function computeFanoutStats(wikiRoot) {
  const perDir = new Map();
  const leafCounts = new Map();
  let total = 0;
  let count = 0;
  let max = 0;
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    const { leaves, subdirs } = listChildren(dir);
    const fan = leaves.length + subdirs.length;
    perDir.set(dir, fan);
    leafCounts.set(dir, leaves.length);
    total += fan;
    count++;
    if (fan > max) max = fan;
    for (const sub of subdirs) stack.push(sub);
  }
  const avg = count > 0 ? total / count : 0;
  return { maxFanout: max, avgFanout: avg, perDir, leafCounts };
}

// Detect directories whose MOVABLE fan-out EXCEEDS fanoutTarget ×
// MULTIPLIER. Movable fan-out is leaf count alone, not leaves+subdirs:
// the sub-cluster pass can only carve clusters out of leaves (subdirs
// are structurally cemented by their own indexing) so a dir that is
// routing-overfull purely because it holds many subcategories is
// un-actionable here and would otherwise stall the loop at the
// lex-smallest un-actionable entry. The `computeFanoutStats` helper
// remains available for diagnostic / audit views that want the full
// routing-cost metric. Returned in lex order so the balance loop's
// apply sequence is byte-reproducible. `nestedParents` is an opt-out:
// directories created by the current balance pass (or by an earlier
// convergence pass in the same op) are left alone so we don't
// sub-cluster a freshly-created subcategory on the next iteration —
// that's the "let the op settle" discipline convergence already uses.
export function detectFanoutOverload(wikiRoot, fanoutTarget, nestedParents = new Set()) {
  const threshold = fanoutTarget * FANOUT_OVERLOAD_MULTIPLIER;
  // Single traversal: computeFanoutStats walks every dir once via
  // listChildren and returns both leaf counts and combined counts. A
  // previous draft filtered on perDir and then called listChildren
  // again per candidate, doubling the I/O — the new `leafCounts` map
  // keeps everything to one sweep regardless of tree size.
  const { leafCounts } = computeFanoutStats(wikiRoot);
  const dirs = Array.from(leafCounts.keys())
    .filter((d) => !nestedParents.has(d))
    .filter((d) => leafCounts.get(d) > threshold);
  dirs.sort((a, b) => posixSortKey(wikiRoot, a).localeCompare(posixSortKey(wikiRoot, b)));
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
    posixSortKey(wikiRoot, a).localeCompare(posixSortKey(wikiRoot, b)),
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
  // Preflight: verify the passthrough dir contains ONLY the expected
  // entries (the child subdir's basename + optionally `index.md`)
  // BEFORE any filesystem mutation. listChildren enumerates only
  // `.md` leaves and subdirs-containing-index.md, so non-`.md`
  // content (assets/, stray README.txt, subdirs without an index.md)
  // is invisible to the detector even though a later
  // `rmSync(dir, {recursive: true})` would silently delete it.
  //
  // Dot-prefixed entries (`.DS_Store`, editor backups, `.shape/`
  // internals) are deliberately skipped during this stray check —
  // the rest of the pipeline (`listChildren`, `buildWikiForbiddenIndex`,
  // `collectEntryPaths`) all skip them under the same blanket rule.
  // They're non-routable noise, so refusing to flatten because a
  // `.DS_Store` lives in the passthrough would surprise users. Since
  // `rmdirSync` at the end of this function requires an empty
  // directory, dotfile noise is actively removed before the rename
  // (see the dotEntries cleanup pass below the stray check); the
  // final `rmdirSync` would otherwise fail ENOTEMPTY if any dot
  // entry remained.
  //
  // An earlier draft checked this AFTER the rename + index.md drop,
  // which left the wiki partially-mutated (child already promoted,
  // passthrough still present) when refusing — the caller's pre-op
  // snapshot could undo it, but leaving the mutation/refusal ordering
  // correct here makes the function itself atomic-or-untouched.
  // Readdir errors are soft (directory may have been moved by a
  // concurrent process) — re-raise so the orchestrator's snapshot
  // restores.
  const entries = readdirSync(passthroughDir);
  const allowed = new Set([basename(child), "index.md"]);
  const stray = entries.filter((e) => !allowed.has(e) && !e.startsWith("."));
  if (stray.length > 0) {
    throw new Error(
      `balance-flatten: ${relative(wikiRoot, passthroughDir)} holds unexpected ` +
        `non-listChildren content (stray: ${JSON.stringify(stray)}); ` +
        `refusing to flatten to avoid silent data loss`,
    );
  }
  // Clean up dot-prefixed noise BEFORE the rename so that rmdirSync
  // at the end can succeed without recursive. Dotfiles are noise by
  // the pipeline's convention (see the blanket dot-skip rule in
  // collectEntryPaths / listChildren / buildWikiForbiddenIndex), so
  // deleting them here is policy-consistent — we don't want a
  // `.DS_Store` keeping a routable-empty directory alive.
  const dotEntries = entries.filter((e) => e.startsWith("."));
  for (const name of dotEntries) {
    rmSync(join(passthroughDir, name), { recursive: true, force: true });
  }
  // Atomically move the child into its grandparent's directory, then
  // drop the now-empty passthrough + its index.md.
  renameSync(child, promotedPath);
  const passIdx = join(passthroughDir, "index.md");
  if (existsSync(passIdx)) rmSync(passIdx, { force: true });
  // rmdirSync refuses non-empty dirs natively (ENOTEMPTY), so any
  // unexpected mid-flight insertion between the preflight and here
  // (e.g., a concurrent writer dropping a file into the passthrough)
  // still fails loud rather than silently recursive-deleting.
  rmdirSync(passthroughDir);
  return { promoted: promotedPath, removed: passthroughDir };
}

// Run the balance phase to fixed point. Returns
//
//   {
//     iterations,
//     applied: [{ iteration, operator, sources, describe }, ...],
//     nestedParents: Set<absolutePath>,  // augmented
//     converged: boolean,
//   }
//
// Contract with the caller (orchestrator.mjs):
//   - `fanoutTarget` / `maxDepth` are the parsed flag values (already
//     validated at intent time). Either or both may be null — if
//     neither is set, runBalance is a no-op and returns
//     `{ iterations: 0, applied: [], nestedParents, converged: true }`.
//   - `nestedParents` is an optional opt-out set. Any directory in it
//     is skipped by the fanout pass — useful for a caller that wants
//     to protect newly-created subdirs from being immediately
//     re-carved. The current orchestrator does NOT plumb convergence's
//     internal `nestedParents` set through (runConvergence doesn't
//     export it), so in practice balance starts with a fresh empty
//     Set and augments it in-place as it creates new subdirs across
//     its own iterations. Returned in the result so tests / future
//     callers can observe what balance added. Pipe-through-from-
//     convergence is a possible future enhancement, hence the shape.
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
  // Build the wiki-wide forbidden-id index ONLY when the fanout pass
  // could actually fire (fanoutTarget set). `--max-depth`-only runs
  // never call resolveNestSlug, so walking the whole tree to build
  // the forbidden-id set on their behalf is wasted I/O — significant
  // on large hand-authored corpora. The index is mutated after each
  // successful BALANCE_SUBCLUSTER (add the new subdir's slug),
  // mirroring the reuse pattern in
  // `operators.mjs::tryClusterNestIteration`.
  //
  // BALANCE_FLATTEN doesn't mutate the index: a flattened passthrough's
  // basename stays in the set (stale, conservative — may trigger a
  // `-group-N` fallback on a future attempt using that exact basename
  // as a slug, which is safe because renaming-into-a-now-free-slot is
  // cheaper to re-do than walking the full wiki again per iteration).
  const wikiIndex = fanoutTarget != null
    ? buildWikiForbiddenIndex(wikiRoot)
    : null;
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

    // Fanout pass. Walk the lex-sorted overfull list until we find a
    // parent whose leaves yield at least one live math cluster. Any
    // earlier candidate that yields no live proposal (detectClusters
    // returns `[]` for `leaves.length < MIN_CLUSTER_SIZE`, or only
    // empty-partition markers when no threshold produces an acceptable
    // partition) is recorded and skipped for the rest of this
    // iteration — previous drafts applied only `overfull[0]` and
    // declared convergence when that one dir was un-actionable, even
    // though later dirs in the list could still be carved. Suppress
    // unused-var warnings on qualityMode/opId (kept for a future
    // per-mode claude-first re-enabled Tier 2 naming pass).
    void qualityMode;
    void opId;
    if (fanoutTarget != null) {
      const overfull = detectFanoutOverload(wikiRoot, fanoutTarget, nestedParents);
      for (const parentDir of overfull) {
        const { leaves } = listChildren(parentDir);
        // Reuse the cluster detector + deterministic naming helpers
        // from Phase X.3. Math-mode only — balance never escalates to
        // Tier 2 even when the active quality mode is tiered-fast,
        // because this phase's contract is "algorithmic rebalance",
        // not "ask a model to restructure".
        // `returnEmptyMarker: false` makes detectClusters return []
        // on failure (rather than a single `{ empty_partition: true }`
        // marker proposal). That's the mode balance wants: the
        // enforcement phase has no Tier 2 to escalate to, so an empty
        // partition means "skip this dir and try the next overfull
        // candidate" — a plain length check on the proposals array
        // captures that directly, no `empty_partition` filter needed.
        const proposals = await detectClusters(wikiRoot, leaves, {
          returnEmptyMarker: false,
        });
        if (proposals.length === 0) continue; // try the next overfull dir
        // Take the strongest (highest average_affinity) proposal.
        proposals.sort((a, b) => (b.average_affinity ?? 0) - (a.average_affinity ?? 0));
        const chosen = proposals[0];
        const deterministicIdf = buildSiblingIdfContext(leaves);
        const slug = generateDeterministicSlug(chosen.leaves, leaves, {
          precomputedIdf: deterministicIdf,
        });
        const purpose = deterministicPurpose(chosen.leaves);
        chosen.parent_dir = parentDir;
        chosen.source = "math";
        chosen.slug = slug;
        chosen.purpose = purpose;
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
        // Mutate the pre-built wiki-forbidden index so the next
        // resolveNestSlug call in this run sees the new subdir as
        // occupied — skips the full-tree rebuild the nest-applier
        // mutation contract expects.
        wikiIndex.add(resolvedSlug);
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
        break; // one apply per iteration — reassess on the next pass
      }
      if (didWork) continue;
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
