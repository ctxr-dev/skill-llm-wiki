// Draft frontmatter: deterministic extraction only.
//
// This is the script-side of the script-first + AI-fallback pipeline
// documented in methodology §9.6. It handles the "structured source" case
// where frontmatter can be derived mechanically from file metadata:
//   - id from filename
//   - focus from title or lead paragraph
//   - covers[] from H2 sections or bulleted items in the lead
//   - tags[] from filename prefixes or directory hints
//   - activation from file_glob inferred from the source path
//
// When the source file ALREADY carries a frontmatter block (parsed at
// ingest time via gray-matter and stashed as
// `candidate.authored_frontmatter`), each AUTHORED_LEAF_FIELD is
// preferred over the heuristic — the drafter only fills gaps. This is
// what preserves `activation`, `covers`, `tags`, `focus`, `domains`,
// `shared_covers`, `aliases`, and friends when a hand-tuned corpus is
// re-built.
//
// Anything that needs semantic understanding (prose-heavy draft, ambiguous
// classification, cover synthesis from narrative) is left for Claude to
// handle inside its own execution context when running this skill. The
// `needs_ai` flag on the returned draft tells the caller which entries
// need AI review.

// Fields whose authoritative source is the target-tree position (not
// the original source file). These are ALWAYS re-derived during a
// rebuild regardless of what the author wrote: `id` comes from the
// filename / target slot, `type` defaults to "primary" (overlays must
// be re-asserted explicitly via the rebuild's overlay path),
// `depth_role` is always "leaf" for non-index leaves, and `source` is
// recomputed from the build invocation.
//
// `parents` is NOT in this set — it's a hand-authored field (the
// comment in the data object below describes the convention) and the
// drafter pickAuthored()s it. Including it here would silently drop
// authored parents and break the soft-DAG.
//
// EVERY OTHER authored field flows through verbatim. This is a
// deny-list, not an allow-list (issue #26): consumers ship their own
// schemas (e.g. skill-code-review's `dimensions`, `audit_surface`,
// `languages`, `tools`) and a generic wiki framework should preserve
// what the author wrote rather than enumerating per-consumer fields.
const RESERVED_LEAF_FIELDS = new Set([
  "id",
  "type",
  "depth_role",
  "source",
]);

// Fields the drafter computes a heuristic baseline for and writes
// explicitly in the canonical data object below. Authored values for
// these win over the heuristic via pickAuthored(); they're listed here
// only so the pass-through loop knows to skip them (they're already in
// the data object — re-forwarding would be a no-op but with the wrong
// authored-vs-heuristic precedence).
const EXPLICITLY_HANDLED_LEAF_FIELDS = new Set([
  "focus",
  "covers",
  "tags",
  "parents",
]);

export function draftLeafFrontmatter(candidate, { categoryPath } = {}) {
  const authored = candidate.authored_frontmatter || {};
  const hasAuthored = candidate.has_authored_frontmatter === true;

  // Heuristic baseline — used when the author didn't supply a field.
  const draftedCovers = extractCovers(candidate);
  const draftedFocus = candidate.title || candidate.id;
  const draftedTags = inferTags(candidate);

  const data = {
    id: candidate.id,
    type: "primary",
    depth_role: "leaf",
    // Priority: authored > drafted > default. `pickAuthored` only
    // returns the authored value when it is non-empty (non-null,
    // non-undefined, and — for arrays — non-empty).
    focus: pickAuthored(authored.focus, draftedFocus),
    covers: pickAuthored(authored.covers, draftedCovers),
    // `parents` is authoritative from the source when supplied. The
    // hand-authored convention is a list of index.md paths relative
    // to the leaf's own directory (`index.md` for the same dir,
    // `../index.md` for one up). Heuristic fallback builds the same
    // relative form from the category path.
    parents: pickAuthored(authored.parents, ["index.md"]),
    tags: pickAuthored(authored.tags, draftedTags),
    source: {
      origin: "file",
      path: candidate.source_path,
      hash: candidate.hash,
    },
  };

  // Forward EVERY authored field that isn't reserved (re-derived from
  // target-tree position) or explicitly handled above (focus / covers
  // / tags, where authored-wins-over-drafted is enforced via
  // pickAuthored). Issue #26: the previous allow-list dropped any
  // consumer-specific v2 field (dimensions, audit_surface, languages,
  // tools, …) authored at the source; the deny-list now preserves
  // arbitrary author-shipped frontmatter byte-equivalent.
  if (hasAuthored) {
    for (const [field, value] of Object.entries(authored)) {
      if (RESERVED_LEAF_FIELDS.has(field)) continue;
      if (EXPLICITLY_HANDLED_LEAF_FIELDS.has(field)) continue;
      if (value === undefined || value === null) continue;
      // Empty arrays / empty strings DO get forwarded — distinguishing
      // "author wrote []" from "author omitted" matters for some
      // consumer schemas (e.g. an explicit empty file_globs[] means
      // "this leaf opts out of glob-based activation"). Only the
      // null/undefined case is treated as "author omitted".
      data[field] = value;
    }
  }

  const confidence = scoreConfidence(data, candidate);
  return { data, confidence, needs_ai: confidence < 0.6 };
}

function pickAuthored(authoredVal, fallback) {
  if (authoredVal === undefined || authoredVal === null) return fallback;
  if (Array.isArray(authoredVal)) {
    return authoredVal.length > 0 ? authoredVal : fallback;
  }
  if (typeof authoredVal === "string") {
    return authoredVal.trim() !== "" ? authoredVal : fallback;
  }
  return authoredVal;
}

function extractCovers(candidate) {
  const out = [];
  // H2 headings become the primary covers candidates.
  for (const h of candidate.headings) {
    if (h.level === 2) out.push(h.text);
    if (out.length >= 10) break;
  }
  if (out.length === 0) {
    // Fall back to splitting the lead on sentence boundaries.
    const lead = candidate.lead || "";
    const sentences = lead.split(/(?<=[.!?])\s+/).filter((s) => s.length > 10);
    for (const s of sentences) {
      out.push(s.slice(0, 120));
      if (out.length >= 5) break;
    }
  }
  return out.slice(0, 12);
}

function inferTags(candidate) {
  const tags = new Set();
  // Directory components as tag hints.
  const parts = candidate.source_path.split(/[\/\\]/);
  for (const part of parts.slice(0, -1)) {
    if (part && part !== "." && !/^\d+$/.test(part)) {
      tags.add(part.toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
    }
  }
  // Extension hint.
  if (candidate.ext === ".md") tags.add("markdown");
  return [...tags].slice(0, 8);
}

function scoreConfidence(draft, candidate) {
  let score = 0;
  if (draft.focus && draft.focus !== candidate.id) score += 0.3;
  if (draft.covers.length >= 3) score += 0.4;
  else if (draft.covers.length >= 1) score += 0.2;
  if (candidate.headings.filter((h) => h.level === 2).length >= 2) score += 0.2;
  if (candidate.size > 200) score += 0.1;
  return Math.min(1, score);
}

// Quick classification by directory prefix. Script-first classifier.
//
// When the source file lives at the source root (no directory
// component), the candidate is placed at the TARGET root — not under a
// synthetic `general/` bucket. This is what keeps a flat authored
// guide flat in the output: 17 top-level leaves stay at the wiki root
// instead of being nested under `general/`.
//
// Subdirectories in the source are preserved as top-level categories
// in the target (e.g. `operations/build.md` → `operations/build.md`).
export function draftCategory(candidate) {
  const parts = candidate.source_path.split(/[\/\\]/).filter(Boolean);
  if (parts.length <= 1) return "";
  return parts[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
