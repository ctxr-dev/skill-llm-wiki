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
import { dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { WIKI_GENERATOR_MARKER, indexIdForDir } from "./paths.mjs";
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

  // Ensure required identity fields. An index id is STRUCTURAL: the validator
  // requires it to equal the directory's path from the wiki root, so it is always
  // re-derived (never preserved from a stale/stub value). Using the relative path
  // (root keeps its basename) means nested dirs that reuse a segment name do not
  // collide under the validator's global-unique-id invariant, and an upgrade
  // re-nests existing basename ids on the next rebuild.
  data.id = indexIdForDir(wikiRoot, dirPath);
  data.type = "index";
  // Depth-role mapping per schema: root is "category", everything deeper is
  // "subcategory". (Early drafts mislabeled depth-1 as "category"; fixed.)
  data.depth_role = depth === 0 ? "category" : "subcategory";
  if (isRoot) data.depth_role = "category";
  data.depth = depth;

  // `focus` (and a derived `tags` union) are computed AFTER the entries are
  // aggregated below, so the index can summarise its subtree instead of an
  // opaque "subtree under <path>" placeholder. An authored focus is preserved.

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

  // Derived focus + tags: make the index self-describing for navigation. When no
  // focus is authored (or it is a stale "subtree under <path>" placeholder),
  // summarise the subtree from the aggregated child entries; also union the
  // descendants' tags when none are authored. rebuildAllIndices runs deepest-first
  // (and incremental callers should rebuild bottom-up), so a child's index focus
  // is already aggregated when its parent reads it here -> leaf topics bubble up.
  if (!data.focus || isPlaceholderFocus(data.focus, data.id)) {
    data.focus = deriveIndexFocus(data.id, entries);
  }
  // Normalise authored string tags ("foo" / "foo, bar") into an array: the schema
  // (guide/basics/schema.md) types tags as string[], so downstream Array.isArray
  // routing would otherwise ignore a string value entirely.
  if (typeof data.tags === "string") {
    data.tags = data.tags.split(",").map((t) => t.trim()).filter(Boolean);
  }
  // Derive a descendant-tag union ONLY when tags is absent. The presence of the
  // key (even an empty `tags: []`) is treated as authored, so an author can
  // deliberately opt a navigation index out of tags.
  if (data.tags === undefined) {
    const derivedTags = deriveIndexTags(entries);
    if (derivedTags.length > 0) data.tags = derivedTags;
  }

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
  // Split on BOTH separators: node's relative() yields "\\" on Windows, and the
  // deepest-first rebuild order (which the focus/tag bubble-up relies on) would
  // otherwise miscompute depth there and rebuild parents before children.
  return relative(wikiRoot, dirPath).split(/[\\/]/).filter(Boolean).length;
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
      // URL-encode the link DESTINATION so a path segment with a space (or
      // other special char) still navigates in Obsidian / standard markdown.
      // Split on BOTH separators (node's relative() yields "\\" on Windows) and
      // join with "/" so the destination is a valid forward-slash URL path; the
      // human-readable label keeps the raw relative path. encodeURIComponent is
      // a no-op for ordinary slugified segments, so normal links are unchanged.
      const dest = e.file.split(/[\\/]/).map(encodeURIComponent).join("/");
      lines.push(`| [${e.file}](${dest}) | ${typeTag} | ${e.focus || ""} |`);
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

// True only for the EXACT legacy placeholder this skill generated for `id`
// ("subtree under <id>"). Matching exactly (not a prefix) means a genuinely
// authored focus that merely starts with those words (e.g. "subtree under water")
// is never mistaken for a placeholder and clobbered on rebuild.
function isPlaceholderFocus(focus, id) {
  if (typeof focus !== "string") return false;
  const f = focus.trim();
  // Match the placeholder for the current path-id AND for the legacy basename-id
  // form: deep indices used to be id'd by basename (e.g. "v1" before the path-id
  // change made it "api/v1"), so a placeholder written as "subtree under v1" must
  // still be recognised and refreshed rather than bubbled up as opaque text.
  const base = String(id).split("/").pop();
  return f === `subtree under ${id}` || f === `subtree under ${base}`;
}

// Summarise a directory from its aggregated child entries so the index focus
// describes the subtree (e.g. "landing: backtest cards badges; ocr stat numbers")
// instead of an opaque "subtree under <path>". Deterministic + length-bounded.
function deriveIndexFocus(id, entries) {
  const label = String(id).split("/").pop() || String(id);
  const topics = [];
  for (const e of entries || []) {
    const f = String(e.focus || e.id || "").replace(/\s+/g, " ").trim();
    if (!f || isPlaceholderFocus(f, e.id)) continue;
    topics.push(f);
    if (topics.length >= 6) break;
  }
  if (topics.length === 0) return `${label}: (no described entries yet)`;
  const summary = `${label}: ${topics.join("; ")}`;
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

// Union of descendant entry tags (entries carry each leaf's / sub-index's tags,
// so this propagates bottom-up). Tags may be arrays or comma-strings. Sorted +
// capped for deterministic output.
function deriveIndexTags(entries) {
  const seen = new Set();
  for (const e of entries || []) {
    const t = e.tags;
    const arr = Array.isArray(t) ? t : typeof t === "string" ? t.split(",") : [];
    for (const raw of arr) {
      const v = String(raw).trim().toLowerCase();
      if (v) seen.add(v);
    }
  }
  return [...seen].sort().slice(0, 20);
}

function titleize(id) {
  return id
    .split(/[/-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function atomicWriteFile(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = targetPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, targetPath);
}
