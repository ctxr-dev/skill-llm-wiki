// quality-metric.test.mjs — routing_cost metric on known-shape wikis.
//
// Two wikis are constructed:
//   - FLAT:  6 leaves, all at root, no subcategories
//   - NESTED: same 6 leaves, grouped into 2 subcategories of 3
//
// Assertions:
//   - metric returns non-zero cost for both
//   - nested wiki has strictly LOWER cost (better routing)
//   - total_leaf_bytes is identical for both (same leaf content)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { computeRoutingCost, totalLeafBytes } from "../../scripts/lib/quality-metric.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-qm-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeLeaf(wikiRoot, relPath, id, tags, focus, covers, keywords) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus,
    covers,
    tags,
    activation: { keyword_matches: keywords },
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n\nSome filler content for byte accounting.\n"), "utf8");
}

function writeIndex(wikiRoot, relDir, entries, extra = {}) {
  const dir = join(wikiRoot, relDir);
  mkdirSync(dir, { recursive: true });
  const data = {
    id: relDir === "" ? "root" : relDir,
    type: "index",
    depth_role: relDir === "" ? "category" : "subcategory",
    focus: `subtree under ${relDir || "root"}`,
    entries,
    ...extra,
  };
  writeFileSync(join(dir, "index.md"), renderFrontmatter(data, "\n"), "utf8");
}

// Shared leaf definitions so both wikis contain identical leaf bytes.
const LEAVES = [
  { rel: "rebuild-basic.md", id: "rebuild-basic", tags: ["rebuild", "operation"], focus: "rebuild a wiki", covers: ["plan", "apply"], kw: ["rebuild", "optimize"] },
  { rel: "build-basic.md", id: "build-basic", tags: ["build", "operation"], focus: "build a new wiki", covers: ["ingest", "draft"], kw: ["build", "new"] },
  { rel: "extend-basic.md", id: "extend-basic", tags: ["extend", "operation"], focus: "extend an existing wiki", covers: ["add", "merge"], kw: ["extend", "add"] },
  { rel: "history-log.md", id: "history-log", tags: ["history", "git"], focus: "history and log inspection", covers: ["log", "blame"], kw: ["history", "log"] },
  { rel: "history-blame.md", id: "history-blame", tags: ["history", "git"], focus: "git blame integration", covers: ["blame", "line"], kw: ["blame", "line"] },
  { rel: "history-reflog.md", id: "history-reflog", tags: ["history", "git"], focus: "reflog access", covers: ["reflog"], kw: ["reflog"] },
];

test("totalLeafBytes counts every .md under the wiki", () => {
  const wiki = tmpWiki("total");
  try {
    for (const l of LEAVES) {
      writeLeaf(wiki, l.rel, l.id, l.tags, l.focus, l.covers, l.kw);
    }
    const bytes = totalLeafBytes(wiki);
    assert.ok(bytes > 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

function buildFlatWiki() {
  const wiki = tmpWiki("flat");
  for (const l of LEAVES) {
    writeLeaf(wiki, l.rel, l.id, l.tags, l.focus, l.covers, l.kw);
  }
  const rootEntries = LEAVES.map((l) => ({
    id: l.id,
    file: l.rel,
    type: "primary",
    focus: l.focus,
    tags: l.tags,
    activation: { keyword_matches: l.kw },
  }));
  writeIndex(wiki, "", rootEntries);
  return wiki;
}

function buildNestedWiki() {
  const wiki = tmpWiki("nested");
  // Group 1: first three leaves under `operations/`.
  // Group 2: last three leaves under `history/`.
  const ops = LEAVES.slice(0, 3);
  const hist = LEAVES.slice(3);
  for (const l of ops) {
    writeLeaf(wiki, "operations/" + l.rel, l.id, l.tags, l.focus, l.covers, l.kw);
  }
  for (const l of hist) {
    writeLeaf(wiki, "history/" + l.rel, l.id, l.tags, l.focus, l.covers, l.kw);
  }
  // Subcategory indices aggregate the leaves inside them.
  writeIndex(
    wiki,
    "operations",
    ops.map((l) => ({
      id: l.id,
      file: l.rel,
      type: "primary",
      focus: l.focus,
      tags: l.tags,
      activation: { keyword_matches: l.kw },
    })),
    { tags: ["operation"], activation_defaults: { keyword_matches: ["build", "rebuild", "extend"] } },
  );
  writeIndex(
    wiki,
    "history",
    hist.map((l) => ({
      id: l.id,
      file: l.rel,
      type: "primary",
      focus: l.focus,
      tags: l.tags,
      activation: { keyword_matches: l.kw },
    })),
    { tags: ["history", "git"], activation_defaults: { keyword_matches: ["history", "log", "blame", "reflog"] } },
  );
  // Root index aggregates the two subcategories.
  writeIndex(wiki, "", [
    {
      id: "operations",
      file: "operations/index.md",
      type: "index",
      focus: "operations subtree",
      tags: ["operation"],
      activation_defaults: { keyword_matches: ["build", "rebuild", "extend"] },
    },
    {
      id: "history",
      file: "history/index.md",
      type: "index",
      focus: "history subtree",
      tags: ["history", "git"],
      activation_defaults: { keyword_matches: ["history", "log", "blame", "reflog"] },
    },
  ]);
  return wiki;
}

test("computeRoutingCost: nested wiki has lower cost than flat wiki", () => {
  const flat = buildFlatWiki();
  const nested = buildNestedWiki();
  try {
    const flatCost = computeRoutingCost(flat);
    const nestedCost = computeRoutingCost(nested);
    assert.ok(flatCost.cost > 0);
    assert.ok(nestedCost.cost > 0);
    assert.ok(
      nestedCost.cost < flatCost.cost,
      `expected nested (${nestedCost.cost.toFixed(4)}) < flat (${flatCost.cost.toFixed(4)})`,
    );
    assert.ok(flatCost.queries_matched > 0);
    assert.ok(nestedCost.queries_matched > 0);
  } finally {
    rmSync(flat, { recursive: true, force: true });
    rmSync(nested, { recursive: true, force: true });
  }
});

test("computeRoutingCost: returns 0 cost on empty wiki", () => {
  const wiki = tmpWiki("empty-qm");
  try {
    const r = computeRoutingCost(wiki);
    assert.equal(r.cost, 0);
    assert.equal(r.queries_matched, 0);
    assert.equal(r.total_leaf_bytes, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
