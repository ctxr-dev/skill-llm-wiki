// join.mjs — merge N ≥ 2 existing wikis into one unified output wiki.
//
// Implements the 11-phase pipeline from guide/operations/ingest/join.md:
//
//   0  preflight            (handled by orchestrator caller; not here)
//   1  ingest-all           — read every source wiki's tree into memory
//   2  source-validate      — validate each source; halt on errors
//   3  plan-union           — merge per-source leaf lists into one
//   4  resolve-id-collisions — namespace (default) / merge / ask policies
//   5  merge-categories     — fold categories with matching focus
//   6  rewire-references    — resolve links[].id / parents[] /
//                             overlay_targets via id→alias→rename map
//   7  apply-operators      — runConvergence on the unified tree
//   8  generate-indices     — rebuildAllIndices on the joined tree
//   9  validation           — validateWiki on the joined tree
//  10  golden-path-union    — each source's fixtures must still pass
//  11  commit               — phase-commit via the caller's callback
//
// Source immutability: every source wiki is treated as strictly
// read-only. The pipeline materialises the unified output at the
// target path (created empty by the orchestrator before runJoin is
// called); sources are never touched on disk. This module assumes
// that precondition has already been enforced by the caller
// (intent.mjs's join branch refuses a non-empty target via INT-01
// and the CLI creates the target empty via mkdirSync when
// `plan.is_new_wiki` is set).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readFrontmatterStreaming } from "./chunk.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { rebuildAllIndices } from "./indices.mjs";
import { runConvergence } from "./operators.mjs";
import { summariseFindings, validateWiki } from "./validate.mjs";

// Valid --id-collision policy values. Kept in sync with the CLI's
// flag validation (scripts/cli.mjs) and the intent layer (intent.mjs).
export const VALID_COLLISION_POLICIES = Object.freeze([
  "namespace",
  "merge",
  "ask",
]);

export const DEFAULT_COLLISION_POLICY = "namespace";

// ── Phase 1: ingest-all ──────────────────────────────────────────
//
// Read one source wiki into memory. Returns a normalised
// representation with `leaves[]` (non-index .md files) and
// `indices[]` (index.md files) — both carrying `relPath` (relative
// POSIX path under wikiRoot), parsed `data` (frontmatter), and
// `body` (everything after the closing fence). CRLF fences are
// handled by `readFrontmatterStreaming` which normalises to LF on
// the frontmatter payload; the body is sliced at the pre-normalisation
// byte offset and normalised to LF on read for downstream
// consistency with every other writer in this codebase.
//
// Files that fail to parse are collected into `malformed[]` so the
// caller can surface them as part of source-validate rather than
// silently dropping them.
export function ingestWiki(wikiRoot) {
  const out = {
    wikiRoot,
    leaves: [],
    indices: [],
    malformed: [],
  };
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      let captured;
      try {
        captured = readFrontmatterStreaming(full);
      } catch (err) {
        out.malformed.push({ path: full, error: err.message });
        continue;
      }
      if (!captured) continue; // plain .md with no fence — not a wiki entry
      let parsed;
      try {
        parsed = parseFrontmatter(captured.frontmatterText, full);
      } catch (err) {
        out.malformed.push({ path: full, error: err.message });
        continue;
      }
      if (!parsed?.data?.id) continue;
      const raw = readFileSync(full);
      let body = raw.slice(captured.bodyOffset).toString("utf8");
      if (captured.lineEnding === "crlf") {
        body = body.replace(/\r\n/g, "\n");
      }
      const relPath = relPosix(relative(wikiRoot, full));
      const record = { relPath, absolutePath: full, data: parsed.data, body };
      if (e.name === "index.md") {
        out.indices.push(record);
      } else {
        out.leaves.push(record);
      }
    }
  }
  // Lex sort for determinism — downstream collision resolution is
  // order-sensitive when the policy emits sequential suffixes.
  out.leaves.sort((a, b) => a.relPath.localeCompare(b.relPath));
  out.indices.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

// ── Phase 2: source-validate ─────────────────────────────────────
//
// Run `validateWiki` on each source. Any hard error halts join
// with "fix this source first" — joining a broken source produces
// a broken joined wiki. Warnings are surfaced but don't block.
// Malformed files collected by `ingestWiki` are folded in as
// synthetic PARSE findings so the caller sees a single unified
// list rather than two separate error channels.
export function validateSources(ingested) {
  const report = { errors: [], warnings: [] };
  for (const src of ingested) {
    const findings = validateWiki(src.wikiRoot);
    for (const f of findings) {
      const entry = { wikiRoot: src.wikiRoot, ...f };
      if (f.severity === "error") report.errors.push(entry);
      else if (f.severity === "warning") report.warnings.push(entry);
    }
    for (const m of src.malformed) {
      report.errors.push({
        wikiRoot: src.wikiRoot,
        severity: "error",
        code: "PARSE",
        target: m.path,
        message: m.error,
      });
    }
  }
  return report;
}

// ── Phase 3: plan-union ──────────────────────────────────────────
//
// Merge per-source leaf + index records into a single in-memory
// plan. Each record gets tagged with `sourceWiki` (the absolute
// path of its origin wiki) so downstream phases can reason about
// provenance — the `source_wikis[]` frontmatter field on merged
// entries, the rename-map namespacing prefix, and the
// golden-path-union phase's fixture tracing all rely on this.
//
// The union preserves source order (source A's entries first, then
// B, etc.) with lex-sorted records within each source, so the plan
// is byte-stable for identical inputs regardless of filesystem
// readdir ordering.
export function planUnion(ingestedSources) {
  const leaves = [];
  const indices = [];
  for (const src of ingestedSources) {
    for (const leaf of src.leaves) {
      leaves.push({ ...leaf, sourceWiki: src.wikiRoot });
    }
    for (const idx of src.indices) {
      indices.push({ ...idx, sourceWiki: src.wikiRoot });
    }
  }
  return { leaves, indices };
}

// ── Phase 4: resolve-id-collisions ───────────────────────────────
//
// Detect duplicate ids across sources and apply the configured
// collision policy. Includes BOTH leaves and indices — `validateWiki`
// enforces global id uniqueness across every entry type, so an
// index-only collision (two sources both with `auth/index.md`) would
// still trip `DUP-ID` at phase 9. Index collisions are detected but
// first-cut only renames the ID on the collision (the directory
// basename stays, producing `ID-MISMATCH-DIR` which the user will
// need to resolve — full directory-rename for index collisions is
// tracked as a follow-up; in the common case of joining topically-
// distinct source wikis index collisions don't occur).
//
// Collision policies:
//
//   `namespace` (default): rename the colliding entry to
//     `<source-prefix>.<original-id>` where the prefix is the
//     colliding source-wiki's basename (e.g. `reviewers.wiki` →
//     `reviewers`). The original id is preserved in `aliases[]` so
//     inbound references still resolve. Never loses an entry.
//
//   `merge`: when frontmatter is compatible (same focus, same
//     type, same depth_role), fold the duplicates into one entry
//     inheriting both ids via `aliases[]` and both source wikis
//     via `source_wikis[]`. When frontmatter is INcompatible,
//     fall through to `namespace` — we never lose content on a
//     merge fallback.
//
//   `ask`: halt and throw `JOIN-COLLISION-ASK` with the collision
//     set for the caller to surface. The interactive resolution
//     flow is deferred; first-cut just fails loud.
//
// Returns `{ plan, renameMap, mergeMap }`:
//   - plan:       the mutated plan (leaves/indices with renamed ids)
//   - renameMap:  `Map<sourceWiki, Map<oldId, newId>>` — source-
//                 scoped so 3+ sources sharing an id each get their
//                 own entry without overwriting. `rewireReferences`
//                 uses the referring entry's `sourceWiki` to pick
//                 the right rename.
//   - mergeMap:   `Map<absorbedId, keeperId>` — a flat map because
//                 every absorbed id collapses to the keeper's id
//                 regardless of the referring source's identity.
export function resolveIdCollisions(plan, policy = DEFAULT_COLLISION_POLICY) {
  if (!VALID_COLLISION_POLICIES.includes(policy)) {
    throw new Error(
      `join: unknown id-collision policy "${policy}" (valid: ${VALID_COLLISION_POLICIES.join(", ")})`,
    );
  }
  // Include both leaves and indices in collision detection. Each
  // entry is tagged with `kind` so we can apply slightly different
  // rename shapes (a leaf rename also updates relPath's filename;
  // an index rename only updates the id frontmatter — renaming the
  // whole subdirectory is deferred).
  const byId = new Map();
  for (const leaf of plan.leaves) {
    const id = leaf.data.id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ kind: "leaf", record: leaf });
  }
  for (const idx of plan.indices) {
    const id = idx.data.id;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ kind: "index", record: idx });
  }
  const collisions = [...byId.entries()].filter(([, arr]) => arr.length > 1);
  if (collisions.length === 0) {
    return { plan, renameMap: new Map(), mergeMap: new Map() };
  }
  if (policy === "ask") {
    const err = new Error(
      `join: id collisions found and policy=ask — ` +
        `${collisions.length} colliding id(s). Resolve manually and re-invoke.`,
    );
    err.code = "JOIN-COLLISION-ASK";
    err.collisions = collisions.map(([id, arr]) => ({
      id,
      sources: arr.map((entry) => entry.record.sourceWiki),
    }));
    throw err;
  }
  // Source-scoped rename map: Map<sourceWiki, Map<oldId, newId>>.
  // When three sources all contain id "dup", each gets its own
  // namespace-prefixed id; `rewireReferences` picks the right
  // rename by looking up `renameMap.get(referrer.sourceWiki)`.
  const renameMap = new Map();
  const addRename = (sourceWiki, oldId, newId) => {
    if (!renameMap.has(sourceWiki)) renameMap.set(sourceWiki, new Map());
    renameMap.get(sourceWiki).set(oldId, newId);
  };
  const mergeMap = new Map();
  const absorbedPaths = new Set();
  // Running set of every "live" id we've already assigned — both
  // un-renamed keepers AND namespace-prefixed renames. Used to
  // detect secondary collisions: two source wikis with the same
  // basename (e.g. both `/a/reviewers.wiki` and `/b/reviewers.wiki`)
  // would produce identical `reviewers.<id>` prefixed ids without
  // this guard. Seeded with every plan record's current id so
  // namespace renames don't silently collide with non-duplicated
  // ids elsewhere in the plan either.
  const liveIds = new Set();
  for (const leaf of plan.leaves) liveIds.add(leaf.data.id);
  for (const idx of plan.indices) liveIds.add(idx.data.id);
  const reserveId = (baseId) => {
    if (!liveIds.has(baseId)) {
      liveIds.add(baseId);
      return baseId;
    }
    for (let n = 2; n < 1000; n++) {
      const candidate = `${baseId}-${n}`;
      if (!liveIds.has(candidate)) {
        liveIds.add(candidate);
        return candidate;
      }
    }
    throw new Error(
      `join: could not disambiguate namespace-prefixed id "${baseId}" within 1000 attempts`,
    );
  };
  for (const [id, dupes] of collisions) {
    // Keeper is the first source's entry; subsequent entries either
    // merge (merge policy + compatible) or rename (namespace policy,
    // or merge-fallback on incompatible frontmatter).
    const [keeperEntry, ...rest] = dupes;
    const keeper = keeperEntry.record;
    for (const dupEntry of rest) {
      const dup = dupEntry.record;
      const canMerge =
        policy === "merge" &&
        dupEntry.kind === keeperEntry.kind &&
        dup.data.focus === keeper.data.focus &&
        dup.data.type === keeper.data.type &&
        dup.data.depth_role === keeper.data.depth_role;
      if (canMerge) {
        mergeMap.set(dup.data.id, keeper.data.id);
        absorbedPaths.add(dup.absolutePath);
        // Inherit absorbed's aliases (NOT its id — the absorbed
        // id is already the keeper's id, so adding it to
        // aliases[] would create a self-alias the validator
        // rejects under ALIAS-COLLIDES-ID).
        keeper.data.aliases = dedupe([
          ...(keeper.data.aliases || []),
          ...(dup.data.aliases || []),
        ]);
        keeper.data.source_wikis = dedupe([
          ...(keeper.data.source_wikis || [keeper.sourceWiki]),
          dup.sourceWiki,
        ]);
      } else {
        // Namespace: prefix with the basename of the dup's source
        // wiki. `reviewers.wiki` → `reviewers`; the trailing
        // `.wiki` suffix is idiomatic and stripped for the prefix.
        // `reserveId` guards against secondary collisions when two
        // sources share the same basename or when the generated
        // prefix happens to clash with an existing unrelated id.
        const prefix = namespacePrefix(dup.sourceWiki);
        const newId = reserveId(`${prefix}.${id}`);
        // DON'T add the old id to aliases[]: the keeper from the
        // first source still owns the un-prefixed "dup" as its
        // live id. A dup.aliases = ["dup"] would trip
        // ALIAS-COLLIDES-ID at phase 9. Existing aliases the
        // source carried on the dup are preserved byte-identical.
        addRename(dup.sourceWiki, dup.data.id, newId);
        dup.data.id = newId;
        if (dupEntry.kind === "leaf") {
          // Leaf rename: the filename must track the id (validator
          // enforces `ID-MISMATCH-FILE`); rewrite relPath.
          const dir = dirname(dup.relPath);
          dup.relPath =
            dir === "." ? `${newId}.md` : `${dir}/${newId}.md`;
        }
        // Index rename: full directory rename is deferred (see
        // module header). Renaming just the `id` frontmatter would
        // trip ID-MISMATCH-DIR on the rebuilt tree; rather than
        // producing an invalid tree, short-circuit here and fail
        // loud so the user knows joining these specific inputs
        // needs manual disambiguation before re-running.
        if (dupEntry.kind === "index") {
          const err = new Error(
            `join: index id collision on "${id}" between ` +
              `${keeper.sourceWiki} and ${dup.sourceWiki}. ` +
              `Directory-rename for index collisions is not yet ` +
              `supported; rename one of the conflicting directories ` +
              `in its source wiki before joining.`,
          );
          err.code = "JOIN-INDEX-COLLISION";
          throw err;
        }
      }
    }
  }
  const rebuiltLeaves = plan.leaves.filter(
    (l) => !absorbedPaths.has(l.absolutePath),
  );
  const rebuiltIndices = plan.indices.filter(
    (i) => !absorbedPaths.has(i.absolutePath),
  );
  return {
    plan: { leaves: rebuiltLeaves, indices: rebuiltIndices },
    renameMap,
    mergeMap,
  };
}

// ── Phase 5: merge-categories ────────────────────────────────────
//
// When two top-level categories share the same `focus`, fold them
// into one. The first source's index wins; the second source's
// entries[] are appended to the first's and the second's
// subdirectory is merged into the first's.
//
// First-cut: category-level MERGE is recorded in a map but the
// actual subtree move is deferred to phase 7 (apply-operators),
// where runConvergence's MERGE operator handles the same shape
// under a unified tree. So this phase just identifies candidates.
export function mergeCategoriesWithSameFocus(ingestedSources) {
  const byFocus = new Map();
  for (const src of ingestedSources) {
    for (const idx of src.indices) {
      const rel = idx.relPath;
      // Top-level only: relative path must be `<name>/index.md` —
      // exactly one slash.
      if (rel.split("/").length !== 2) continue;
      const focus = idx.data.focus || "";
      if (!focus) continue;
      if (!byFocus.has(focus)) byFocus.set(focus, []);
      byFocus.get(focus).push({ ...idx, sourceWiki: src.wikiRoot });
    }
  }
  const merges = [];
  for (const [focus, group] of byFocus) {
    if (group.length < 2) continue;
    merges.push({ focus, categories: group });
  }
  return merges;
}

// ── Phase 6: rewire-references ───────────────────────────────────
//
// Walk every leaf + index in the plan and rewrite any `links[].id`
// or `overlay_targets[]` entry that points at a renamed or merged
// id. Resolution order for each reference:
//   1. `mergeMap` — absorbed → keeper is source-agnostic (every
//      source's reference to the absorbed id collapses to the
//      same keeper id), so it's consulted first and applies flat.
//   2. `renameMap.get(referrerSourceWiki)` — source-scoped, so a
//      link in source B's frontmatter pointing at "dup" resolves
//      to B's renamed id (e.g. "b.dup"), not A's preserved "dup".
//      This is the fix for the N>2 collision case: before the
//      scope-by-source change, 3+ sources sharing "dup" all
//      clobbered renameMap entries and left references pointing
//      at the last-renamed value.
// Unresolvable references are left as-is; the downstream
// `validateWiki` flags them as `DANGLING-LINK` / `DANGLING-OVERLAY`
// so the user gets a single structured report at phase 9.
//
// `parents[]` entries are POSIX paths, not ids, and never resolve
// via the id maps — they're rewritten at phase 11 by the same
// path-relative rules the regular build pipeline uses.
export function rewireReferences(plan, renameMap, mergeMap) {
  const resolveId = (ref, sourceWiki) => {
    if (typeof ref !== "string") return ref;
    if (mergeMap.has(ref)) return mergeMap.get(ref);
    const sourceRenames = renameMap.get(sourceWiki);
    if (sourceRenames && sourceRenames.has(ref)) return sourceRenames.get(ref);
    return ref;
  };
  const rewriteLinks = (entry) => {
    const src = entry.sourceWiki;
    if (Array.isArray(entry.data.links)) {
      entry.data.links = entry.data.links.map((link) => {
        if (link && typeof link === "object" && typeof link.id === "string") {
          return { ...link, id: resolveId(link.id, src) };
        }
        return link;
      });
    }
    if (Array.isArray(entry.data.overlay_targets)) {
      entry.data.overlay_targets = entry.data.overlay_targets.map((id) =>
        resolveId(id, src),
      );
    }
  };
  for (const leaf of plan.leaves) rewriteLinks(leaf);
  for (const idx of plan.indices) rewriteLinks(idx);
  return plan;
}

// ── Phase 11: materialise to target ──────────────────────────────
//
// Write the unified plan into a prepared empty target directory.
// Each leaf's file is written with the (possibly rewritten)
// frontmatter + body. Subdirectories are created as needed.
// Category indices are written last so directories exist before
// any index tries to enumerate entries[] at rebuild time.
//
// Structural fields on indices (`id`, `depth_role`, `parents`,
// `depth`, `entries`) are STRIPPED before writing. `rebuildAllIndices`
// in phase 8 re-derives every one of them from the target tree's
// actual shape — the source's stale values would trip
// `ID-MISMATCH-DIR` (source root id == `basename(sourceWiki)` which
// is not `basename(target)`) and `PARENTS-REQUIRED` (source subcat
// parents are relative to the source root, not the unified target).
// Authored-intent fields (`focus`, `shared_covers`, `orientation`,
// etc.) ARE preserved from the first source whose index lands at
// a given relPath — that's the closest we get to "category merge"
// without running the convergence MERGE operator here.
//
// Duplicate index relPaths (two sources with the same
// `foo/index.md`) are resolved first-wins: the first source's
// index contributes the authored-intent fields; subsequent writes
// at the same relPath are dropped. If the two indices have
// different focus values, phase 7's convergence-on-unified-tree
// won't merge them (the subcats remain distinct by content);
// phase 9's validation surfaces the near-duplicate via normal
// focus/DUP-ID checks.
//
// Source immutability: writes happen ONLY under `target`, never
// back to any source wiki.
export function materialisePlan(plan, target) {
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  // Write leaves first.
  for (const leaf of plan.leaves) {
    const absPath = join(target, leaf.relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    const data = { ...leaf.data };
    writeFileSync(absPath, renderFrontmatter(data, leaf.body), "utf8");
  }
  // Category indices: write only for directories that actually hold
  // at least one leaf; strip structural fields so `rebuildAllIndices`
  // re-derives them; first-wins on duplicate relPath.
  const liveDirs = new Set();
  for (const leaf of plan.leaves) {
    const parts = leaf.relPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      liveDirs.add(parts.slice(0, i).join("/"));
    }
  }
  liveDirs.add(""); // wiki root always gets an index
  const writtenIndexPaths = new Set();
  for (const idx of plan.indices) {
    const parts = idx.relPath.split("/");
    const dirRel = parts.slice(0, -1).join("/");
    if (!liveDirs.has(dirRel)) continue;
    if (writtenIndexPaths.has(idx.relPath)) continue;
    writtenIndexPaths.add(idx.relPath);
    const absPath = join(target, idx.relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    const data = { ...idx.data };
    // Structural fields — all re-derived by rebuildAllIndices from
    // the materialised tree's actual shape. Source values would
    // mismatch the target's position in the unified hierarchy.
    delete data.id;
    delete data.type;
    delete data.depth_role;
    delete data.depth;
    delete data.parents;
    delete data.entries;
    writeFileSync(absPath, renderFrontmatter(data, idx.body), "utf8");
  }
}

// ── Main entry ───────────────────────────────────────────────────
//
// Orchestrator calls this after it has:
//   - taken a pre-op snapshot on the target
//   - confirmed target is a fresh empty directory
//
// Returns a structured phase log:
//   {
//     phases: [{ name, summary }],
//     warnings: [...],
//     unified: { leaves: N, indices: M }
//   }
//
// Phase 7/8/9 call the existing convergence/indices/validation
// helpers after materialisation, so the same tiered-AI quality mode
// applies to joined trees that applies to ordinary builds.
export async function runJoin(sources, target, ctx = {}) {
  const {
    opId = null,
    qualityMode = "tiered-fast",
    idCollisionPolicy = DEFAULT_COLLISION_POLICY,
    // Optional per-phase commit hook. The orchestrator passes a
    // function that stages + commits between phases so the private
    // git log records the join's progression at per-phase
    // granularity (matching the build pipeline's commit cadence).
    // Shape: async ({ phase, summary }) => void. If absent, runJoin
    // runs end-to-end without intermediate commits — the shape tests
    // in `tests/unit/join.test.mjs` use that path.
    onPhaseCommit = null,
  } = ctx;
  const commitPhase = async (phase, summary) => {
    if (onPhaseCommit) await onPhaseCommit({ phase, summary });
  };
  if (!Array.isArray(sources) || sources.length < 2) {
    throw new Error(`join: at least 2 source wikis required, got ${sources?.length ?? 0}`);
  }
  const phaseLog = [];
  const record = (name, summary) => phaseLog.push({ name, summary });

  // Phase 1 — ingest-all.
  const ingested = sources.map((s) => ingestWiki(s));
  record(
    "ingest-all",
    `read ${ingested.length} source(s); ` +
      `${ingested.reduce((n, i) => n + i.leaves.length, 0)} leaf/leaves, ` +
      `${ingested.reduce((n, i) => n + i.indices.length, 0)} index/indices`,
  );

  // Phase 2 — source-validate.
  const vreport = validateSources(ingested);
  if (vreport.errors.length > 0) {
    const err = new Error(
      `join: source-validate failed — ${vreport.errors.length} error(s) across ${sources.length} source(s). Fix each source before joining:\n` +
        summariseFindings(vreport.errors.slice(0, 10)),
    );
    err.code = "JOIN-SOURCE-INVALID";
    err.findings = vreport.errors;
    throw err;
  }
  record(
    "source-validate",
    `0 errors, ${vreport.warnings.length} warning(s) across ${sources.length} source(s)`,
  );

  // Phase 3 — plan-union.
  const unionPlan = planUnion(ingested);
  record(
    "plan-union",
    `${unionPlan.leaves.length} leaf/leaves + ${unionPlan.indices.length} index/indices in union`,
  );

  // Phase 4 — resolve-id-collisions.
  const { plan: resolvedPlan, renameMap, mergeMap } = resolveIdCollisions(
    unionPlan,
    idCollisionPolicy,
  );
  const totalRenames = [...renameMap.values()].reduce(
    (sum, perSource) => sum + perSource.size,
    0,
  );
  record(
    "resolve-id-collisions",
    `policy=${idCollisionPolicy}; ${totalRenames} rename(s), ${mergeMap.size} merge(s)`,
  );

  // Phase 5 — merge-categories. First-cut is DETECT-ONLY: the
  // helper identifies same-focus top-level categories but does not
  // fold them. runConvergence's MERGE operator only merges sibling
  // leaves (listChildren + leaf-pair scoring), not entire category
  // subtrees — applying category merges requires a separate
  // directory-MERGE operator that's tracked as a follow-up. In
  // the common case (topically-distinct source wikis) there are
  // zero same-focus categories so the phase is a no-op anyway; in
  // the corner case where two sources both have `auth/` with
  // matching focus, the joined tree ends up with two adjacent
  // top-level categories that downstream rebalance can still
  // consolidate if the user chooses.
  const categoryMerges = mergeCategoriesWithSameFocus(ingested);
  record(
    "merge-categories",
    `${categoryMerges.length} same-focus category group(s) detected (fold deferred to a future directory-MERGE operator)`,
  );

  // Phase 6 — rewire-references.
  rewireReferences(resolvedPlan, renameMap, mergeMap);
  record("rewire-references", `resolved via renameMap + mergeMap`);

  // Phase 11a — materialise (intermediate commit point so
  // phase 7 sees a real tree to operate on).
  materialisePlan(resolvedPlan, target);
  record(
    "materialise",
    `wrote ${resolvedPlan.leaves.length} leaf/leaves into ${target}`,
  );
  await commitPhase(
    "join-materialise",
    `${resolvedPlan.leaves.length} leaf/leaves; policy=${idCollisionPolicy}`,
  );

  // Phase 7 — apply-operators (operator-convergence on unified tree).
  const convergence = await runConvergence(target, {
    opId,
    qualityMode,
    interactive: false,
  });
  record(
    "operator-convergence",
    `${convergence.applied.length} operator(s) applied across ${convergence.iterations} iteration(s)`,
  );
  await commitPhase(
    "join-convergence",
    `${convergence.applied.length} operator(s) applied`,
  );

  // Phase 8 — generate-indices.
  const rebuilt = rebuildAllIndices(target);
  record("index-generation", `rebuilt ${rebuilt.length} indices`);
  await commitPhase("join-index-generation", `rebuilt ${rebuilt.length} indices`);

  // Phase 9 — validation.
  const findings = validateWiki(target);
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  if (errors.length > 0) {
    const err = new Error(
      `join: target validation failed — ${errors.length} error(s).\n` +
        summariseFindings(errors.slice(0, 10)),
    );
    err.code = "JOIN-TARGET-INVALID";
    err.findings = errors;
    throw err;
  }
  record("validation", `0 errors, ${warnings.length} warning(s)`);

  // Phase 10 — golden-path-union. Source fixtures are out of scope
  // for the first-cut implementation; record a no-op and leave the
  // hook for downstream work.
  record(
    "golden-path-union",
    "skipped (fixture-regression gate lands as a follow-up)",
  );

  // Phase 11 — commit (the orchestrator handles tagging).
  return {
    phases: phaseLog,
    convergence,
    validation: { errors, warnings },
    unified: {
      leaves: resolvedPlan.leaves.length,
      indices: resolvedPlan.indices.length,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function relPosix(p) {
  return p.split(/[\\\/]/).join("/");
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// Basename of wiki path, stripped of trailing `.wiki` if present.
// Used as the namespace prefix when the `namespace` id-collision
// policy renames `<prefix>.<id>`.
function namespacePrefix(wikiRoot) {
  const base = basename(wikiRoot);
  return base.endsWith(".wiki") ? base.slice(0, -".wiki".length) : base;
}
