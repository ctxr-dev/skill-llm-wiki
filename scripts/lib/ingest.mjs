// Ingest phase: walk a source tree, compute content hashes, emit entry
// candidates. Deterministic ordering (paths sorted), deterministic id
// generation (kebab-case of filename with collision suffixes).

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

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
  const candidates = [];
  const usedIds = new Map();
  for (const abs of files) {
    const ext = extname(abs).toLowerCase();
    const isText = TEXT_EXTS.has(ext);
    const isCode = CODE_EXTS.has(ext);
    if (!isText && !(includeCode && isCode)) continue;
    const rel = relative(sourcePath, abs);
    const raw = readFileSync(abs, "utf8");
    const hash = sha256(raw);
    const baseId = deriveId(rel);
    const id = disambiguateId(baseId, usedIds);
    usedIds.set(id, (usedIds.get(id) ?? 0) + 1);
    candidates.push({
      id,
      source_path: rel,
      absolute_path: abs,
      ext,
      size: raw.length,
      hash,
      kind: isText ? "prose" : "code",
      title: extractTitle(raw, rel),
      lead: extractLead(raw),
      headings: extractHeadings(raw),
    });
  }
  return candidates;
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
  const noExt = relPath.slice(0, relPath.length - extname(relPath).length);
  const slug = noExt
    .split(sep)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "untitled";
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
