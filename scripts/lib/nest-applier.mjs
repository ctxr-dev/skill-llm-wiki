// nest-applier.mjs — the applying NEST operator.
//
// Given a cluster proposal (set of sibling leaves all under the
// same parent directory) and a resolved slug (from Tier 2), move
// the leaves into a new subdirectory `<parent>/<slug>/`, rewrite
// each moved leaf's `parents[]` to point at the new parent, and
// bootstrap a minimal `index.md` stub in the new subdirectory.
// The parent index.md is NOT touched here — the caller re-runs
// `rebuildAllIndices` in its phase so the parent's entries[] is
// regenerated with the new subcategory replacing the moved leaves.
//
// Preconditions enforced here:
//
//   1. The resolved slug is a valid kebab-case directory name.
//   2. All leaves share the same parent directory.
//   3. The new subdirectory does not already exist.
//   4. None of the leaf target paths collide with existing files.
//
// On any precondition failure the function throws BEFORE touching
// the filesystem, so the phase's rollback guarantees (pre-op
// snapshot → reset on exception) remain byte-exact.
//
// We do NOT touch the private git here. The caller's phase
// pipeline `git add -A && git commit` after the applier runs is
// what records the change.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";

const SLUG_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function validateSlug(slug) {
  if (typeof slug !== "string") return false;
  return SLUG_RE.test(slug);
}

// Resolve a slug that won't collide with any live id in the wiki. The
// original observed collision case (v0.4.1 novel-corpus run): Tier 2's
// propose_structure response picked slug="security" for a cluster whose
// members included a leaf with id="security", so after apply both the
// new subcategory's stub index.md AND the moved leaf carried
// id="security" — DUP-ID at validate time, forcing a full pipeline
// rollback. A later scenario added cross-depth collisions: a leaf at
// arch/event-patterns/index.md in one branch made the slug
// "event-patterns" unsafe for a cluster under design-patterns-group/
// in a different branch — even though the two are at different depths
// and not siblings.
//
// Pre-resolving here auto-suffixes the slug (deterministically:
// `-group`, then `-group-N`) until it's non-colliding, letting the
// NEST land on the first try. When wikiRoot is provided, the resolver
// checks the full-tree id namespace; when omitted (e.g. legacy unit
// tests that predate cross-depth awareness), it falls back to the
// parent-dir-only check for backward compatibility.
//
// Non-collision slugs are returned unchanged; invalid slugs are left
// alone so applyNest's own validation can reject them with its usual
// error message.
export function resolveNestSlug(slug, proposal, wikiRoot) {
  if (!validateSlug(slug)) return slug;
  if (
    !proposal ||
    !Array.isArray(proposal.leaves) ||
    proposal.leaves.length === 0
  ) {
    return slug;
  }
  const forbidden = collectForbiddenIds(proposal, wikiRoot);
  if (!forbidden.has(slug)) return slug;
  // Try "-group" first (the natural human reading: "the group of X
  // leaves"); fall back to numeric suffixes starting at -group-2
  // because "-group" itself already occupies the slot that would
  // otherwise be "-group-1". If the base slug is so long that
  // "${slug}-group" overflows the 64-char SLUG_RE cap, short-circuit:
  // all numeric candidates share the same prefix and will fail
  // validation identically, so there's no point spinning the loop.
  // Returning the original (colliding) slug propagates the failure
  // to applyNest, which throws a clear "target subcategory already
  // exists" error — strictly better than a silent spin.
  const primary = `${slug}-group`;
  if (!validateSlug(primary)) return slug;
  if (!forbidden.has(primary)) return primary;
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug}-group-${i}`;
    if (!forbidden.has(candidate)) return candidate;
  }
  return slug;
}

function collectForbiddenIds(proposal, wikiRoot) {
  const forbidden = new Set();
  for (const leaf of proposal.leaves) {
    if (leaf?.data?.id) forbidden.add(leaf.data.id);
  }
  const parentDir = dirname(proposal.leaves[0].path);
  const memberPaths = new Set(proposal.leaves.map((l) => l.path));

  // Parent-dir walk (preserved for backward compatibility when wikiRoot
  // is not supplied, and as the fast path when it is).
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    // Skip the parent's own index.md: its id is the parent's basename
    // (i.e., the parent directory name), not something the new
    // subcategory could collide with. Parent-name collisions — where
    // the slug equals the parent dir's name — are a separate case that
    // applyNest itself rejects via its existsSync(targetDir) check.
    if (entry.name === "index.md") continue;
    const entryPath = join(parentDir, entry.name);
    if (memberPaths.has(entryPath)) continue;
    if (entry.isDirectory()) {
      forbidden.add(entry.name);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const raw = readFileSync(entryPath, "utf8");
      const { data } = parseFrontmatter(raw, entryPath);
      if (data?.id) forbidden.add(data.id);
    } catch {
      /* skip unreadable siblings */
    }
  }

  // Full-tree walk: catch cross-depth collisions that the parent-dir
  // walk alone misses. Observed case: a leaf at
  // `arch/event-patterns/index.md` (id "event-patterns") makes the
  // slug "event-patterns" unsafe for a cluster proposed under
  // `design-patterns-group/` in a different branch — even though the
  // two are at different depths and not siblings. Validation catches
  // this post-apply as DUP-ID, forcing rollback; the pre-apply walk
  // here prevents the wasted round-trip.
  //
  // wikiRoot is optional: when absent (legacy callers / unit tests
  // that predate cross-depth awareness), the parent-dir-only walk
  // above is the effective behaviour, preserving prior semantics.
  if (wikiRoot) {
    walkWikiIds(wikiRoot, parentDir, memberPaths, forbidden);
  }

  return forbidden;
}

// Walk the entire wiki under wikiRoot, adding every leaf frontmatter
// id and every directory basename (except `.llmwiki` internals) to the
// `forbidden` set. `parentDir` and `memberPaths` are the cluster's
// own context — leaves already inside the cluster are excluded because
// they'll be moved into the new subdirectory and their id will live
// there, not collide. The parent-dir walk above has already collected
// direct siblings; this pass covers every OTHER directory in the tree.
function walkWikiIds(wikiRoot, parentDir, memberPaths, forbidden) {
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Skip skill-llm-wiki internals so we never traverse the private
      // git under `.llmwiki/git/` or scratch space under `.work/`.
      if (entry.name === ".llmwiki" || entry.name === ".work") continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Directory basename is a potential slug collision (a NEST
        // elsewhere in the tree carrying the same slug would produce
        // two directories with the same id).
        forbidden.add(entry.name);
        stack.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      // Skip leaves that are in the cluster's own parent dir — the
      // parent-dir walk above has already handled them (including the
      // member-exclusion logic). Skipping here avoids double-reading
      // frontmatter on the hot path.
      if (dir === parentDir) continue;
      if (memberPaths.has(entryPath)) continue;
      try {
        const raw = readFileSync(entryPath, "utf8");
        const { data } = parseFrontmatter(raw, entryPath);
        if (data?.id) forbidden.add(data.id);
      } catch {
        /* skip unreadable siblings */
      }
    }
  }
}

export function applyNest(wikiRoot, proposal, slug, opts = {}) {
  void wikiRoot;
  void opts;
  if (!proposal || !Array.isArray(proposal.leaves) || proposal.leaves.length < 2) {
    throw new Error("nest-applier: proposal must carry at least 2 leaves");
  }
  if (!validateSlug(slug)) {
    throw new Error(
      `nest-applier: invalid slug "${slug}" (must match /^[a-z][a-z0-9-]{0,63}$/)`,
    );
  }
  const parentDirs = new Set(proposal.leaves.map((l) => dirname(l.path)));
  if (parentDirs.size !== 1) {
    throw new Error(
      `nest-applier: leaves belong to ${parentDirs.size} different parent dirs — cannot NEST across parents in one step`,
    );
  }
  const parentDir = parentDirs.values().next().value;
  const targetDir = join(parentDir, slug);
  if (existsSync(targetDir)) {
    throw new Error(
      `nest-applier: target subcategory ${targetDir} already exists`,
    );
  }

  // Precompute target paths and check for collisions BEFORE any
  // filesystem mutation.
  const moves = [];
  for (const leaf of proposal.leaves) {
    const targetPath = join(targetDir, basename(leaf.path));
    if (existsSync(targetPath)) {
      throw new Error(
        `nest-applier: target leaf path ${targetPath} already exists`,
      );
    }
    moves.push({ from: leaf.path, to: targetPath, leaf });
  }

  // Create the target directory and move each leaf into it,
  // rewriting the parents[] field as we go. We use `renameSync`
  // rather than a raw move so the private git sees the rename
  // as a proper content-preserving move on the next `git add`.
  mkdirSync(targetDir, { recursive: true });
  for (const move of moves) {
    const raw = readFileSync(move.from, "utf8");
    const { data, body } = parseFrontmatter(raw, move.from);
    // Rewrite parents[] to point at the new subcategory's
    // index.md. The methodology says parents[] uses POSIX-relative
    // paths; for a leaf at `<parent>/<slug>/foo.md`, the direct
    // parent index.md lives at `<parent>/<slug>/index.md`, which
    // is `index.md` relative to the leaf itself.
    data.parents = ["index.md"];
    writeFileSync(move.to, renderFrontmatter(data, body), "utf8");
    // Unlink the old location. The new file has already been
    // written, so this is a destructive move but at the same
    // level as the rollback guarantee (which resets the working
    // tree to the pre-op snapshot on any exception upstream).
    rmSync(move.from, { force: true });
  }

  // Bootstrap an index.md stub in the new subcategory. The stub is
  // minimal: `id`, `type`, `depth_role`, `focus` (from the Tier 2
  // cluster purpose, with a placeholder fallback), any shared tags
  // and shared_covers that the cluster members have in common, and
  // the `parents[]` / `generator` marker that the subsequent
  // `rebuildAllIndices` pass fills in. No `activation_defaults`
  // aggregation: routing is semantic now — Claude decides descent
  // from `focus` and `shared_covers` rather than from a literal
  // keyword/tag union. Per-leaf `activation` blocks stay on the
  // leaves as optional semantic hints (see SKILL.md "Routing into
  // guide.wiki/").
  const sharedTags = intersectTags(proposal.leaves.map((l) => l.data.tags || []));
  const sharedCovers = intersectCovers(proposal.leaves.map((l) => l.data.covers || []));
  const purpose = typeof proposal.purpose === "string" ? proposal.purpose.trim() : "";
  const stubData = {
    id: slug,
    type: "index",
    depth_role: "subcategory",
    focus: purpose || `subtree under ${slug}`,
  };
  if (sharedTags.length > 0) stubData.tags = sharedTags;
  if (sharedCovers.length > 0) {
    stubData.shared_covers = sharedCovers;
  }
  const stubBody =
    "\n<!-- BEGIN AUTO-GENERATED NAVIGATION -->\n\n" +
    "<!-- END AUTO-GENERATED NAVIGATION -->\n\n" +
    "<!-- BEGIN AUTHORED ORIENTATION -->\n\n" +
    "<!-- END AUTHORED ORIENTATION -->\n";
  const stubPath = join(targetDir, "index.md");
  writeFileSync(stubPath, renderFrontmatter(stubData, stubBody), "utf8");

  return {
    target_dir: targetDir,
    moved: moves.map((m) => ({ from: m.from, to: m.to })),
    stub: stubPath,
    shared_tags: sharedTags,
    shared_covers: sharedCovers,
  };
}

function intersectTags(lists) {
  if (lists.length === 0) return [];
  const first = new Set(lists[0]);
  const out = [];
  for (const t of first) {
    if (lists.every((l) => l.includes(t))) out.push(t);
  }
  return out.sort();
}

// Deterministic intersection of cover strings across cluster
// members. Case-sensitive string equality. Result is sorted so
// stub bodies are byte-deterministic across rebuilds.
function intersectCovers(lists) {
  if (lists.length === 0) return [];
  if (lists.length === 1) return [];
  const first = new Set(lists[0]);
  const out = [];
  for (const item of first) {
    if (lists.every((l) => l.includes(item))) out.push(item);
  }
  return out.sort();
}

// Historical note: an `aggregateActivation(leaves)` helper used to
// live here. It unioned `activation.keyword_matches`,
// `activation.tag_matches`, `tags[]`, and `activation.escalation_from`
// across cluster members into a single `activation_defaults` block
// for the new subcategory stub. That block was the old literal-
// routing substrate — the router's deterministic descent rule was an
// AND-filter on `activation_defaults.tag_matches ∩ profile.tags`.
// The rule has been removed in favour of semantic routing (Claude
// matches on the stub's `focus` + `shared_covers`), so the helper
// has no callers and was deleted.
