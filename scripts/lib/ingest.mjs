// Ingest phase: walk a source tree, compute content hashes, emit entry
// candidates. Deterministic ordering (paths sorted), deterministic id
// generation (kebab-case of filename with collision suffixes).
//
// Source-side frontmatter parsing is delegated to `gray-matter` (via
// `./source-frontmatter.mjs`), the de-facto-standard YAML frontmatter
// library. The skill's own output serialisation still flows through
// `frontmatter.mjs`, but any time we read a source file that may
// already carry frontmatter we use gray-matter so that:
//   - every authored field (activation / covers / focus / tags / etc.)
//     is parsed accurately and preserved through the pipeline;
//   - the source's frontmatter block is stripped from the body exactly
//     once, so the orchestrator does not double-stack a fresh fence on
//     top of the authored one.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { parseSourceFrontmatter } from "./source-frontmatter.mjs";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

const TEXT_EXTS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".org",
  ".adoc",
  ".markdown",
]);

const CODE_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".zsh",
  ".bash",
]);

export function ingestSource(sourcePath, options = {}) {
  const { includeCode = false } = options;
  const files = walk(sourcePath, SKIP_DIRS);
  files.sort();
  const leaves = [];
  const indexSources = [];
  const usedIds = new Map();
  for (const abs of files) {
    const ext = extname(abs).toLowerCase();
    const isText = TEXT_EXTS.has(ext);
    const isCode = CODE_EXTS.has(ext);
    if (!isText && !(includeCode && isCode)) continue;
    const rel = relative(sourcePath, abs);
    const raw = readFileSync(abs, "utf8");
    const hash = sha256(raw);

    // Parse the source's own frontmatter (if any) up-front. `body` is
    // the source content MINUS its frontmatter fence — this is the
    // content the orchestrator later concatenates a fresh drafted
    // frontmatter on top of. Parsing once at ingest also lets the
    // drafter pick up authored fields (activation / covers / tags /
    // focus / etc.) and the index-source detector see `type: index`.
    const parsed = parseSourceFrontmatter(raw);
    const authored = parsed.data || {};
    const body = parsed.body ?? raw;

    // Index-source detection: a source file is an index input when
    // either (a) it is literally named `index.md` OR (b) its
    // frontmatter declares `type: index`. These feed into the
    // synthesised target index (shared_covers / orientation /
    // activation_defaults forwarding), not into the leaf write path.
    const baseName = basename(abs).toLowerCase();
    const isIndexSource =
      baseName === "index.md" || authored.type === "index";

    // `title` / `lead` / `headings` are only needed for the leaf draft
    // heuristics (used when authored fields are absent). For index
    // inputs we still compute them cheaply — the extra work is
    // negligible and keeps the shape uniform for callers.
    const candidate = {
      source_path: rel,
      absolute_path: abs,
      ext,
      size: raw.length,
      hash,
      kind: isText ? "prose" : "code",
      title: extractTitle(body || raw, rel),
      lead: extractLead(body || raw),
      headings: extractHeadings(body || raw),
      // Populated for downstream: authored frontmatter + stripped body.
      authored_frontmatter: authored,
      has_authored_frontmatter: parsed.hasFrontmatter === true,
      body,
    };

    if (isIndexSource) {
      // Directory this index governs, relative to the source root. For
      // `index.md` at the root this is `""`. For `operations/index.md`
      // it is `"operations"`. Used by `indices.mjs` to look up which
      // synthesised target index should receive the authored hints.
      candidate.dir = dirnameRel(rel);
      indexSources.push(candidate);
      continue;
    }

    const baseId = deriveId(rel);
    const id = disambiguateId(baseId, usedIds);
    usedIds.set(id, (usedIds.get(id) ?? 0) + 1);
    candidate.id = id;
    leaves.push(candidate);
  }
  return { leaves, indexSources, candidates: leaves };
}

function dirnameRel(relPath) {
  const parts = relPath.split(/[\/\\]/);
  parts.pop();
  return parts.join("/");
}

export function sha256(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function walk(root, skipDirs) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".well-known") continue;
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

function deriveId(relPath) {
  // The id is the plain filename (no directory prefixes). This keeps
  // the leaf on disk at `operations/build.md` with id `build`, which
  // is what the validator's ID-MISMATCH-FILE check enforces
  // (`data.id === basename(file, ".md")`). Global uniqueness is still
  // guaranteed because `disambiguateId` appends `-2`, `-3`, … on
  // collision — the trade-off is deliberate: a flat id is worth a
  // little awkwardness on the (rare) cross-directory collision case.
  const base = basename(relPath, extname(relPath));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) return "untitled";
  // "index" is reserved for directory/category index files. A source
  // leaf whose derived id is "index" would be written to
  // `<category>/index.md` and collide with the bootstrap-generated
  // category index stub. Rename to "overview" so the source content is
  // preserved as a regular leaf under the category — disambiguateId
  // handles any further collision with a sibling already named overview.
  if (slug === "index") return "overview";
  return slug;
}

function disambiguateId(baseId, usedIds) {
  if (!usedIds.has(baseId)) return baseId;
  let n = 2;
  while (usedIds.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

function extractTitle(raw, fallbackPath) {
  const m = raw.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  return basename(fallbackPath, extname(fallbackPath));
}

function extractLead(raw) {
  // First non-heading paragraph after the title.
  const lines = raw.split("\n");
  let inCode = false;
  const paragraph = [];
  let seenTitle = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^#{1,6}\s+/.test(line)) {
      if (!seenTitle) {
        seenTitle = true;
        continue;
      }
      if (paragraph.length > 0) break;
      continue;
    }
    if (line.trim() === "") {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.trim());
    if (paragraph.length >= 6) break;
  }
  return paragraph.join(" ").slice(0, 400);
}

function extractHeadings(raw) {
  const out = [];
  const re = /^(#{1,6})\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push({ level: m[1].length, text: m[2].trim() });
  }
  return out;
}
