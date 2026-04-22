// soft-dag.mjs — post-convergence DAG soft-parent synthesis.
//
// Runs when the caller passes `--soft-dag-parents` on build or
// rebuild. For each routable leaf, compares the leaf's TF-IDF vector
// against every candidate category-directory's aggregate vector;
// directories whose cosine similarity meets the threshold become
// SOFT parents. The leaf's `parents[]` frontmatter is rewritten with
// the primary parent FIRST (POSIX-relative to the direct parent
// index.md, typically `"index.md"` or `"../index.md"`), followed by
// one entry per chosen soft parent, likewise POSIX-relative to the
// same origin (the leaf's direct parent's `index.md`).
//
// Downstream, `applySoftParentEntries` re-walks the tree after index
// generation and appends each leaf's record into every soft-parent
// index's `entries[]`. The rebuilder never moves files on disk — a
// leaf's physical location remains under its primary parent; only
// the leaf's `parents[]` pointer array and every claimed parent's
// `entries[]` expand.
//
// Determinism: lex-sorted leaf iteration, lex-sorted candidate-dir
// iteration inside each leaf's pass, lex-sorted frontmatter
// serialisation. Two runs on the same tree produce byte-identical
// output.
//
// Threshold + cap: a cosine similarity ≥ `SOFT_PARENT_AFFINITY_THRESHOLD`
// is required for a candidate to qualify; the top
// `SOFT_PARENT_MAX_PER_LEAF` qualifying candidates per leaf are kept.
// Ranking is descending cosine with POSIX-path ascending as a
// deterministic tie-break.
//
// Subcommand scope: build + rebuild only. Intent validation rejects
// the flag elsewhere via `INT-16a` for the same reasons the balance
// flags reject in non-{build,rebuild} (see intent.mjs).

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { readFrontmatterStreaming } from "./chunk.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { listChildren, readIndex } from "./indices.mjs";
import {
  buildComparisonModelFromTexts,
  cosine,
  entryText,
  tfidfVector,
} from "./similarity.mjs";

// Minimum cosine similarity between a leaf and a candidate category
// directory for the category to qualify as a soft parent. Calibrated
// against similarity.mjs's Tier-0 thresholds: the `TIER0_DECISIVE_DIFFERENT
// = 0.30` floor marks "definitely unrelated" at pairwise-leaf scale,
// and the `TIER0_DECISIVE_SAME = 0.85` ceiling marks "definitely same
// topic". Soft parents want the middle-of-the-band "clearly related
// but not identical" zone — ~0.35 is empirically the lowest point
// where a category-vs-leaf cosine consistently reflects topical
// overlap (rather than accidental token reuse). A two-aggregate
// comparison inflates average cosine slightly vs pairwise, so we
// sit above DECISIVE_DIFFERENT by about one standard deviation of
// background noise.
export const SOFT_PARENT_AFFINITY_THRESHOLD = 0.35;

// Cap on soft parents per leaf (primary parent not counted toward the
// cap). Three soft parents + one primary = max four index locations a
// single leaf appears in. Chosen on the same token-economy reasoning
// as Phase X.5's fan-out target: a Claude navigator reading one
// leaf's parents[] tolerates a handful of entries before signal
// quality drops. Higher caps dilute the "this is where the leaf
// belongs" hint into noise.
export const SOFT_PARENT_MAX_PER_LEAF = 3;

// Walk the wiki and collect every routable leaf's absolute path +
// parsed frontmatter. Uses readdir directly (not `listChildren`) so
// pre-bootstrap category dirs — directories created by Phase 3 draft
// that don't have `index.md` yet — are still descended into. Leaves
// themselves are validated with the same frontmatter-must-have-id
// discipline `listChildren` uses. Dot-prefixed entries are skipped
// under the blanket pipeline rule.
//
// `withBody` controls read mode:
//   - `true` (default for `runSoftDagParents`): `readFileSync` +
//     `parseFrontmatter` so the caller can write leaves back via
//     `renderFrontmatter(data, body)` preserving the body bytes.
//   - `false` (used by `applySoftParentEntries`): bounded
//     `readFrontmatterStreaming` so the walk only pays the
//     frontmatter-byte cost, not the full-file-bytes cost. Matters
//     at the 596-leaf consumer-corpus scale where bodies can dwarf
//     frontmatter.
function collectAllLeaves(wikiRoot, withBody = true) {
  const out = [];
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
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".md")) continue;
      if (e.name === "index.md") continue;
      let parsed;
      let body;
      try {
        // Both modes use `readFrontmatterStreaming` to get the
        // frontmatter text + byte offset. That function normalises
        // CRLF → LF on the frontmatter payload so `parseFrontmatter`
        // (which only recognises an LF fence) sees the expected
        // form. Pre-round-2 the withBody path used `readFileSync` +
        // `parseFrontmatter` directly, which silently dropped
        // CRLF-fence leaves (common on Windows editors) and made
        // them invisible to soft-DAG synthesis.
        const captured = readFrontmatterStreaming(full);
        if (!captured) continue;
        parsed = parseFrontmatter(captured.frontmatterText, full);
        if (withBody) {
          // Read the raw file as a buffer and slice at the original
          // byte offset so multi-byte characters at the fence
          // boundary don't corrupt the body. `captured.bodyOffset`
          // is the byte index just after the CLOSING fence.
          const raw = readFileSync(full);
          body = raw.slice(captured.bodyOffset).toString("utf8");
        }
      } catch {
        continue;
      }
      if (!parsed?.data?.id) continue;
      out.push(
        withBody
          ? { path: full, data: parsed.data, body }
          : { path: full, data: parsed.data },
      );
    }
  }
  return out;
}

// Walk the wiki and collect every non-dot category directory (any
// directory that could be a soft-parent target). The wiki root is
// included since leaves from deep subtrees can claim the root as a
// soft parent (the typed "this is also broadly relevant to the root
// topic" pointer). A category is eligible as a soft-parent target if
// it has an `index.md` OR at least one ROUTABLE leaf directly
// underneath. Routability matches `listChildren`'s semantics: the
// `.md` file must have frontmatter with an `id`. A dir that holds
// only non-routable markdown (README.md with no frontmatter, notes
// from a manual edit) would otherwise become a tombstone candidate
// and skew scoring against other real categories. `listChildren`
// performs the frontmatter parse with bounded reads via
// `readFrontmatterStreaming`; we reuse it rather than re-implementing.
function collectCandidateDirs(wikiRoot) {
  const out = [];
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirs = [];
    let hasIndex = false;
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        subdirs.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name === "index.md") {
        hasIndex = true;
      }
    }
    // Routable-leaf check via listChildren: only leaves whose
    // frontmatter parses with an `id` count. A dir holding only
    // README-style markdown without frontmatter is NOT a candidate.
    const { leaves } = listChildren(dir);
    const hasRoutableLeaf = leaves.length > 0;
    if (dir === wikiRoot || hasIndex || hasRoutableLeaf) {
      out.push(dir);
    }
    for (const sub of subdirs) stack.push(sub);
  }
  return out;
}

// Build the aggregate semantic text for a candidate category
// directory. Includes the directory's `index.md` frontmatter
// (`focus`, `covers`, `tags`, `domains` — the full set `entryText`
// uses, with focus doubled for emphasis) when present PLUS each
// routable leaf directly under it via `entryText`. Descendant
// leaves are deliberately NOT included — soft parents claim leaves
// on direct topical overlap, not on transitive subtree content, so
// aggregating across depths would let a leaf latch onto a root
// category it only matches through a deeply nested cousin.
function buildCategoryText(dir) {
  const parts = [];
  const idx = readIndex(dir);
  if (idx?.data) parts.push(entryText(idx.data));
  const { leaves } = listChildren(dir);
  for (const leaf of leaves) parts.push(entryText(leaf.data));
  return parts.join(" ").trim();
}

// Normalise an absolute path to a POSIX-separator string relative to
// `fromDir`. Matches Phase X.5's `posixSortKey` discipline: on
// Windows `path.relative` emits `\\` which would pollute
// `parents[]` strings with OS-specific separators and break
// cross-platform byte-reproducibility. Soft-parent paths are POSIX
// in on-disk form.
function posixRelative(fromDir, toPath) {
  const rel = relative(fromDir, toPath);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

// Given a leaf at absolute `leafPath` and a soft-parent candidate
// `targetDir` (also absolute), produce the POSIX-relative path from
// the leaf's direct-parent `index.md` to `targetDir/index.md`.
// Balance's flatten pass keeps `parents[]` relative to the direct
// parent's `index.md` (see `applyBalanceFlatten` doc); the
// convention is the same for soft parents.
//
// Examples (POSIX):
//   leaf=wiki/a/l.md, target=wiki/a       → "index.md"
//   leaf=wiki/a/l.md, target=wiki/b       → "../b/index.md"
//   leaf=wiki/a/b/l.md, target=wiki/      → "../../index.md"
function relativeParentPath(leafPath, targetDir) {
  const leafDir = dirname(leafPath);
  return posixRelative(leafDir, join(targetDir, "index.md"));
}

// Score a leaf against every candidate directory (excluding the
// leaf's own direct parent — that's the primary, not a soft parent).
// Returns an array of `{ dir, cosine }` sorted by cosine descending,
// POSIX-path ascending as a deterministic tie-break. Only scores at
// or above the caller's `threshold` are included.
//
// Threshold is passed as a parameter rather than hard-coded so an
// override via `ctx.threshold` in `runSoftDagParents` takes effect
// AT THIS FILTER. An earlier draft hard-coded the constant here and
// re-filtered post-facto — if the override was LOWER than the
// constant, candidates in the window [override, constant) were
// dropped at scoring time and couldn't be reinstated.
function scoreCandidates(
  leaf,
  leafVector,
  candidates,
  categoryVectors,
  wikiRoot,
  threshold,
) {
  const primaryDir = dirname(leaf.path);
  const scored = [];
  for (const dir of candidates) {
    if (dir === primaryDir) continue;
    const catVec = categoryVectors.get(dir);
    if (!catVec) continue;
    const sim = cosine(leafVector, catVec);
    if (sim < threshold) continue;
    scored.push({ dir, cosine: sim });
  }
  scored.sort((a, b) => {
    if (b.cosine !== a.cosine) return b.cosine - a.cosine;
    // Deterministic lex tie-break via POSIX-normalised relative path.
    const aKey = posixRelative(wikiRoot, a.dir);
    const bKey = posixRelative(wikiRoot, b.dir);
    return aKey.localeCompare(bKey);
  });
  return scored;
}

// Resolve the PRIMARY parent path-string for a leaf. parents[] is
// POSIX-relative to the LEAF's directory. The primary parent is
// the leaf's direct-parent `index.md`, which sits in the same
// directory as the leaf — so the path-string is always `"index.md"`
// regardless of the leaf's depth. This matches the convention
// `rebuildIndex` derives and the shape `applyBalanceFlatten` relies
// on (see the doc comment there — promoting a subtree preserves
// every relative parents[] entry by construction because they're
// all anchored at the leaf's own dir).
function primaryParentPath() {
  return "index.md";
}

// Atomic write: materialise to `<path>.tmp` then rename into place.
// Matches `indices.mjs::atomicWriteFile`'s discipline — a crash or
// SIGKILL between writeFileSync and renameSync leaves EITHER the
// old file intact OR the temp file orphaned, never a partially-
// written target. Both leaf rewrites (`rewriteLeafParents`) and
// index rewrites (`applySoftParentEntries`) route through this so
// the soft-DAG phase matches the durability expectations the rest
// of the index-generation pipeline sets.
function atomicWriteFile(targetPath, content) {
  const tmp = targetPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, targetPath);
}

// Rewrite the leaf's frontmatter with an expanded `parents[]` array.
// Primary parent first, soft parents after in score order. The body
// is preserved byte-exact; only the frontmatter is re-serialised.
function rewriteLeafParents(leaf, parentsArray) {
  const newData = { ...leaf.data, parents: parentsArray };
  const serialised = renderFrontmatter(newData, leaf.body);
  atomicWriteFile(leaf.path, serialised);
}

// Main entry point. Returns a summary of work done; the caller
// (orchestrator Phase 4.4) records it in the phase log.
//
// Shape:
//   {
//     leavesProcessed: number,
//     softParentsAdded: number,        // total across all leaves
//     perLeaf: Map<leafPath, string[]> // soft-parent paths per leaf
//                                      // (empty array if none qualified)
//   }
//
// Contract with the caller:
//   - `wikiRoot` must point at a valid wiki root (has root index.md
//     or is in pre-bootstrap state from Phase 3 draft — both are
//     tolerated by `collectAllLeaves` + `collectCandidateDirs`).
//   - `ctx.threshold` and `ctx.maxPerLeaf` may override the exported
//     defaults for tests that want deterministic boundary behaviour.
//   - No commits: the orchestrator's phase infrastructure handles
//     git-add + git-commit around this call.
export async function runSoftDagParents(wikiRoot, ctx = {}) {
  const {
    threshold = SOFT_PARENT_AFFINITY_THRESHOLD,
    maxPerLeaf = SOFT_PARENT_MAX_PER_LEAF,
  } = ctx;

  const leaves = collectAllLeaves(wikiRoot);
  leaves.sort((a, b) =>
    posixRelative(wikiRoot, a.path).localeCompare(
      posixRelative(wikiRoot, b.path),
    ),
  );
  if (leaves.length === 0) {
    return { leavesProcessed: 0, softParentsAdded: 0, perLeaf: new Map() };
  }

  const candidateDirs = collectCandidateDirs(wikiRoot);
  candidateDirs.sort((a, b) =>
    posixRelative(wikiRoot, a).localeCompare(posixRelative(wikiRoot, b)),
  );

  // Build one corpus over all leaves AND all candidate-category
  // texts. Unified IDF means leaf-vs-category cosines sit on the
  // same TF-IDF basis as Phase X.3 / similarity.mjs's pairwise
  // scores, so threshold calibration transfers.
  //
  // Leaf text comes from `entryText(leaf.data)` which already
  // applies the doubled-focus weighting. Category text is
  // pre-aggregated by `buildCategoryText` (which also routes
  // through `entryText` for each contributor). Both are passed
  // as-is to `buildComparisonModelFromTexts` — a plain texts-array
  // constructor that skips the `entryText` roundtrip
  // `buildComparisonModel` would otherwise perform, avoiding a
  // second round of focus-doubling on pre-assembled strings.
  const leafTexts = leaves.map((l) => entryText(l.data));
  const catTextMap = new Map();
  for (const dir of candidateDirs) {
    catTextMap.set(dir, buildCategoryText(dir));
  }
  const corpusTexts = [...leafTexts, ...Array.from(catTextMap.values())];
  const model = buildComparisonModelFromTexts(corpusTexts);
  const leafVectors = new Map();
  for (let i = 0; i < leaves.length; i++) {
    leafVectors.set(leaves[i].path, tfidfVector(model.tokenLists[i], model.idfMap));
  }
  const categoryVectors = new Map();
  let idx = leaves.length;
  for (const dir of candidateDirs) {
    categoryVectors.set(
      dir,
      tfidfVector(model.tokenLists[idx], model.idfMap),
    );
    idx++;
  }

  const perLeaf = new Map();
  let softParentsAdded = 0;
  for (const leaf of leaves) {
    const leafVec = leafVectors.get(leaf.path);
    const scored = scoreCandidates(
      leaf,
      leafVec,
      candidateDirs,
      categoryVectors,
      wikiRoot,
      threshold,
    );
    const chosen = scored.slice(0, maxPerLeaf);
    const softParents = chosen.map((c) => relativeParentPath(leaf.path, c.dir));
    const parentsArray = [primaryParentPath(), ...softParents];
    rewriteLeafParents(leaf, parentsArray);
    perLeaf.set(leaf.path, softParents);
    softParentsAdded += softParents.length;
  }

  return {
    leavesProcessed: leaves.length,
    softParentsAdded,
    perLeaf,
  };
}

// Post-index-rebuild pass: for every leaf claiming a soft parent,
// append the leaf's `entries[]` record to each claimed parent
// directory's `index.md`. `rebuildAllIndices` only places a leaf in
// its direct-parent `index.md`; this pass extends the DAG view so a
// Claude navigator arriving at any claimed parent sees the leaf in
// that parent's `entries[]`.
//
// The leaf's `parents[]` is the ground truth: we never invent claims.
// The pass walks every leaf, resolves each non-primary `parents[]`
// entry to an absolute index path, reads the target `index.md`,
// appends a minimal entry record (mirroring `rebuildIndex`'s shape),
// and re-writes the index. Records already present (same `id`) are
// skipped so the pass is idempotent — running it twice on the same
// tree produces the same bytes.
export function applySoftParentEntries(wikiRoot) {
  // Frontmatter-only reads for the propagation pass — we never
  // rewrite leaves here, only their claimed parent index.md files,
  // so there's no need to buffer bodies in memory. On large corpora
  // (the 596-leaf target workload) body bytes dwarf frontmatter
  // bytes, so bounded streaming reads turn this from O(total leaf
  // bytes) into O(frontmatter bytes).
  const leaves = collectAllLeaves(wikiRoot, /* withBody */ false);
  // Deterministic iteration so repeated runs produce byte-identical
  // output regardless of OS filesystem enumeration order.
  leaves.sort((a, b) =>
    posixRelative(wikiRoot, a.path).localeCompare(
      posixRelative(wikiRoot, b.path),
    ),
  );

  // Group soft-parent appends by target index path. We resolve once
  // per leaf-parent pair, dedupe against existing `entries[]` by id,
  // then commit per-index in a single pass at the end to avoid
  // quadratic file I/O.
  const softAppendsByIndex = new Map(); // indexPath → Array<record>

  for (const leaf of leaves) {
    const parents = Array.isArray(leaf.data.parents) ? leaf.data.parents : [];
    if (parents.length <= 1) continue; // primary-only, nothing to do
    const leafDir = dirname(leaf.path);
    const record = buildEntryRecord(leaf, leafDir);
    // Skip the first entry (primary); everything after is soft.
    for (let i = 1; i < parents.length; i++) {
      const rel = parents[i];
      if (typeof rel !== "string" || rel.length === 0) continue;
      const absIndex = normaliseIndexPath(leafDir, rel, wikiRoot);
      if (!absIndex) continue;
      if (!existsSync(absIndex)) continue;
      // The `file:` field is relative to the target index's directory,
      // not the leaf's direct parent.
      const targetDir = dirname(absIndex);
      const targetRecord = {
        ...record,
        file: posixRelative(targetDir, leaf.path),
      };
      const list = softAppendsByIndex.get(absIndex) ?? [];
      list.push(targetRecord);
      softAppendsByIndex.set(absIndex, list);
    }
  }

  // Actual-write counters. Pre-round-2 the returned stats were
  // derived from `softAppendsByIndex.size` and the sum of its value
  // arrays — the PLANNED appends. That over-reported on reruns (every
  // id already present → zero actual writes but indicesTouched still
  // counted) and over-reported when an index failed to parse.
  // Tracking the actual writes keeps orchestrator phase logging
  // honest across idempotent and hostile-fixture cases.
  let indicesTouched = 0;
  let softEntriesAdded = 0;
  for (const [indexPath, appends] of softAppendsByIndex) {
    // Per-index try/catch: a malformed target `index.md` (e.g.,
    // user-edited YAML that fails to parse) must NOT abort the
    // entire propagation pass. Soft-DAG synthesis is best-effort;
    // the rest of the pipeline (`listChildren`, `collectAllLeaves`)
    // follows the same skip-and-continue discipline for malformed
    // frontmatter. Downstream validation surfaces the bad index
    // with its own diagnostic.
    let raw, parsed;
    try {
      raw = readFileSync(indexPath, "utf8");
      parsed = parseFrontmatter(raw, indexPath);
    } catch {
      continue;
    }
    if (!parsed?.data) continue;
    const existing = Array.isArray(parsed.data.entries)
      ? parsed.data.entries
      : [];
    const existingIds = new Set(existing.map((e) => e?.id).filter(Boolean));
    // De-dupe by id: a leaf may already be in the index's entries
    // (primary case) or may appear twice across soft claims in
    // degenerate fixtures.
    const newEntries = existing.slice();
    let addedThisIndex = 0;
    for (const rec of appends) {
      if (!rec.id || existingIds.has(rec.id)) continue;
      newEntries.push(rec);
      existingIds.add(rec.id);
      addedThisIndex++;
    }
    if (addedThisIndex === 0) continue; // no change
    // Deterministic sort: lex by id. `rebuildIndex` already produces
    // entries in walk-order, but the DAG pass adds them at the end,
    // and a future run's grouping may differ — lex-sort keeps the
    // on-disk order stable across runs.
    newEntries.sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
    parsed.data.entries = newEntries;
    atomicWriteFile(indexPath, renderFrontmatter(parsed.data, parsed.body));
    indicesTouched++;
    softEntriesAdded += addedThisIndex;
  }

  return { indicesTouched, softEntriesAdded };
}

// Build a minimal `entries[]` record for a leaf, matching the shape
// `indices.mjs::rebuildIndex` produces. The `file` field is
// recomputed per call site — see the call in `applySoftParentEntries`
// — because each soft parent index lives in a different directory
// and the relative link must anchor to THAT index's directory, not
// the leaf's own.
function buildEntryRecord(leaf, leafDir) {
  const record = {
    id: leaf.data.id,
    file: posixRelative(leafDir, leaf.path),
    type: leaf.data.type ?? "primary",
    focus: leaf.data.focus ?? "",
  };
  if (leaf.data.tags) record.tags = leaf.data.tags;
  if (leaf.data.overlay_targets) record.overlay_targets = leaf.data.overlay_targets;
  return record;
}

// Resolve a POSIX-relative `parents[]` entry like `"../b/index.md"`
// to an absolute filesystem path, anchored at the leaf's direct
// parent directory. Returns null for obviously malformed entries
// (absolute paths, entries that escape above wikiRoot, non-index.md
// endings). Defensive: malformed claims are skipped rather than
// crashing the phase — soft-dag synthesis is best-effort, and a
// bad parents[] entry typically indicates manual frontmatter edits
// that downstream validation will surface.
//
// Path-traversal guard: a crafted entry like
// "../../../../somewhere/index.md" must not let this phase read or
// write files outside the wiki tree. Resolve both the candidate path
// and the wiki root to canonical absolute form, then confirm the
// candidate sits under the wikiRoot prefix. Reject otherwise — this
// is a defense-in-depth check alongside validate's DUP-ID /
// ALIAS-COLLIDES-ID; a hostile leaf's parents[] shouldn't be able to
// mutate arbitrary filesystem paths even transiently.
//
// Two guards fire here:
//
//   1. Lexical guard on `resolve(leafDir, nativeRel)` prefix.
//      Rejects pure `..`-traversal that would escape the wikiRoot
//      prefix on disk without touching the filesystem.
//   2. Symlink-aware guard on `realpathSync`. `readFileSync` /
//      `writeFileSync` FOLLOW symlinks, so a symlinked index.md
//      inside the wiki pointing at an external file would bypass
//      guard (1) even though the lexical path sits inside the
//      wikiRoot prefix. `realpathSync` resolves the whole chain
//      (including intermediate symlinked directories); the
//      resolved target must still sit under the wikiRoot realpath
//      for the claim to be accepted. Only fires when the target
//      already exists — realpath throws ENOENT on a new index, and
//      the caller's `existsSync` branch below handles that case.
function normaliseIndexPath(leafDir, rel, wikiRoot) {
  if (typeof rel !== "string") return null;
  if (rel.length === 0) return null;
  // Reject absolute paths — parents[] is always relative.
  if (rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) return null;
  // Soft-parent convention: POSIX-style separators. Normalise to
  // OS-native for filesystem operations.
  const nativeRel = sep === "/" ? rel : rel.split("/").join(sep);
  const abs = resolve(leafDir, nativeRel);
  // Only index.md entries are valid parents.
  if (basename(abs) !== "index.md") return null;
  // Guard 1: lexical containment of the resolved path. Build the
  // prefix by concatenating `sep` only when `rootExact` doesn't
  // already end in one — avoids a degenerate `"//"` prefix when
  // `wikiRoot` is the filesystem root on POSIX (`"/"` → prefix
  // `"/"` not `"//"`).
  const rootExact = resolve(wikiRoot);
  const rootPrefix = rootExact.endsWith(sep) ? rootExact : rootExact + sep;
  if (abs !== rootExact && !abs.startsWith(rootPrefix)) return null;
  // Guard 2: symlink-aware containment. Only applies when the
  // target exists (realpath throws on ENOENT) — we'd otherwise
  // reject every brand-new target. Caller (`applySoftParentEntries`)
  // already runs an `existsSync(absIndex)` check before reading /
  // writing, so non-existent targets short-circuit that branch.
  if (existsSync(abs)) {
    try {
      // `realpathSync` resolves the full symlink chain, including
      // any intermediate symlinked directories. That's a stronger
      // containment check than `lstatSync(...).isSymbolicLink()`
      // alone would give us: we don't care whether the final
      // component itself is a symlink — we only care where the
      // filesystem operations would actually land, which is what
      // realpath reveals.
      const realAbs = realpathSync(abs);
      const realRoot = realpathSync(rootExact);
      const realRootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      if (realAbs !== realRoot && !realAbs.startsWith(realRootPrefix)) {
        return null;
      }
    } catch {
      return null; // realpath failure → reject defensively
    }
  }
  return abs;
}
