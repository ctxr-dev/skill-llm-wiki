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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { WIKI_GENERATOR_MARKER } from "./paths.mjs";
import { readFrontmatterStreaming } from "./chunk.mjs";

const AUTO_BEGIN = "<!-- BEGIN AUTO-GENERATED NAVIGATION -->";
const AUTO_END = "<!-- END AUTO-GENERATED NAVIGATION -->";
const AUTHORED_BEGIN = "<!-- BEGIN AUTHORED ORIENTATION -->";
const AUTHORED_END = "<!-- END AUTHORED ORIENTATION -->";

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
  // Hosted-mode markers — set on the root index when the wiki is governed
  // by a layout contract. Must survive rebuilds so `isWikiRoot` and the
  // hosted-mode operation paths keep recognising the target after every
  // regeneration.
  "mode",
  "layout_contract_path",
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
//
// Scale note: this function reads ONLY each leaf's frontmatter bytes via
// `readFrontmatterStreaming`. It never pulls the body into memory, so a
// directory with 10,000 × 50 KB leaves costs ~40 MB of frontmatter (at
// the 4 KB-per-leaf typical case) instead of 500 MB of full files. This
// is what makes `rebuildAllIndices` scalable at Phase 5 targets.
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
      const captured = readFrontmatterStreaming(full);
      if (captured === null) continue; // no frontmatter — skip silently
      const { data } = parseFrontmatter(captured.frontmatterText, full);
      if (data && typeof data === "object" && data.id) {
        out.leaves.push({ path: full, data });
      }
    } catch {
      // Skip malformed — `runShapeCheck` / `rebuildIndex` both tolerate
      // leaves whose frontmatter fails to parse. The strict validator
      // catches them separately.
    }
  }
  return out;
}

// Rebuild the index.md for a single directory. Idempotent. Never modifies
// children. Preserves authored content in the existing index.md.
//
// depth is computed from the directory's position relative to the wiki
// root. If `preloadedChildren` is provided it is used instead of calling
// `listChildren` again — `rebuildAllIndices` takes advantage of this to
// avoid reading every leaf's frontmatter twice per rebuild (once during
// the walk that discovers directories, once during per-directory index
// regeneration). At 10k leaves the savings are meaningful.
//
// `options.indexInput`, when provided, carries the AUTHORED-index
// hints (shared_covers / orientation / focus) that the ingest phase
// recovered from a source file named `index.md` or carrying
// `type: index`. Those fields are forwarded into the synthesised
// target index verbatim — they take priority over the heuristic
// fallbacks, so a hand-tuned guide's routing metadata survives a
// rebuild cleanly.
//
// NOTE on `activation_defaults`: this field is no longer
// auto-aggregated upward from members (that was the old literal-
// routing substrate). The field is still recognised in
// AUTHORED_FIELDS so a hand-authored source index that carries an
// `activation_defaults` block round-trips without data loss, but
// the rebuild pass does NOT synthesise one from child signals.
// Routing is semantic — see SKILL.md "Routing into guide.wiki/".
export function rebuildIndex(
  dirPath,
  wikiRoot,
  preloadedChildren = null,
  options = {},
) {
  const { indexInput = null } = options;
  const p = join(dirPath, "index.md");
  const existing = existsSync(p) ? parseFrontmatter(readFileSync(p, "utf8"), p) : null;
  const { leaves, subdirs } = preloadedChildren ?? listChildren(dirPath);

  const depth = computeDepth(dirPath, wikiRoot);
  const isRoot = dirPath === wikiRoot;

  // Start with existing authored fields (survive rebuild).
  const data = {};
  if (existing?.data) {
    for (const k of AUTHORED_FIELDS) {
      if (existing.data[k] !== undefined) data[k] = existing.data[k];
    }
  }

  // Forward hints from an authored source `index.md` (if the build
  // pipeline stashed one for this directory). These take priority
  // over any stub values planted by `bootstrapIndexStubs`, EXCEPT
  // for identity fields whose correct value is structurally
  // determined by the target-tree position (`id`, `type`,
  // `depth_role`, `depth`, `parents`). Those get re-derived below.
  const authoredIndex = indexInput?.authored_frontmatter || null;
  const structuralFields = new Set([
    "id",
    "type",
    "depth_role",
    "depth",
    "parents",
    "generator",
    "mode",
    "layout_contract_path",
    // Rebuild-status fields are managed by the orchestrator / rebuild
    // path. Forwarding them from a source index would leak absolute
    // paths into the target and defeat build determinism.
    "rebuild_needed",
    "rebuild_reasons",
    "rebuild_command",
  ]);
  if (authoredIndex) {
    for (const k of AUTHORED_FIELDS) {
      if (structuralFields.has(k)) continue;
      if (authoredIndex[k] !== undefined) data[k] = authoredIndex[k];
    }
  }

  // Ensure required identity fields.
  data.id = data.id ?? (isRoot ? basename(wikiRoot) : basename(dirPath));
  data.type = "index";
  // Depth-role mapping per schema: root is "category", everything deeper is
  // "subcategory". (Early drafts mislabeled depth-1 as "category"; fixed.)
  data.depth_role = depth === 0 ? "category" : "subcategory";
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

  // Derived: entries (aggregate child frontmatter).
  //
  // Each entry carries the minimum a semantic router needs to decide
  // whether to descend into or load the child: `id`, `file`, `type`,
  // `focus`, and any authored `tags`. Claude reads the parent's
  // `entries[]`, matches on `focus` (and the parent's authored
  // `shared_covers`), and loads only the matches. It does NOT match
  // on literal keyword/tag lists lifted from the child — that was
  // the old deterministic-router substrate and is gone. Per-leaf
  // `activation` blocks are still preserved IN the leaf file as
  // optional semantic hints the router may consult AFTER opening
  // the leaf; they are not copied up into the parent entries[]
  // record.
  const entries = [];
  for (const leaf of leaves) {
    const record = {
      id: leaf.data.id,
      file: relative(dirPath, leaf.path),
      type: leaf.data.type ?? "primary",
      focus: leaf.data.focus ?? "",
    };
    if (leaf.data.tags) record.tags = leaf.data.tags;
    if (leaf.data.overlay_targets) record.overlay_targets = leaf.data.overlay_targets;
    entries.push(record);
  }
  for (const sub of subdirs) {
    const subIndex = readIndex(sub);
    if (!subIndex) continue;
    const record = {
      id: subIndex.data.id,
      file: relative(dirPath, join(sub, "index.md")),
      type: "index",
      focus: subIndex.data.focus ?? "",
    };
    if (subIndex.data.tags) record.tags = subIndex.data.tags;
    entries.push(record);
  }
  data.entries = entries;

  // Semantic-routing substrate: `activation_defaults` is NOT
  // auto-aggregated anymore. Claude decides descent from `focus`
  // and `shared_covers` semantically. If the user hand-authored an
  // `activation_defaults` block (forwarded via AUTHORED_FIELDS or
  // via indexInput), it survives here as a free-form authored hint
  // but we no longer synthesise or merge one from child signals.
  // See the doc comment on `rebuildIndex` above.

  // Derived: children (subdirectory index pointers)
  data.children = subdirs.map((s) => relative(dirPath, join(s, "index.md")));

  // Derived: shared_covers — intersection of leaf covers when present.
  // Also unioned with any authored shared_covers the user put in the
  // existing index.md AND any shared_covers forwarded from an
  // authored source index input. (Subcategory intersections are
  // handled when their own indices rebuild.)
  const computedShared = intersectCovers(leaves.map((l) => l.data.covers ?? []));
  const authoredShared = existing?.data?.shared_covers ?? [];
  const sourceShared =
    authoredIndex && Array.isArray(authoredIndex.shared_covers)
      ? authoredIndex.shared_covers
      : [];
  data.shared_covers = uniqueJoin(
    uniqueJoin(computedShared, authoredShared),
    sourceShared,
  );

  // Root gets the rebuild-surfacing fields and the generator marker.
  // The marker is what the hook uses to positively identify this folder
  // as a skill-llm-wiki-managed wiki (see paths.mjs::isWikiRoot). Without
  // the marker, the hook treats the folder as unrelated and stays silent.
  if (isRoot) {
    if (data.rebuild_needed === undefined) data.rebuild_needed = false;
    if (!data.rebuild_reasons) data.rebuild_reasons = [];
    // The rebuild_command field uses a placeholder path instead of
    // the absolute wikiRoot so that byte-identical wiki content
    // produces a byte-identical tracked file across machines and
    // install locations. The user substitutes the placeholder with
    // their actual wiki path when they run the command. This is the
    // determinism fix from the Phase 8 sweep finding that two
    // identical builds into different tmp dirs were producing
    // different HEAD tree SHAs.
    if (!data.rebuild_command) {
      data.rebuild_command = "skill-llm-wiki rebuild <wiki> --plan";
    }
    data.generator = WIKI_GENERATOR_MARKER;
  }

  // Pull an authored orientation block out of the source index body,
  // if one was forwarded. The source may carry either literal
  // `<!-- BEGIN AUTHORED ORIENTATION -->` markers (e.g. when re-
  // building an already-built wiki) or a plain prose preface. We
  // only lift the marker-delimited block here — the plain-prose case
  // is covered by the `orientation:` YAML field, which we already
  // forwarded into `data` via AUTHORED_FIELDS.
  let sourceAuthoredOrientation = null;
  if (indexInput?.body) {
    sourceAuthoredOrientation = extractAuthoredBlock(indexInput.body);
  }

  // Deterministic key order
  const ordered = orderKeys(data, isRoot);
  const body = renderBody(
    ordered,
    existing,
    sourceAuthoredOrientation,
  );
  atomicWriteFile(p, renderFrontmatter(ordered, body));
  return { path: p, entries: entries.length, children: subdirs.length };
}

export function rebuildAllIndices(wikiRoot, options = {}) {
  // Rebuild bottom-up so parent `shared_covers[]` computations see fresh
  // child frontmatter. The wiki root is ALWAYS included even when it
  // has no leaves of its own, so `isWikiRoot` can find the generator
  // marker in its regenerated frontmatter.
  //
  // Scale: each directory's `listChildren` result is cached during the
  // walk and threaded into `rebuildIndex` so every leaf's frontmatter is
  // read exactly once per rebuild. The naive implementation walked twice
  // (once to collect directories, once during per-directory aggregation),
  // which doubled I/O for no reason.
  //
  // `options.indexInputs`: optional map { dirRelPath → authoredIndex }
  // produced by the orchestrator's ingest phase when the source tree
  // carried authored `index.md` files. Each entry forwards its
  // frontmatter (orientation / shared_covers / activation_defaults /
  // focus / tags / domains …) into the corresponding target index.
  // Keys are POSIX-normalised relative paths from the wiki root
  // (`""` for the root, `"operations"` for `operations/index.md`).
  const { indexInputs = {} } = options;
  const cache = new Map(); // dirPath → { leaves, subdirs }
  const rootChildren = listChildren(wikiRoot);
  cache.set(wikiRoot, rootChildren);
  const dirs = [wikiRoot];
  collectDirs(wikiRoot, wikiRoot, dirs, cache);
  // Sort by depth descending so deepest directories rebuild first.
  dirs.sort((a, b) => depthOf(b, wikiRoot) - depthOf(a, wikiRoot));
  const out = [];
  for (const d of dirs) {
    const rel = d === wikiRoot ? "" : relative(wikiRoot, d).split("\\").join("/");
    const indexInput = indexInputs[rel] || null;
    out.push(
      rebuildIndex(d, wikiRoot, cache.get(d) ?? null, { indexInput }),
    );
  }
  return out;
}

function collectDirs(dirPath, wikiRoot, acc, cache) {
  if (!existsSync(dirPath)) return;
  try {
    // Reuse the cached result when the caller (rebuildAllIndices)
    // has already paid for it; otherwise compute and stash it so
    // the rebuild pass can reuse.
    let children = cache.get(dirPath);
    if (!children) {
      children = listChildren(dirPath);
      cache.set(dirPath, children);
    }
    const { leaves, subdirs } = children;
    // Include every non-root directory that carries at least one leaf
    // or indexed subdir. The wiki root was already added by the
    // caller; we skip adding it again to avoid duplicates.
    if (dirPath !== wikiRoot && (leaves.length > 0 || subdirs.length > 0)) {
      acc.push(dirPath);
    }
    for (const s of subdirs) collectDirs(s, wikiRoot, acc, cache);
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
    "mode",
    "layout_contract_path",
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

function renderBody(data, existing, sourceAuthoredOrientation) {
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

  // Preserve authored orientation block. Priority:
  //   1. existing target index.md body (`<!-- BEGIN AUTHORED ORIENTATION -->`)
  //   2. authored source index body block (forwarded via indexInput)
  //   3. YAML `orientation:` field from the rebuilt frontmatter
  const authored = extractAuthoredBlock(existing?.body ?? "");
  const sourceAuthored = sourceAuthoredOrientation || null;
  lines.push(AUTHORED_BEGIN);
  if (authored) {
    lines.push(authored);
  } else if (sourceAuthored) {
    lines.push(sourceAuthored);
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
