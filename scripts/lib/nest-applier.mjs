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
import { readFrontmatterStreaming } from "./chunk.mjs";
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
//
// `opts.wikiIndex` is an optional precomputed Set of every live id and
// directory basename in the wiki (see `buildWikiForbiddenIndex`). When
// supplied, the full-tree walk is skipped and the precomputed set is
// merged into the per-proposal forbidden set instead. A multi-NEST
// convergence iteration builds the index once before the apply loop
// and mutates it incrementally (adds the resolved slug after each
// successful apply), reducing the slug-resolver cost from
// O(#applies × #files) to O(#files + #applies).
export function resolveNestSlug(slug, proposal, wikiRoot, opts = {}) {
  if (!validateSlug(slug)) return slug;
  if (
    !proposal ||
    !Array.isArray(proposal.leaves) ||
    proposal.leaves.length === 0
  ) {
    return slug;
  }
  const isForbidden = collectForbiddenIdsPredicate(
    proposal,
    wikiRoot,
    opts.wikiIndex,
  );
  if (!isForbidden(slug)) return slug;
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
  if (!isForbidden(primary)) return primary;
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug}-group-${i}`;
    if (!isForbidden(candidate)) return candidate;
  }
  return slug;
}

// Build a predicate `(id) => boolean` that returns `true` when `id`
// collides with any already-claimed id in the wiki — member ids,
// parent-dir sibling ids, parent-dir subdir basenames, and either the
// caller's precomputed wiki-wide index (preferred) or a fresh
// walkWikiIds fallback (legacy path).
//
// Why a predicate instead of a materialized Set: when the caller
// passes a precomputed `wikiIndex`, that index can easily be 10⁴+
// entries on a large corpus. Copying the whole index into a new
// per-call Set costs O(|wikiIndex|) memory + time on every
// resolveNestSlug invocation, which defeats the entire point of the
// iteration-level precompute. A predicate keeps the wiki-wide index
// by reference and queries it directly, making each `isForbidden(x)`
// check O(1) and each resolveNestSlug call O(|members| + |parent-
// siblings|) regardless of wiki size.
function collectForbiddenIdsPredicate(
  proposal,
  wikiRoot,
  precomputedWikiIndex = null,
) {
  // Local set: member ids + parent-dir sibling ids/subdirs. Always
  // small (bounded by one directory's children), so materializing it
  // is fine.
  const local = new Set();
  for (const leaf of proposal.leaves) {
    if (leaf?.data?.id) local.add(leaf.data.id);
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
      local.add(entry.name);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const raw = readFileSync(entryPath, "utf8");
      const { data } = parseFrontmatter(raw, entryPath);
      if (data?.id) local.add(data.id);
    } catch {
      /* skip unreadable siblings */
    }
  }

  // Wiki-wide path. Precomputed index short-circuits the walk AND we
  // keep it by reference inside the predicate instead of copying it
  // into `local`. Legacy callers without precomputedWikiIndex fall
  // back to the one-shot walkWikiIds, which materializes into `local`
  // (the walk's output is bounded to "this call only" so no memory
  // concern there).
  //
  // Full-tree walk catches cross-depth collisions that the parent-dir
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
  if (!precomputedWikiIndex && wikiRoot) {
    walkWikiIds(wikiRoot, parentDir, memberPaths, local);
  }

  if (precomputedWikiIndex) {
    return (id) => local.has(id) || precomputedWikiIndex.has(id);
  }
  return (id) => local.has(id);
}

// Build a wiki-wide forbidden-id index: the set of every leaf
// frontmatter id and every non-hidden directory basename under
// `wikiRoot`. Exposed as a reusable snapshot the caller can build
// once and pass to `resolveNestSlug` via `opts.wikiIndex` instead of
// paying for a full-tree walk on every invocation.
//
// Mutation contract: after a successful NEST apply, the caller must
// call `wikiIndex.add(resolvedSlug)` so subsequent `resolveNestSlug`
// calls in the same iteration see the new directory as occupied.
// No other mutations are needed — leaf ids don't change when leaves
// move into the new subdir, and nothing is deleted by a NEST apply.
//
// Dot-prefixed entries (directories AND files — anything whose name
// starts with `.`) are skipped under the same blanket rule as
// `walkWikiIds` / `collectEntryPaths`. Covers skill-owned internals
// (`.llmwiki/`, `.work/`, `.shape/`), the user's git metadata
// (`.git/`, `.github/`), transient dotfiles (`.DS_Store`, editor
// backups), and hypothetical `.foo.md` leaves. Per-file frontmatter
// is extracted via `readFrontmatterStreaming` for bounded reads on
// large corpora.
export function buildWikiForbiddenIndex(wikiRoot) {
  const set = new Set();
  if (!wikiRoot) return set;
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
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        set.add(entry.name);
        stack.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      try {
        const captured = readFrontmatterStreaming(entryPath);
        if (captured === null) continue;
        const { data } = parseFrontmatter(captured.frontmatterText, entryPath);
        if (data?.id) set.add(data.id);
      } catch {
        /* skip unreadable / malformed frontmatter */
      }
    }
  }
  return set;
}

// Walk the entire wiki under wikiRoot, adding every leaf frontmatter
// id and every non-hidden directory basename to the `forbidden` set.
// `parentDir` and `memberPaths` are the cluster's own context — leaves
// already inside the cluster are excluded because they'll be moved
// into the new subdirectory and their id will live there, not collide.
// The parent-dir walk above has already collected direct siblings;
// this pass covers every OTHER directory in the tree.
//
// Dot-prefixed entries (directories AND files) are skipped as a
// blanket rule — this matches the discipline in
// `scripts/lib/chunk.mjs::collectEntryPaths` and covers every
// metadata surface the skill owns (`.llmwiki/`, `.work/`, `.shape/`),
// any user dotfile directory the corpus might carry (`.git/`,
// `.github/`, etc), AND any stray dotfiles (`.DS_Store`, hypothetical
// `.foo.md` leaves). There is no allow-list: if a dot-prefixed entry
// is worth considering as a routable leaf, rename it.
//
// Per-file frontmatter is extracted via the streaming reader so this
// collision pass reads bounded (≤ `MAX_FRONTMATTER_BYTES`) from each
// file rather than the full body — a real concern on large corpora
// (the frontmatter-bearing leaves at the consumer 596-leaf scale
// already parse through `readFrontmatterStreaming` elsewhere in the
// pipeline for the same reason).
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
      // Skip hidden directories (including skill-llm-wiki internals
      // like `.llmwiki/` and scratch `.work/`) so we do not treat
      // metadata as wiki content.
      if (entry.name.startsWith(".")) continue;
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
      // Skip ordinary leaves that are in the cluster's own parent
      // dir — the parent-dir walk above has already handled them
      // (including the member-exclusion logic). Skipping avoids
      // double-reading frontmatter on the hot path.
      //
      // EXCEPTION: parent's own index.md. The parent-dir walk
      // explicitly skips index.md because in the nested case its id
      // equals the parent-directory basename (`validate.mjs` enforces
      // `type: index` id === `basename(dirname(index.md))` for every
      // index depth), and a slug-vs-parent-name collision is caught
      // by applyNest's existsSync(targetDir) check — different class.
      //
      // But when parentDir === wikiRoot, the parent-dir walk is the
      // ONLY walk pass that would surface the root index.md (this
      // tree walk starts at wikiRoot and only visits its CHILDREN as
      // directory entries, never wikiRoot itself; so the wiki-root
      // basename is never added via the `entry.isDirectory()` branch
      // either). Without parsing root/index.md, a slug equal to
      // `basename(wikiRoot)` — the mandatory root id — would slip
      // past both walks and surface only at post-apply DUP-ID
      // validation.
      //
      // Parse index.md specifically to close that gap. One extra
      // frontmatter-stream read per walk on a small, bounded file.
      if (dir === parentDir && entry.name !== "index.md") continue;
      if (memberPaths.has(entryPath)) continue;
      try {
        const captured = readFrontmatterStreaming(entryPath);
        if (captured === null) continue;
        const { data } = parseFrontmatter(captured.frontmatterText, entryPath);
        if (data?.id) forbidden.add(data.id);
      } catch {
        /* skip unreadable / malformed frontmatter */
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
