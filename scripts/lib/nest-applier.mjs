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
