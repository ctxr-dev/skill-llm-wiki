// quality-metric.mjs — routing_cost metric for convergence.
//
// Definition: given a wiki tree and a fixed query distribution
// (query-fixture.mjs), simulate the routing procedure from
// SKILL.md for each query. Starting at the root index.md, read its
// frontmatter's entries[] records, compute which ones are
// "matched" by the query, follow matched subcategory indices one
// level deeper, and sum the file bytes of every file the routing
// pass read (root index + matched subcategory indices + matched
// leaves).
//
// Routing-substrate note. The old (literal) router matched on
// aggregated `activation_defaults` lifted into entries[] at the
// parent level. That substrate is gone. Parent `entries[]` now
// carry only `id` / `file` / `type` / `focus` / `tags`, plus the
// parent index itself has an authored `focus` / `shared_covers` /
// `tags` block. The simulator matches entries using those
// parent-side fields only — it does NOT peek into leaves to make
// a descent decision.
//
// This is the critical property that makes nested wikis cheaper
// than flat wikis in the simulator: if the parent's description
// of a subcategory ("focus", shared covers, tags) doesn't match
// the query, the subcategory's whole subtree is skipped, and
// every leaf inside it stays unread. In the old literal-routing
// substrate the subcategory's `activation_defaults` was the gate;
// now it's the subcategory's authored `focus` and shared_covers.
//
// Per-leaf `activation` blocks on the leaves themselves are
// ignored by the simulator. They still round-trip through
// frontmatter and may inform Claude's judgment once a leaf is
// already open, but for the purposes of the routing-cost metric
// they're hidden behind the parent gate.
//
// The metric is:
//
//   routing_cost = SUM over queries of bytes_read(query) / total_leaf_bytes
//
// where total_leaf_bytes is the total bytes of every .md file
// under the wiki (excluding .llmwiki / .work / index.md). Lower is
// better. A perfectly-shaped wiki where each query activates only
// the matching subcategory will score much lower than a flat wiki
// where every leaf is a peer at the root and every root lookup
// has to consider them all.
//
// This metric intentionally favours NESTED shapes over FLAT
// shapes for the same leaves — a flat wiki's root index.md is
// larger (lists all entries), and routing at the root level has
// to read every activated leaf directly (no subcategory index
// between). A nested wiki's root index.md is smaller (lists
// subcategories) and routing skips past non-matching
// subcategories without visiting their leaves. That's the
// behaviour we want to incentivise.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { REPRESENTATIVE_QUERIES } from "./query-fixture.mjs";

// Compute the total bytes of every .md file under wikiRoot,
// excluding dot-directories. Used as the denominator in the cost
// ratio so the metric is in a comparable [0, N] range.
export function totalLeafBytes(wikiRoot) {
  let total = 0;
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
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      try {
        total += statSync(full).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

// Does an entry match for a query? Uses only parent-side fields
// that travel in the parent index's `entries[]` record: `tags`
// (authored, optional) and `focus` (always present, even if it's
// just a placeholder). No peeking into leaves or aggregated
// defaults — those substrates are gone.
//
// For subcategory entries we additionally consider the
// subcategory's own `tags` and `shared_covers` authored in its
// index.md, because those are the subcategory's "I am relevant
// for queries about X" description. We read that from the
// subcat's index.md on demand; the root index no longer carries
// an aggregated copy.
function entryMatches(entry, query) {
  if (!entry) return false;
  const qKeywords = new Set(
    (query.activation_keywords || []).map((k) => k.toLowerCase()),
  );
  const qTags = new Set((query.tags || []).map((t) => t.toLowerCase()));
  const entryTags = Array.isArray(entry.tags) ? entry.tags : [];
  for (const t of entryTags) {
    if (qTags.has(String(t).toLowerCase())) return true;
  }
  const focus = typeof entry.focus === "string" ? entry.focus.toLowerCase() : "";
  for (const kw of qKeywords) {
    if (focus.includes(kw)) return true;
  }
  return false;
}

// Does a subcategory's own authored frontmatter match for a
// query? We read the subcat's index.md (which the router will
// read anyway once it descends) and check its `tags`, `focus`,
// and `shared_covers` against the query. Returns true if any
// field matches.
function subcatOwnMatches(parsed, query) {
  if (!parsed || !parsed.data) return false;
  const qKeywords = new Set(
    (query.activation_keywords || []).map((k) => k.toLowerCase()),
  );
  const qTags = new Set((query.tags || []).map((t) => t.toLowerCase()));
  const data = parsed.data;
  const ownTags = Array.isArray(data.tags) ? data.tags : [];
  for (const t of ownTags) {
    if (qTags.has(String(t).toLowerCase())) return true;
  }
  const focus = typeof data.focus === "string" ? data.focus.toLowerCase() : "";
  for (const kw of qKeywords) {
    if (focus.includes(kw)) return true;
  }
  const covers = Array.isArray(data.shared_covers) ? data.shared_covers : [];
  for (const c of covers) {
    const lc = String(c).toLowerCase();
    for (const kw of qKeywords) {
      if (lc.includes(kw)) return true;
    }
  }
  return false;
}

// Simulate routing for one query starting at `dirPath`'s index.md.
// Returns the set of absolute file paths the router would read.
// Bounded recursion: depth cap of 10 prevents pathological cycles.
//
// The walk is strictly parent-gated: a subcategory is only
// descended into when either the parent-side entries[] record
// matches (via `entryMatches`) OR the subcat's own authored
// frontmatter matches (via `subcatOwnMatches` reading the
// subcat's index.md). Leaves inside a non-matching subcat are
// never touched. This matches the semantic routing procedure in
// SKILL.md: Claude descends based on the parent's description of
// the child, not on deep-probe of the child's descendants.
function simulateQueryRouting(wikiRoot, query, dirPath = wikiRoot, depth = 0, visited = new Set()) {
  if (depth > 10) return visited;
  const indexPath = join(dirPath, "index.md");
  if (!existsSync(indexPath)) return visited;
  if (visited.has(indexPath)) return visited;
  visited.add(indexPath);
  let parsed;
  try {
    const raw = readFileSync(indexPath, "utf8");
    parsed = parseFrontmatter(raw, indexPath);
  } catch {
    return visited;
  }
  const entries = Array.isArray(parsed.data.entries) ? parsed.data.entries : [];
  for (const entry of entries) {
    const file = entry.file;
    if (!file || typeof file !== "string") continue;
    const full = join(dirPath, file);
    if (visited.has(full)) continue;
    if (entry.type === "index") {
      // First try the parent-side record (cheap, no extra I/O).
      let shouldDescend = entryMatches(entry, query);
      const subDir = full.endsWith("index.md") ? full.slice(0, -"index.md".length - 1) : full;
      if (!shouldDescend) {
        // Fallback: peek at the subcat's own authored
        // `focus`/`tags`/`shared_covers` (parsing the index once).
        // This matches "Claude opens the child index to read its
        // own focus before deciding to descend" and is still a
        // parent-gate, not a deep-probe of leaves.
        const subIndexPath = join(subDir, "index.md");
        if (existsSync(subIndexPath)) {
          try {
            const subRaw = readFileSync(subIndexPath, "utf8");
            const subParsed = parseFrontmatter(subRaw, subIndexPath);
            if (subcatOwnMatches(subParsed, query)) shouldDescend = true;
          } catch {
            /* ignore — don't descend */
          }
        }
      }
      if (!shouldDescend) continue;
      simulateQueryRouting(wikiRoot, query, subDir, depth + 1, visited);
    } else {
      if (!entryMatches(entry, query)) continue;
      visited.add(full);
    }
  }
  return visited;
}

// Sum bytes of every file in a set (missing files count zero).
function sumBytes(files) {
  let total = 0;
  for (const f of files) {
    try {
      total += statSync(f).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

// Compute the routing_cost metric for a wiki. Returns an object:
//
//   { cost, per_query, total_leaf_bytes, queries_matched }
//
// `cost` is the primary scalar used by convergence (lower = better).
// `per_query` is a per-query breakdown for debugging / logs.
export function computeRoutingCost(wikiRoot, options = {}) {
  const { queries = REPRESENTATIVE_QUERIES } = options;
  const total = totalLeafBytes(wikiRoot);
  if (total === 0) {
    return { cost: 0, per_query: [], total_leaf_bytes: 0, queries_matched: 0 };
  }
  let costSum = 0;
  const per = [];
  let matched = 0;
  for (const q of queries) {
    const files = simulateQueryRouting(wikiRoot, q);
    const bytes = sumBytes(files);
    if (files.size > 0) matched++;
    const ratio = bytes / total;
    costSum += ratio;
    per.push({
      query: q.id,
      files: files.size,
      bytes,
      ratio,
    });
  }
  return {
    cost: costSum,
    per_query: per,
    total_leaf_bytes: total,
    queries_matched: matched,
  };
}

// Pretty-print a metric result for commit messages / logs.
export function formatRoutingCost(metric) {
  return (
    `routing_cost=${metric.cost.toFixed(4)} ` +
    `(${metric.queries_matched}/${metric.per_query.length} queries matched, ` +
    `total_leaf_bytes=${metric.total_leaf_bytes})`
  );
}
