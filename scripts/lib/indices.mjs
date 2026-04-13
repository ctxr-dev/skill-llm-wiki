// index.md generation and parsing.
//
// For every directory in a wiki that contains entries, a single `index.md`
// holds:
//   - frontmatter with machine routing metadata (derived + authored fields)
//   - body with auto-generated navigation + preserved authored orientation
//
// The hook rebuilds indices by: reading the existing index.md to preserve
// authored fields, aggregating children's frontmatter to recompute derived
// fields, rendering a deterministic body, writing back atomically.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { WIKI_GENERATOR_MARKER } from "./paths.mjs";

const AUTO_BEGIN = "<!-- BEGIN AUTO-GENERATED NAVIGATION -->";
const AUTO_END = "<!-- END AUTO-GENERATED NAVIGATION -->";
const AUTHORED_BEGIN = "<!-- BEGIN AUTHORED ORIENTATION -->";
const AUTHORED_END = "<!-- END AUTHORED ORIENTATION -->";

// Fields that are auto-derived on every rebuild (overwritten).
const DERIVED_FIELDS = [
  "entries",
  "children",
  "depth",
  // shared_covers is auto-computed but may be hand-augmented; we union
  // computed + authored when present in the existing file.
];

// Fields the user or init routine authored that must survive rebuilds.
const AUTHORED_FIELDS = [
  "id",
  "type",
  "depth_role",
  "focus",
  "parents",
  "activation_defaults",
  "orientation",
  "rebuild_needed",
  "rebuild_reasons",
  "rebuild_command",
  "sources",
  "source_wikis",
  "tags",
  "domains",
  "generator",
];

export function readIndex(dirPath) {
  const p = join(dirPath, "index.md");
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return parseFrontmatter(raw, p);
}

// Walk a directory and return a list of child entries (leaves) and child
// index directories (subcategories). Leaves are any .md file that is not
// the directory's own index.md and has frontmatter.
export function listChildren(dirPath) {
  const out = { leaves: [], subdirs: [] };
  if (!existsSync(dirPath)) return out;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dirPath, e.name);
    if (e.isDirectory()) {
      if (existsSync(join(full, "index.md"))) out.subdirs.push(full);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "index.md") continue;
    try {
      const raw = readFileSync(full, "utf8");
      const { data } = parseFrontmatter(raw, full);
      if (data && typeof data === "object" && data.id) {
        out.leaves.push({ path: full, data });
      }
    } catch {
      // Skip malformed
    }
  }
  return out;
}

// Rebuild the index.md for a single directory. Idempotent. Never modifies
// children. Preserves authored content in the existing index.md.
//
// depth is computed from the directory's position relative to the wiki root.
export function rebuildIndex(dirPath, wikiRoot) {
  const p = join(dirPath, "index.md");
  const existing = existsSync(p) ? parseFrontmatter(readFileSync(p, "utf8"), p) : null;
  const { leaves, subdirs } = listChildren(dirPath);

  const depth = computeDepth(dirPath, wikiRoot);
  const isRoot = dirPath === wikiRoot;

  // Start with existing authored fields.
  const data = {};
  if (existing?.data) {
    for (const k of AUTHORED_FIELDS) {
      if (existing.data[k] !== undefined) data[k] = existing.data[k];
    }
  }

  // Ensure required identity fields.
  data.id = data.id ?? (isRoot ? basename(wikiRoot) : basename(dirPath));
  data.type = "index";
  data.depth_role = depth === 0 ? "category" : depth === 1 ? "category" : "subcategory";
  if (isRoot) data.depth_role = "category";
  data.depth = depth;

  if (!data.focus) {
    data.focus = `subtree under ${data.id}`;
  }

  if (!data.parents) {
    if (isRoot) {
      data.parents = [];
    } else {
      data.parents = [relative(dirPath, dirname(dirPath)) + "/index.md"];
    }
  }

  // Derived: entries (aggregate child frontmatter)
  const entries = [];
  for (const leaf of leaves) {
    entries.push({
      id: leaf.data.id,
      file: relative(dirPath, leaf.path),
      type: leaf.data.type ?? "primary",
      focus: leaf.data.focus ?? "",
    });
  }
  for (const sub of subdirs) {
    const subIndex = readIndex(sub);
    if (!subIndex) continue;
    entries.push({
      id: subIndex.data.id,
      file: relative(dirPath, join(sub, "index.md")),
      type: "index",
      focus: subIndex.data.focus ?? "",
    });
  }
  data.entries = entries;

  // Derived: children (subdirectory index pointers)
  data.children = subdirs.map((s) => relative(dirPath, join(s, "index.md")));

  // Derived: shared_covers — intersection of leaf covers when present.
  // (Subcategory intersections are handled when their own indices rebuild.)
  const computedShared = intersectCovers(leaves.map((l) => l.data.covers ?? []));
  const authoredShared = existing?.data?.shared_covers ?? [];
  data.shared_covers = uniqueJoin(computedShared, authoredShared);

  // Root gets the rebuild-surfacing fields and the generator marker.
  // The marker is what the hook uses to positively identify this folder
  // as a skill-llm-wiki-managed wiki (see paths.mjs::isWikiRoot). Without
  // the marker, the hook treats the folder as unrelated and stays silent.
  if (isRoot) {
    if (data.rebuild_needed === undefined) data.rebuild_needed = false;
    if (!data.rebuild_reasons) data.rebuild_reasons = [];
    if (!data.rebuild_command) {
      data.rebuild_command = `skill-llm-wiki rebuild ${wikiRoot} --plan`;
    }
    data.generator = WIKI_GENERATOR_MARKER;
  }

  // Deterministic key order
  const ordered = orderKeys(data, isRoot);
  const body = renderBody(ordered, leaves, subdirs, existing);
  atomicWriteFile(p, renderFrontmatter(ordered, body));
  return { path: p, entries: entries.length, children: subdirs.length };
}

export function rebuildAllIndices(wikiRoot) {
  // Rebuild bottom-up so parent `shared_covers[]` computations see fresh
  // child frontmatter.
  const dirs = [];
  collectDirs(wikiRoot, dirs);
  // Sort by depth descending so deepest directories rebuild first.
  dirs.sort((a, b) => depthOf(b, wikiRoot) - depthOf(a, wikiRoot));
  const out = [];
  for (const d of dirs) {
    out.push(rebuildIndex(d, wikiRoot));
  }
  return out;
}

function collectDirs(dirPath, acc) {
  if (!existsSync(dirPath)) return;
  try {
    const { leaves, subdirs } = listChildren(dirPath);
    // Only include dirs that have at least one leaf or subdir with an index.
    if (leaves.length > 0 || subdirs.length > 0 || dirPath === acc[0]) {
      acc.push(dirPath);
    }
    for (const s of subdirs) collectDirs(s, acc);
  } catch {
    /* skip */
  }
}

function depthOf(dirPath, wikiRoot) {
  if (dirPath === wikiRoot) return 0;
  return relative(wikiRoot, dirPath).split("/").filter(Boolean).length;
}

function computeDepth(dirPath, wikiRoot) {
  return depthOf(dirPath, wikiRoot);
}

function intersectCovers(lists) {
  if (lists.length === 0) return [];
  if (lists.length === 1) return [];
  const first = new Set(lists[0]);
  const out = [];
  for (const item of lists[0]) {
    if (lists.every((l) => l.includes(item))) out.push(item);
  }
  return out;
}

function uniqueJoin(a, b) {
  const seen = new Set();
  const out = [];
  for (const item of [...a, ...b]) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function orderKeys(data, isRoot) {
  // Canonical ordering for deterministic output.
  const baseOrder = [
    "id",
    "type",
    "depth_role",
    "depth",
    "focus",
    "parents",
    "tags",
    "domains",
    "activation_defaults",
    "shared_covers",
    "sources",
    "source_wikis",
    "orientation",
    "generator",
    "rebuild_needed",
    "rebuild_reasons",
    "rebuild_command",
    "entries",
    "children",
  ];
  const out = {};
  for (const k of baseOrder) {
    if (data[k] !== undefined) out[k] = data[k];
  }
  // Any extra keys appended at the end preserve author additions.
  for (const k of Object.keys(data)) {
    if (!(k in out)) out[k] = data[k];
  }
  if (!isRoot) {
    delete out.rebuild_needed;
    delete out.rebuild_reasons;
    delete out.rebuild_command;
  }
  return out;
}

function renderBody(data, leaves, subdirs, existing) {
  const lines = [];
  lines.push("");
  lines.push(AUTO_BEGIN);
  lines.push("");
  lines.push(`# ${titleize(data.id)}`);
  lines.push("");
  if (data.focus) {
    lines.push(`**Focus:** ${data.focus}`);
    lines.push("");
  }
  if (data.shared_covers && data.shared_covers.length > 0) {
    lines.push("**Shared across all children:**");
    lines.push("");
    for (const c of data.shared_covers) lines.push(`- ${c}`);
    lines.push("");
  }
  if (data.entries && data.entries.length > 0) {
    lines.push("## Children");
    lines.push("");
    lines.push("| File | Type | Focus |");
    lines.push("|------|------|-------|");
    for (const e of data.entries) {
      const typeTag = e.type === "index" ? "📁 index" : e.type === "overlay" ? "🔗 overlay" : "📄 primary";
      lines.push(`| [${e.file}](${e.file}) | ${typeTag} | ${e.focus || ""} |`);
    }
    lines.push("");
  } else {
    lines.push("_No children yet._");
    lines.push("");
  }
  lines.push(AUTO_END);
  lines.push("");

  // Preserve authored orientation block if present in existing body.
  const authored = extractAuthoredBlock(existing?.body ?? "");
  lines.push(AUTHORED_BEGIN);
  if (authored) {
    lines.push(authored);
  } else if (data.orientation) {
    lines.push(data.orientation);
  }
  lines.push(AUTHORED_END);
  lines.push("");

  return lines.join("\n");
}

function extractAuthoredBlock(body) {
  const start = body.indexOf(AUTHORED_BEGIN);
  const end = body.indexOf(AUTHORED_END);
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start + AUTHORED_BEGIN.length, end).trim();
}

function titleize(id) {
  return id
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function atomicWriteFile(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = targetPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, targetPath);
}
