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
// Anything that needs semantic understanding (prose-heavy draft, ambiguous
// classification, cover synthesis from narrative) is left for Claude to
// handle inside its own execution context when running this skill. The
// `needs_ai` flag on the returned draft tells the caller which entries
// need AI review.

export function draftLeafFrontmatter(candidate, { categoryPath } = {}) {
  const covers = extractCovers(candidate);
  const focus = candidate.title || candidate.id;
  const data = {
    id: candidate.id,
    type: "primary",
    depth_role: "leaf",
    focus,
    covers,
    parents: categoryPath ? [`${categoryPath}/index.md`] : [],
    tags: inferTags(candidate),
    source: {
      origin: "file",
      path: candidate.source_path,
      hash: candidate.hash,
    },
  };
  const confidence = scoreConfidence(data, candidate);
  return { data, confidence, needs_ai: confidence < 0.6 };
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
export function draftCategory(candidate) {
  const parts = candidate.source_path.split(/[\/\\]/);
  if (parts.length === 1) return "general";
  return parts[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
