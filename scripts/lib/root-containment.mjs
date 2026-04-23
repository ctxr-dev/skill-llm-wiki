// root-containment.mjs — enforce "no leaves at wiki root" invariant.
//
// Runs as Phase 4.4.5 (between soft-DAG synthesis and review) so the
// containment commit participates in the `--review` diff — users can
// drop/abort individual containment moves exactly like they can drop
// any other tree-mutating phase's commits.
// Walks `wikiRoot`, collects every `.md` file at depth 1 that isn't
// `index.md`, and moves each into its own semantically-named
// subcategory derived from the leaf's own TF-IDF distinguishing
// tokens. A stub `<slug>/index.md` is written so the new category
// is routable; Phase 5's `rebuildAllIndices` populates the stub's
// `entries[]` on the next pass.
//
// Why a single-member category rather than a shared "uncategorised"
// bucket: every reviewer leaf has `focus` / `covers` / `tags` that
// describe some coherent topic, so the honest answer to "where does
// this belong?" is "in its own tight category named after what it
// is." A shared bucket label admits defeat about something the data
// already tells us; a per-outlier slug preserves the semantic signal.
// If the corpus later grows a topically-adjacent leaf, future builds'
// convergence + balance may nest both into an existing category — a
// single-member start state is a valid transient, not a permanent
// scar.
//
// Slug uniqueness is enforced via `resolveNestSlug` + the full-wiki
// forbidden-id index from PR #5. A generated slug that happens to
// collide with an existing subcategory basename, leaf id, or alias
// elsewhere in the tree gets the `-group` / `-group-N` fallback
// treatment.
//
// parents[] rewrite on the moved leaf:
//   - Primary parent: stays `"index.md"`. The leaf's new direct
//     parent (`<slug>/index.md`) is same-dir-as-leaf, so the
//     POSIX-relative path string doesn't change even though its
//     semantic target moves from root-index to subcategory-index.
//     Same convention `applyBalanceFlatten` leveraged when moving a
//     subtree up one level (PR #8).
//   - Soft parents (if any): paths that were relative to the old
//     leaf-dir (wiki root) gain a "../" prefix because the leaf now
//     sits one level deeper. Example: `"b/index.md"` → `"../b/index.md"`.
//
// Determinism: outlier iteration is lex-sorted by filename, so two
// runs on the same set of outliers produce byte-identical slug
// assignment order (matters for `-group-N` collision tie-breaks).
// `generateDeterministicSlug` + `deterministicPurpose` are both
// byte-stable across member order.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  buildSiblingIdfContext,
  deterministicPurpose,
  generateDeterministicSlug,
} from "./cluster-detect.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { buildWikiForbiddenIndex, resolveNestSlug } from "./nest-applier.mjs";

// Walk the wiki root and return outlier leaves (`.md` files at
// depth 1, excluding `index.md`). Each item is `{ path, data }`
// with parsed frontmatter so the caller can feed directly into
// `generateDeterministicSlug`. Files whose frontmatter fails to
// parse are skipped silently — the validator will surface them
// separately.
function collectRootLeaves(wikiRoot) {
  let entries;
  try {
    entries = readdirSync(wikiRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "index.md") continue;
    if (e.name.startsWith(".")) continue;
    const full = join(wikiRoot, e.name);
    try {
      const raw = readFileSync(full, "utf8");
      const { data } = parseFrontmatter(raw, full);
      if (!data?.id) continue; // unroutable, skip
      out.push({ path: full, data });
    } catch {
      continue;
    }
  }
  // Lex-sorted by filename so slug-resolution tie-breaks (e.g.,
  // `-group-N` collisions) are deterministic across runs.
  out.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  return out;
}

// Walk the wiki root and return the other root-direct children
// (leaves + subcategory indices) as an IDF sibling corpus for
// `generateDeterministicSlug`. The slug algorithm ranks a leaf's
// tokens by distinctiveness vs these siblings, so the corpus must
// include every other top-level entry the slug should discriminate
// against. Passing plain leaves won't tell the IDF ranker that
// "cache" appears in 7 subcategories; passing subcategory `index.md`
// frontmatters does.
function collectRootSiblings(wikiRoot, excludePath) {
  let entries;
  try {
    entries = readdirSync(wikiRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(wikiRoot, e.name);
    if (e.isFile() && e.name.endsWith(".md") && e.name !== "index.md") {
      if (full === excludePath) continue;
      try {
        const { data } = parseFrontmatter(readFileSync(full, "utf8"), full);
        if (data?.id) out.push({ path: full, data });
      } catch {
        /* skip malformed */
      }
    } else if (e.isDirectory()) {
      // Subcategory index.md contributes its frontmatter as a sibling signal
      const indexPath = join(full, "index.md");
      if (!existsSync(indexPath)) continue;
      try {
        const { data } = parseFrontmatter(readFileSync(indexPath, "utf8"), indexPath);
        if (data?.id) out.push({ path: indexPath, data });
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

// Rewrite parents[] after a one-level-down move. Primary parent
// (first entry) stays "index.md" because the leaf's new direct
// parent sits in the same dir as the leaf itself. Every other entry
// gains a "../" prefix because paths that were relative to the old
// leaf-dir (wiki root) are now one level too shallow.
//
// Exception: a parent entry that already starts with "../" is a
// depth-contract violation on the input — a root-level leaf has no
// legitimate parent above wikiRoot to reference. Blindly prepending
// "../" would turn the already-malformed "../foo" into "../../foo",
// escaping the wiki root outright. Preserve the (already-malformed)
// entry byte-identical instead, and let validation surface it
// post-containment under its normal parent-path rules.
function rewriteParentsAfterContainment(leafPath) {
  let raw;
  try {
    raw = readFileSync(leafPath, "utf8");
  } catch {
    return;
  }
  let parsed;
  try {
    parsed = parseFrontmatter(raw, leafPath);
  } catch {
    return;
  }
  if (!parsed?.data) return;
  const parents = Array.isArray(parsed.data.parents) ? parsed.data.parents : [];
  if (parents.length === 0) return;
  const rewritten = parents.map((p, i) => {
    if (typeof p !== "string") return p;
    // Primary stays "index.md" when it was "index.md" (same-dir
    // reference that survives the move).
    if (i === 0 && p === "index.md") return "index.md";
    // Already-escaping paths are preserved byte-identical — adding
    // another "../" to an already-"../"-prefixed entry only digs the
    // depth-contract violation deeper. See module header.
    if (p.startsWith("../")) return p;
    return "../" + p;
  });
  parsed.data.parents = rewritten;
  writeFileSync(leafPath, renderFrontmatter(parsed.data, parsed.body), "utf8");
}

// Write the stub `<slug>/index.md` for a newly-minted single-member
// subcategory. The stub inherits the member's topical signature via
// `deterministicPurpose` so a Claude navigator reading it
// immediately sees what's inside. `rebuildAllIndices` in Phase 5
// will populate the `entries[]` field on the next pass; we don't
// pre-seed it here.
//
// `parents: ["../index.md"]` is pre-seeded on the stub so the
// intermediate root-containment commit satisfies `PARENTS-REQUIRED`
// BEFORE Phase 5's rebuild runs. Without this, a reviewer who later
// drops the Phase-5 commit via `git revert` (the `--review` drop
// flow) would leave a tree with a parentless subcategory index —
// the dropped-state validate would fire `PARENTS-REQUIRED` on every
// stub X.11 created. `rebuildAllIndices` line 185 only fills
// `data.parents` when it's unset, so the seeded value survives the
// Phase 5 pass byte-identical.
function writeStubIndex(targetDir, slug, leaf) {
  const indexPath = join(targetDir, "index.md");
  const data = {
    id: slug,
    type: "index",
    depth_role: "subcategory",
    focus: deterministicPurpose([leaf]) || leaf.data.focus || "",
    parents: ["../index.md"],
    generator: "skill-llm-wiki/v1",
  };
  writeFileSync(indexPath, renderFrontmatter(data, `\n# ${slug}\n`), "utf8");
}

// Main entry. Returns a summary for the orchestrator phase log.
//
// Shape:
//   {
//     outliers: number,          // root leaves detected
//     moved: number,              // successfully contained
//     operations: [{ from, to, slug }]
//   }
//
// Contract:
//   - Zero outliers → no mkdir, no writes, returns { outliers: 0 }.
//   - Each outlier lands in its OWN subcategory (never a shared
//     bucket).
//   - Slug derivation is deterministic (`generateDeterministicSlug`
//     + `resolveNestSlug`'s collision fallback).
//   - parents[] rewrite handled per moved leaf.
export async function runRootContainment(wikiRoot) {
  const outliers = collectRootLeaves(wikiRoot);
  if (outliers.length === 0) {
    return { outliers: 0, moved: 0, operations: [] };
  }

  // Build the wiki-wide forbidden-id index ONCE up front and mutate
  // after each successful slug resolution. Same pattern PR #5
  // established for multi-NEST convergence iterations — the slug
  // resolver short-circuits the full-tree walk via `opts.wikiIndex`
  // and we add each resolved slug to the set so subsequent outliers
  // can't accidentally reuse it.
  const wikiIndex = buildWikiForbiddenIndex(wikiRoot);
  const operations = [];

  for (const outlier of outliers) {
    // Sibling corpus is recomputed per outlier so the newly-added
    // subcategory from the previous iteration is included in the
    // IDF ranking. This matters when two outliers are topically
    // close — the second should emit a slug that discriminates
    // against the first, not a near-duplicate.
    const siblings = collectRootSiblings(wikiRoot, outlier.path);
    const idfMap =
      siblings.length > 0 ? buildSiblingIdfContext(siblings) : undefined;
    const slug = generateDeterministicSlug([outlier], siblings, {
      precomputedIdf: idfMap,
    });
    const proposal = { leaves: [outlier], parent_dir: wikiRoot };
    const resolvedSlug = resolveNestSlug(slug, proposal, wikiRoot, {
      wikiIndex,
    });
    const targetDir = join(wikiRoot, resolvedSlug);
    if (existsSync(targetDir)) {
      // Shouldn't happen if resolveNestSlug did its job, but
      // defensive: an existing dir with the resolved slug would
      // collide on the mkdir below. Surface the failure rather
      // than silently overwrite.
      throw new Error(
        `root-containment: target ${targetDir} already exists for outlier ${basename(outlier.path)} — slug resolution leaked a collision`,
      );
    }
    mkdirSync(targetDir);
    const newLeafPath = join(targetDir, basename(outlier.path));
    renameSync(outlier.path, newLeafPath);
    rewriteParentsAfterContainment(newLeafPath);
    writeStubIndex(targetDir, resolvedSlug, outlier);
    wikiIndex.add(resolvedSlug);
    operations.push({ from: outlier.path, to: newLeafPath, slug: resolvedSlug });
  }

  return {
    outliers: outliers.length,
    moved: operations.length,
    operations,
  };
}
