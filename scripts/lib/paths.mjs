// Sibling-versioned output directory conventions.
//
// For any user source `./docs`, a wiki lives at `./docs.llmwiki.v<N>/` and
// the current version is tracked via a plaintext file `./docs.llmwiki.current`
// containing a single line `v<N>`. Rollback is `echo v2 > docs.llmwiki.current`.
//
// Every operation that produces structural change writes a new vN+1 and then
// atomically flips the current pointer on successful commit. The previous
// version stays on disk until the user explicitly prunes.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const VERSION_RE = /^v(\d+)$/;

// Marker written into the root index.md frontmatter by this skill. The hook
// will ONLY react on directories whose root index carries this marker —
// folders that merely happen to match the `*.llmwiki.vN` naming pattern are
// ignored. Bump the version suffix (v1 → v2) when the wiki format changes
// in a way that would confuse older hook code.
export const WIKI_GENERATOR_MARKER = "skill-llm-wiki/v1";

export function wikiBaseName(sourcePath) {
  return basename(resolve(sourcePath));
}

export function siblingRoot(sourcePath) {
  return dirname(resolve(sourcePath));
}

export function currentPointerPath(sourcePath) {
  const base = wikiBaseName(sourcePath);
  return join(siblingRoot(sourcePath), `${base}.llmwiki.current`);
}

export function versionDir(sourcePath, version) {
  const base = wikiBaseName(sourcePath);
  const tag = typeof version === "number" ? `v${version}` : version;
  return join(siblingRoot(sourcePath), `${base}.llmwiki.${tag}`);
}

// Return all existing `<base>.llmwiki.v<N>` directories sorted ascending by N.
export function listVersions(sourcePath) {
  const base = wikiBaseName(sourcePath);
  const parent = siblingRoot(sourcePath);
  if (!existsSync(parent)) return [];
  const prefix = `${base}.llmwiki.`;
  const out = [];
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const tag = name.slice(prefix.length);
    const m = VERSION_RE.exec(tag);
    if (!m) continue;
    const full = join(parent, name);
    try {
      if (statSync(full).isDirectory()) {
        out.push({ version: Number(m[1]), tag, path: full });
      }
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

export function readCurrentPointer(sourcePath) {
  const p = currentPointerPath(sourcePath);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return { tag: raw, version: Number(m[1]), path: versionDir(sourcePath, raw) };
}

export function writeCurrentPointer(sourcePath, versionTag) {
  const p = currentPointerPath(sourcePath);
  writeFileSync(p, `${versionTag}\n`, "utf8");
}

// Resolve the "live" wiki for a source, preferring the current-pointer,
// falling back to the highest existing version, or null if none exist.
export function resolveLiveWiki(sourcePath) {
  const pointer = readCurrentPointer(sourcePath);
  if (pointer && existsSync(pointer.path)) return pointer;
  const versions = listVersions(sourcePath);
  if (versions.length === 0) return null;
  const latest = versions[versions.length - 1];
  return { tag: latest.tag, version: latest.version, path: latest.path };
}

export function nextVersionTag(sourcePath) {
  const versions = listVersions(sourcePath);
  const next = versions.length === 0 ? 1 : versions[versions.length - 1].version + 1;
  return `v${next}`;
}

export function workDir(wikiPath) {
  return join(wikiPath, ".work");
}

export function shapeDir(wikiPath) {
  return join(wikiPath, ".shape");
}

// A directory is a wiki root iff:
//   (a) it contains an `index.md`
//   (b) that `index.md`'s frontmatter declares `generator: skill-llm-wiki/v<N>`
//   (c) AND EITHER:
//       - its name matches `*.llmwiki.v<N>` (classic sibling-versioned mode), OR
//       - it has a `.llmwiki.layout.yaml` file at its root (hosted mode)
//
// The generator marker (b) is the core safety check — it positively
// identifies a directory the skill itself built. Name matching (c-left)
// handles free-mode sibling outputs like `./docs.llmwiki.v1/`. Layout
// contract presence (c-right) handles hosted-mode targets with arbitrary
// names like `./memory/` or `./docs-wiki/` where the user (or another
// skill) has declared a contract to govern the directory structure in
// place. Both paths require the marker — that's non-negotiable.
//
// This means the first Build of a wiki MUST write `generator:` into the
// root frontmatter; `indices.rebuildIndex` does that when it detects the
// directory is a wiki root.
export function isWikiRoot(dirPath) {
  const indexMd = join(dirPath, "index.md");
  if (!existsSync(indexMd)) return false;

  const base = basename(dirPath);
  const hasVersionedName = /\.llmwiki\.v\d+$/.test(base);
  const hasLayoutContract = existsSync(join(dirPath, ".llmwiki.layout.yaml"));

  // Must satisfy at least one structural recognition rule.
  if (!hasVersionedName && !hasLayoutContract) return false;

  // Frontmatter probe: cheap, bounded, no YAML parse required for the
  // marker check — we just look for the line within the fence.
  try {
    const raw = readFileSync(indexMd, "utf8");
    return hasGeneratorMarker(raw);
  } catch {
    return false;
  }
}

function hasGeneratorMarker(raw) {
  if (!raw.startsWith("---\n")) return false;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return false;
  const fm = raw.slice(4, end);
  // Accept `generator: skill-llm-wiki/v1` with or without quotes.
  return /^\s*generator:\s*['"]?skill-llm-wiki\/v\d+['"]?\s*$/m.test(fm);
}

// Walk upward from `startPath` to find the nearest wiki root. Returns the
// absolute path to the wiki root, or null if the starting path is not
// inside a skill-managed wiki.
export function findEnclosingWiki(startPath) {
  let cur = resolve(startPath);
  while (true) {
    if (isWikiRoot(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
