// layout-config.mjs — deterministic leaf placement from a hand-authored
// layout file.
//
// When `build` / `rebuild` is invoked with `--layout-config <path>`, leaf
// placement stops being an emergent property of TF-IDF / embedding
// clustering and becomes a PROJECTION of each leaf's `id` through a fixed
// taxonomy of pins. The same layout file is the contract the standalone
// validator (skill-code-review/scripts/validate_layout.py) enforces in
// CI, and `validateTreeAgainstLayout` below re-implements its placement
// checks in validate.mjs's finding shape so a plain `validate <wiki>`
// hard-fails on drift once the layout contract is persisted to
// `<wiki>/.layout/layout-config.yaml` (a filename distinct from hosted-mode's
// `<wiki>/.layout/layout.yaml` contract, to avoid grammar collision).
//
// Pin grammar (mirrors validate_layout.py::category_for):
//   - { id: "<exact>" }       leaf id === value
//   - { id_prefix: "<pre>" }  leaf id startsWith value
//   - { id_glob: "<glob>" }   fnmatch(leaf id, value)
// First match wins; taxonomy order is precedence (a leaf is placed in the
// FIRST category whose FIRST matching rule fires, scanning categories
// top-to-bottom and rules within a category in declared order).
//
// Subcategories: a category may carry `subcategories[]`, each its own
// `{ id, purpose?, pin[] }`. A leaf is first routed to its category; if
// that category has subcategories, the leaf is then routed to the FIRST
// subcategory whose pins match (same first-match-wins rule). A leaf that
// matches the category but no subcategory stays directly under the
// category dir.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import matter from "gray-matter";
import { parseFrontmatter } from "./frontmatter.mjs";

// ── YAML loading ─────────────────────────────────────────────────────

// Parse a top-level YAML document by reusing gray-matter (a declared
// direct dependency) — the layout file is wrapped in `---` fences so the
// same battle-tested YAML engine the rest of the pipeline relies on
// parses the nested taxonomy / pins. Avoids taking a direct dependency
// on the transitive `js-yaml`.
// Recursively drop prototype-pollution keys (mirrors the `sanitise` pass in
// source-frontmatter.mjs) so a malicious layout YAML cannot poison Object
// prototypes via `__proto__` / `constructor` / `prototype`.
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function sanitiseValue(value) {
  if (Array.isArray(value)) return value.map(sanitiseValue);
  if (value && typeof value === "object") {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      if (POLLUTION_KEYS.has(k)) continue;
      out[k] = sanitiseValue(v);
    }
    return out;
  }
  return value;
}

function parseYamlDocument(raw, path) {
  // Parse the layout file as a single YAML document directly via
  // gray-matter's bundled YAML engine (js-yaml). We deliberately do NOT wrap
  // the content in frontmatter fences: a layout file is pure YAML and may
  // legitimately begin with a `---` document marker, contain `---` lines, or
  // use `|+` block scalars — all of which a fence wrapper would corrupt (the
  // first `---` would be read as a closing fence, yielding empty data, and
  // trailing-whitespace trimming would drop block-scalar newlines).
  let parsed;
  try {
    parsed = matter.engines.yaml.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`layout-config: failed to parse YAML at ${path}: ${message}`);
  }
  const data = sanitiseValue(parsed);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`layout-config: ${path} did not parse to a mapping`);
  }
  return data;
}

// loadLayoutConfig(path) — read, parse, normalize, and validate the
// layout file. Throws on a malformed file (missing/empty taxonomy,
// duplicate category ids, malformed pins, …). Returns a normalized cfg:
//   {
//     layout_version: number|null,
//     policy: { max_depth, fanout_target, fanout_hard_max, unpinned,
//               on_unknown_leaf },
//     taxonomy: [ { id, purpose, pin: [rule...],
//                   subcategories: [ { id, purpose, pin } ] } ],
//     frontmatter_contract: object,
//     raw_text: string,   // the verbatim file bytes, for persistence
//     source_path: string,
//   }
export function loadLayoutConfig(path) {
  if (!path || typeof path !== "string") {
    throw new Error("loadLayoutConfig: a path string is required");
  }
  if (!existsSync(path)) {
    throw new Error(`loadLayoutConfig: layout file not found: ${path}`);
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`loadLayoutConfig: cannot read ${path}: ${message}`);
  }
  const doc = parseYamlDocument(raw, path);

  const taxonomyIn = doc.taxonomy;
  if (!Array.isArray(taxonomyIn) || taxonomyIn.length === 0) {
    throw new Error(`loadLayoutConfig: ${path} has no non-empty taxonomy[]`);
  }

  const seenCatIds = new Set();
  const taxonomy = taxonomyIn.map((cat, i) => {
    if (!cat || typeof cat !== "object") {
      throw new Error(`loadLayoutConfig: taxonomy[${i}] is not a mapping`);
    }
    const id = cat.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`loadLayoutConfig: taxonomy[${i}] missing a string id`);
    }
    if (seenCatIds.has(id)) {
      throw new Error(`loadLayoutConfig: duplicate category id "${id}"`);
    }
    seenCatIds.add(id);
    const pin = normalizePins(cat.pin, `taxonomy[${i}] (${id})`);
    const subcategories = normalizeSubcategories(cat.subcategories, id);
    return {
      id,
      purpose: typeof cat.purpose === "string" ? cat.purpose : "",
      pin,
      subcategories,
    };
  });

  const policyIn = doc.policy && typeof doc.policy === "object" ? doc.policy : {};
  const policy = {
    max_depth: numOrNull(policyIn.max_depth),
    fanout_target: numOrNull(policyIn.fanout_target),
    fanout_hard_max: numOrNull(policyIn.fanout_hard_max),
    unpinned: typeof policyIn.unpinned === "string" ? policyIn.unpinned : "allow",
    on_unknown_leaf:
      typeof policyIn.on_unknown_leaf === "string" ? policyIn.on_unknown_leaf : "warn",
  };

  return {
    layout_version: numOrNull(doc.layout_version),
    policy,
    taxonomy,
    frontmatter_contract:
      doc.frontmatter_contract && typeof doc.frontmatter_contract === "object"
        ? doc.frontmatter_contract
        : {},
    raw_text: raw,
    source_path: path,
  };
}

function numOrNull(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function normalizePins(pinIn, where) {
  if (pinIn === undefined || pinIn === null) return [];
  if (!Array.isArray(pinIn)) {
    throw new Error(`loadLayoutConfig: ${where} pin[] must be a list`);
  }
  return pinIn.map((rule, j) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`loadLayoutConfig: ${where} pin[${j}] is not a mapping`);
    }
    const keys = ["id", "id_prefix", "id_glob"].filter((k) => k in rule);
    if (keys.length === 0) {
      throw new Error(
        `loadLayoutConfig: ${where} pin[${j}] needs one of id / id_prefix / id_glob`,
      );
    }
    if (keys.length > 1) {
      // The grammar is strictly one-of: allowing several matchers in a
      // single rule would make precedence implicit. Reject at load so the
      // config is unambiguous (and so the Python validator the build
      // driver mirrors never sees a shape it would silently first-match).
      throw new Error(
        `loadLayoutConfig: ${where} pin[${j}] has ${keys.length} matchers ` +
          `(${keys.join(", ")}); use exactly one of id / id_prefix / id_glob`,
      );
    }
    const out = {};
    for (const k of keys) {
      if (typeof rule[k] !== "string") {
        throw new Error(`loadLayoutConfig: ${where} pin[${j}].${k} must be a string`);
      }
      out[k] = rule[k];
    }
    return out;
  });
}

function normalizeSubcategories(subsIn, catId) {
  if (subsIn === undefined || subsIn === null) return [];
  if (!Array.isArray(subsIn)) {
    throw new Error(`loadLayoutConfig: category "${catId}" subcategories must be a list`);
  }
  const seen = new Set();
  return subsIn.map((sub, k) => {
    if (!sub || typeof sub !== "object") {
      throw new Error(`loadLayoutConfig: category "${catId}" subcategories[${k}] not a mapping`);
    }
    const id = sub.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`loadLayoutConfig: category "${catId}" subcategories[${k}] missing id`);
    }
    if (seen.has(id)) {
      throw new Error(`loadLayoutConfig: category "${catId}" duplicate subcategory id "${id}"`);
    }
    seen.add(id);
    return {
      id,
      purpose: typeof sub.purpose === "string" ? sub.purpose : "",
      pin: normalizePins(sub.pin, `category "${catId}" subcategories[${k}] (${id})`),
    };
  });
}

// ── Pin matching ─────────────────────────────────────────────────────

// Match a single leaf id against a single pin rule. Mirrors
// validate_layout.py::category_for's per-rule logic exactly.
function ruleMatches(leafId, rule) {
  if ("id" in rule) return leafId === rule.id;
  if ("id_prefix" in rule) return leafId.startsWith(rule.id_prefix);
  if ("id_glob" in rule) return globMatch(leafId, rule.id_glob);
  return false;
}

// fnmatch-style glob: `*` → any run, `?` → single char, `[seq]` / `[!seq]`
// → character class (with ranges like `a-z`). Anchored at both ends,
// matching Python's fnmatch.fnmatch on a flat id (ids never contain `/`).
// This ports the class-handling branch of CPython's fnmatch.translate so a
// `id_glob` resolves identically here (the build driver) and in the Python
// validate_layout.py validator. Other characters match literally.
function globMatch(value, glob) {
  let re = "^";
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const ch = glob[i];
    i += 1;
    if (ch === "*") {
      re += ".*";
    } else if (ch === "?") {
      re += ".";
    } else if (ch === "[") {
      // Find the matching close bracket. A `]` immediately after `[` or
      // `[!` is a literal member, not the terminator (fnmatch semantics).
      let j = i;
      if (j < n && glob[j] === "!") j += 1;
      if (j < n && glob[j] === "]") j += 1;
      while (j < n && glob[j] !== "]") j += 1;
      if (j >= n) {
        // No closing bracket: treat the `[` as a literal character.
        re += "\\[";
      } else {
        let stuff = glob.slice(i, j).split("\\").join("\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        re += "[" + stuff + "]";
      }
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re).test(value);
}

// compilePins(cfg) → (leafId) => { category, subcategory } | null
// First-match-wins across categories (declared order), then across the
// matched category's subcategories. `subcategory` is null when the leaf
// matches the category but no subcategory.
export function compilePins(cfg) {
  const taxonomy = cfg.taxonomy;
  return function pinFor(leafId) {
    if (typeof leafId !== "string" || leafId === "") return null;
    for (const cat of taxonomy) {
      let catHit = false;
      for (const rule of cat.pin) {
        if (ruleMatches(leafId, rule)) {
          catHit = true;
          break;
        }
      }
      if (!catHit) continue;
      // Category matched. Resolve a subcategory if any are declared.
      let subcategory = null;
      for (const sub of cat.subcategories) {
        let subHit = false;
        for (const rule of sub.pin) {
          if (ruleMatches(leafId, rule)) {
            subHit = true;
            break;
          }
        }
        if (subHit) {
          subcategory = sub.id;
          break;
        }
      }
      return { category: cat.id, subcategory };
    }
    return null;
  };
}

// Extract the routing id from a leaf data object or candidate, in priority
// order: parsed-frontmatter `data.id` (the shape parseFrontmatter returns),
// then a flat candidate `.id`, then the source filename stem.
function leafIdOf(leafData) {
  if (leafData && typeof leafData === "object") {
    const data = leafData.data;
    if (data && typeof data === "object" && typeof data.id === "string" && data.id !== "") {
      return data.id;
    }
    if (typeof leafData.id === "string" && leafData.id !== "") return leafData.id;
    const sp = leafData.source_path;
    if (typeof sp === "string" && sp !== "") {
      return basename(sp).replace(/\.md$/i, "");
    }
  }
  return null;
}

// categoryForLeaf(cfg, leafData) → POSIX-relative target dir for the leaf
// (e.g. "security" or "security/web-session"), or null when the leaf
// matches no pin. The orchestrator uses this at the draftCategory call
// site: a non-null result places the leaf straight into its pinned dir;
// null falls back to emergent draftCategory(candidate).
// Per-cfg compiled-matcher cache. A WeakMap keyed on the cfg object (NOT a
// property mutated onto cfg) so user-controlled YAML can never collide with an
// internal `__pinFor` key, and the public cfg shape stays clean.
const _pinForCache = new WeakMap();

export function categoryForLeaf(cfg, leafData) {
  const id = leafIdOf(leafData);
  if (id == null) return null;
  let pinFor = _pinForCache.get(cfg);
  if (!pinFor) {
    pinFor = compilePins(cfg);
    _pinForCache.set(cfg, pinFor);
  }
  const hit = pinFor(id);
  if (!hit) return null;
  return hit.subcategory ? `${hit.category}/${hit.subcategory}` : hit.category;
}

// expectedTaxonomy(cfg) → {
//   dirs:      Set<string>   // every category + "category/subcategory"
//   categories: Set<string>  // top-level category ids only
//   purposes:  Map<string,string>  // dir → purpose
// }
export function expectedTaxonomy(cfg) {
  const dirs = new Set();
  const categories = new Set();
  const purposes = new Map();
  for (const cat of cfg.taxonomy) {
    dirs.add(cat.id);
    categories.add(cat.id);
    purposes.set(cat.id, cat.purpose || "");
    for (const sub of cat.subcategories) {
      const p = `${cat.id}/${sub.id}`;
      dirs.add(p);
      purposes.set(p, sub.purpose || "");
    }
  }
  return { dirs, categories, purposes };
}

// ── Tree validation ──────────────────────────────────────────────────

// Walk a built wiki and collect every leaf .md file (skipping index.md
// and dot-directories), returning [{ absPath, relPath, id }].
function collectLeafFiles(wikiRoot) {
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
      if (!e.isFile() || !e.name.endsWith(".md") || e.name === "index.md") continue;
      let id = basename(e.name, ".md");
      try {
        const { data } = parseFrontmatter(readFileSync(full, "utf8"), full);
        if (data && typeof data.id === "string" && data.id !== "") id = data.id;
      } catch {
        /* fall back to filename stem */
      }
      out.push({
        absPath: full,
        relPath: relative(wikiRoot, full).split("\\").join("/"),
        id,
      });
    }
  }
  return out;
}

// Count the non-index children of every directory in the tree (the
// fanout view the validator enforces).
function fanoutByDir(wikiRoot) {
  const counts = new Map();
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let n = 0;
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.name === "index.md") continue;
      n++;
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
    counts.set(dir, n);
  }
  return counts;
}

// validateTreeAgainstLayout(wikiRoot, cfg) → findings[] in validate.mjs's
// shape ({ severity, code, target, message }). Codes:
//   LAYOUT-TAXONOMY   top-level dir not in the taxonomy
//   LAYOUT-PIN        leaf sits in a dir != its pinned category path
//   LAYOUT-UNPINNED   leaf matches no pin (and policy.unpinned == reject)
//   LAYOUT-DEPTH      leaf deeper than policy.max_depth
//   LAYOUT-FANOUT     a node exceeds policy.fanout_hard_max
export function validateTreeAgainstLayout(wikiRoot, cfg) {
  const findings = [];
  const push = (severity, code, target, message) =>
    findings.push({ severity, code, target, message });

  const pinFor = compilePins(cfg);
  const { categories } = expectedTaxonomy(cfg);
  const policy = cfg.policy || {};
  const maxDepth = policy.max_depth;
  const fanoutHardMax = policy.fanout_hard_max;
  const rejectUnpinned = policy.unpinned === "reject";

  const leaves = collectLeafFiles(wikiRoot);
  for (const leaf of leaves) {
    const parts = leaf.relPath.split("/");
    const dirParts = parts.slice(0, -1);
    const top = dirParts.length > 0 ? dirParts[0] : "(root)";

    // Pin / placement.
    const hit = pinFor(leaf.id);
    if (!hit) {
      if (rejectUnpinned) {
        push("error", "LAYOUT-UNPINNED", leaf.relPath, `leaf "${leaf.id}" matches no pin in taxonomy`);
      }
    } else {
      const expectedDir = hit.subcategory ? `${hit.category}/${hit.subcategory}` : hit.category;
      const actualDir = dirParts.join("/");
      if (actualDir !== expectedDir) {
        push(
          "error",
          "LAYOUT-PIN",
          leaf.relPath,
          `leaf "${leaf.id}" is in "${actualDir || "(root)"}", pinned to "${expectedDir}"`,
        );
      }
    }

    // Taxonomy: top-level dir must be a known category.
    if (top !== "(root)" && !categories.has(top)) {
      push("error", "LAYOUT-TAXONOMY", top, `top-level dir "${top}" not in taxonomy`);
    }

    // Depth.
    if (maxDepth != null) {
      const depth = dirParts.length; // dirs above the file
      if (depth > maxDepth) {
        push("error", "LAYOUT-DEPTH", leaf.relPath, `depth ${depth} > max_depth ${maxDepth}`);
      }
    }
  }

  // Fanout per directory.
  if (fanoutHardMax != null) {
    const counts = fanoutByDir(wikiRoot);
    for (const [dir, n] of counts) {
      if (n > fanoutHardMax) {
        const rel = relative(wikiRoot, dir).split("\\").join("/") || ".";
        push("error", "LAYOUT-FANOUT", rel, `${n} children > fanout_hard_max ${fanoutHardMax}`);
      }
    }
  }

  // An empty category (a taxonomy entry with no leaf yet) is intentionally
  // NOT reported: a growing corpus legitimately carries categories ahead of
  // their first leaf, and the Python validate_layout.py validator this
  // mirrors does not flag them either. Only placement/taxonomy/depth/fanout
  // drift is actionable here.
  return findings;
}
