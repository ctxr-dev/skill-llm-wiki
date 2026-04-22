// soft-dag.test.mjs — Phase X.4: --soft-dag-parents synthesis.
//
// Covers the DAG soft-parent synthesis pipeline end-to-end at the
// module boundary: building category vectors, scoring leaf-vs-
// category affinity, writing parents[] frontmatter, and the
// post-rebuild `applySoftParentEntries` pass that adds leaves into
// claimed parents' `entries[]`.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  SOFT_PARENT_AFFINITY_THRESHOLD,
  SOFT_PARENT_MAX_PER_LEAF,
  applySoftParentEntries,
  runSoftDagParents,
} from "../../scripts/lib/soft-dag.mjs";
import { parseFrontmatter, renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";

function tmpWiki(prefix) {
  const p = join(
    tmpdir(),
    `skill-llm-wiki-softdag-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(p, { recursive: true });
  return p;
}

function writeIndex(wiki, rel, id, extra = {}) {
  const full = join(wiki, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "index",
    depth_role: id === basename(wiki) ? "category" : "subcategory",
    focus: extra.focus ?? `subtree under ${id}`,
    ...extra,
  };
  writeFileSync(full, renderFrontmatter(data, `\n# ${id}\n`), "utf8");
}

function writeLeaf(wiki, rel, id, extra = {}) {
  const full = join(wiki, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "primary",
    focus: extra.focus ?? id,
    covers: extra.covers ?? [id],
    tags: extra.tags ?? ["default"],
    parents: extra.parents ?? ["index.md"],
    activation: { keyword_matches: extra.kw ?? [id] },
  };
  writeFileSync(full, renderFrontmatter(data, `\n# ${id}\n`), "utf8");
  return { path: full, data };
}

function readLeaf(leafPath) {
  const raw = readFileSync(leafPath, "utf8");
  return parseFrontmatter(raw, leafPath);
}

test("SOFT_PARENT_AFFINITY_THRESHOLD and SOFT_PARENT_MAX_PER_LEAF are the documented defaults", () => {
  // Pin the constants so future tuning is intentional and visible
  // in the test diff rather than a silent threshold drift.
  assert.equal(SOFT_PARENT_AFFINITY_THRESHOLD, 0.35);
  assert.equal(SOFT_PARENT_MAX_PER_LEAF, 3);
});

test("runSoftDagParents: no-op on an empty wiki", async () => {
  const wiki = tmpWiki("empty");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    const r = await runSoftDagParents(wiki);
    assert.equal(r.leavesProcessed, 0);
    assert.equal(r.softParentsAdded, 0);
    assert.equal(r.perLeaf.size, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: adds no soft parents when a leaf has no similar category", async () => {
  const wiki = tmpWiki("unrelated");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "food/index.md", "food", {
      focus: "cooking recipes ingredients",
      covers: ["cooking", "baking"],
    });
    writeLeaf(wiki, "food/sourdough.md", "sourdough", {
      focus: "sourdough bread hydration levain",
      covers: ["sourdough", "bread"],
      tags: ["baking"],
    });
    writeIndex(wiki, "astronomy/index.md", "astronomy", {
      focus: "celestial bodies orbits telescopes",
      covers: ["orbits", "telescopes"],
    });
    writeLeaf(wiki, "astronomy/planets.md", "planets", {
      focus: "planets solar system orbital mechanics",
      covers: ["planets", "solar-system"],
      tags: ["astronomy"],
    });
    const r = await runSoftDagParents(wiki);
    assert.equal(r.leavesProcessed, 2);
    // Sourdough vs astronomy category: zero shared tokens → 0 cosine.
    // No soft parents should qualify.
    const sourdough = r.perLeaf.get(join(wiki, "food", "sourdough.md"));
    const planets = r.perLeaf.get(join(wiki, "astronomy", "planets.md"));
    assert.deepEqual(sourdough, [], "unrelated leaf must get zero soft parents");
    assert.deepEqual(planets, [], "unrelated leaf must get zero soft parents");
    assert.equal(r.softParentsAdded, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: adds soft parents when a leaf's signal overlaps multiple categories", async () => {
  const wiki = tmpWiki("overlap");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Two categories that share a clear topical overlap: cache and
    // retry strategies in distributed systems. A leaf that talks
    // about BOTH (e.g., "cached-retry-backoff") should get the
    // non-primary category as a soft parent.
    writeIndex(wiki, "cache/index.md", "cache", {
      focus: "cache eviction lru ttl strategy",
      covers: ["cache", "eviction", "lru"],
    });
    writeLeaf(wiki, "cache/redis-cache.md", "redis-cache", {
      focus: "redis cache eviction lru ttl",
      covers: ["redis", "cache", "eviction", "lru", "ttl"],
      tags: ["cache", "redis"],
    });
    writeLeaf(wiki, "cache/memcached-cache.md", "memcached-cache", {
      focus: "memcached cache slab lru",
      covers: ["memcached", "cache", "slab", "lru"],
      tags: ["cache"],
    });
    writeLeaf(wiki, "cache/varnish-cache.md", "varnish-cache", {
      focus: "varnish cache edge vcl lru",
      covers: ["varnish", "cache", "edge", "vcl", "lru"],
      tags: ["cache"],
    });
    writeIndex(wiki, "retry/index.md", "retry", {
      focus: "retry backoff timeout budget strategy",
      covers: ["retry", "backoff", "timeout"],
    });
    writeLeaf(wiki, "retry/http-retry.md", "http-retry", {
      focus: "http retry backoff budget timeout",
      covers: ["http", "retry", "backoff", "budget"],
      tags: ["retry"],
    });
    writeLeaf(wiki, "retry/rpc-retry.md", "rpc-retry", {
      focus: "rpc retry deadline backoff",
      covers: ["rpc", "retry", "deadline", "backoff"],
      tags: ["retry"],
    });
    writeLeaf(wiki, "retry/cached-retry-backoff.md", "cached-retry-backoff", {
      // Dual-topic leaf: heavy token overlap with BOTH categories.
      focus: "cached retry backoff cache ttl eviction lru",
      covers: ["cached", "retry", "backoff", "cache", "ttl", "lru"],
      tags: ["retry", "cache"],
    });
    const r = await runSoftDagParents(wiki);
    const dual = r.perLeaf.get(join(wiki, "retry", "cached-retry-backoff.md"));
    assert.ok(dual, "dual-topic leaf must have a soft-parent entry");
    // The dual leaf's PRIMARY parent is retry/, so its soft parent
    // should be cache/ — POSIX-relative from retry/ that's
    // "../cache/index.md".
    assert.ok(
      dual.includes("../cache/index.md"),
      `expected dual leaf to claim cache/ as soft parent; got ${JSON.stringify(dual)}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: respects SOFT_PARENT_MAX_PER_LEAF cap", async () => {
  const wiki = tmpWiki("cap");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Five category dirs, all broadly similar via shared tokens.
    // A leaf matching all five should be capped at maxPerLeaf=2.
    const topics = ["alpha", "beta", "gamma", "delta", "epsilon"];
    for (const t of topics) {
      writeIndex(wiki, `${t}/index.md`, t, {
        focus: `${t} shared-core token common-topic discussion`,
        covers: [t, "shared-core", "common-topic"],
      });
      for (let i = 0; i < 3; i++) {
        writeLeaf(wiki, `${t}/${t}-leaf-${i}.md`, `${t}-leaf-${i}`, {
          focus: `${t} shared-core token common-topic item ${i}`,
          covers: [t, "shared-core", "common-topic"],
          tags: [t],
        });
      }
    }
    const r = await runSoftDagParents(wiki, { maxPerLeaf: 2 });
    for (const [, soft] of r.perLeaf) {
      assert.ok(
        soft.length <= 2,
        `per-leaf cap must hold; got ${soft.length} entries`,
      );
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: deterministic — two runs on the same tree produce byte-identical parents[]", async () => {
  const wiki = tmpWiki("determ");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", {
      focus: "cache eviction lru ttl strategy",
      covers: ["cache", "eviction", "lru"],
    });
    writeLeaf(wiki, "cache/a.md", "a", {
      focus: "cache eviction lru", covers: ["cache", "eviction", "lru"], tags: ["cache"],
    });
    writeLeaf(wiki, "cache/b.md", "b", {
      focus: "cache ttl strategy", covers: ["cache", "ttl"], tags: ["cache"],
    });
    writeIndex(wiki, "retry/index.md", "retry", {
      focus: "retry backoff timeout strategy",
      covers: ["retry", "backoff", "timeout"],
    });
    writeLeaf(wiki, "retry/c.md", "c", {
      focus: "retry backoff cache eviction", // dual-signal
      covers: ["retry", "backoff", "cache"], tags: ["retry", "cache"],
    });
    await runSoftDagParents(wiki);
    const first = readFileSync(join(wiki, "retry", "c.md"), "utf8");
    // Reset parents to run again cleanly.
    const parsed = parseFrontmatter(first, "tmp");
    parsed.data.parents = ["index.md"];
    writeFileSync(join(wiki, "retry", "c.md"), renderFrontmatter(parsed.data, parsed.body), "utf8");
    await runSoftDagParents(wiki);
    const second = readFileSync(join(wiki, "retry", "c.md"), "utf8");
    assert.equal(first, second, "repeated runs must produce byte-identical frontmatter");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: preserves primary parent at parents[0]", async () => {
  const wiki = tmpWiki("primary");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "alpha/index.md", "alpha", {
      focus: "alpha topic one two",
      covers: ["alpha", "one"],
    });
    writeLeaf(wiki, "alpha/leaf.md", "leaf", {
      focus: "alpha topic one two",
      covers: ["alpha", "one"],
      tags: ["alpha"],
    });
    writeIndex(wiki, "beta/index.md", "beta", {
      focus: "beta topic alpha shared",
      covers: ["beta", "alpha"],
    });
    writeLeaf(wiki, "beta/sibling.md", "sibling", {
      focus: "beta topic alpha",
      covers: ["beta", "alpha"],
      tags: ["beta"],
    });
    const r = await runSoftDagParents(wiki);
    assert.equal(r.leavesProcessed, 2);
    const leaf = readLeaf(join(wiki, "alpha", "leaf.md"));
    assert.ok(Array.isArray(leaf.data.parents));
    // Primary is always first; for a depth-1 leaf that's "index.md".
    assert.equal(
      leaf.data.parents[0],
      "index.md",
      `parents[0] must be the primary relative path; got ${JSON.stringify(leaf.data.parents)}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: appends a soft-claimed leaf into the claimed parent's entries[]", async () => {
  const wiki = tmpWiki("apply");
  try {
    // Build a wiki where a leaf claims a soft parent directly via
    // parents[], then run applySoftParentEntries and assert the
    // target index.md now has the leaf in its entries[].
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", {
      entries: [
        { id: "redis-cache", file: "redis-cache.md", type: "primary", focus: "redis cache" },
      ],
    });
    writeLeaf(wiki, "cache/redis-cache.md", "redis-cache", {
      focus: "redis cache eviction", covers: ["redis", "cache"], tags: ["cache"],
    });
    writeIndex(wiki, "retry/index.md", "retry", {
      entries: [
        { id: "cached-retry", file: "cached-retry.md", type: "primary", focus: "retry cache" },
      ],
    });
    writeLeaf(wiki, "retry/cached-retry.md", "cached-retry", {
      focus: "retry cache backoff",
      covers: ["retry", "cache"],
      tags: ["retry", "cache"],
      // Soft-claim cache/ as a secondary parent (primary is retry/).
      parents: ["index.md", "../cache/index.md"],
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(r.indicesTouched, 1);
    assert.equal(r.softEntriesAdded, 1);
    const cacheIdx = readLeaf(join(wiki, "cache", "index.md"));
    const ids = cacheIdx.data.entries.map((e) => e.id);
    assert.ok(
      ids.includes("cached-retry"),
      `cache/index.md entries[] must now include cached-retry; got ${JSON.stringify(ids)}`,
    );
    // The appended record's file path must be relative to the target
    // index dir (cache/), NOT the leaf's own directory (retry/).
    const appended = cacheIdx.data.entries.find((e) => e.id === "cached-retry");
    // OS-native separators to match `indices.mjs::rebuildIndex`
    // convention (no soft-DAG-specific POSIX normalisation — that
    // would mix `/` into a Windows-native entries[] array and break
    // link rendering).
    const { relative: rel } = await import("node:path");
    assert.equal(
      appended.file,
      rel(join(wiki, "cache"), join(wiki, "retry", "cached-retry.md")),
      `file path must resolve from cache/ to retry/cached-retry.md via OS-native relative`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: idempotent — running twice leaves the entry exactly once", async () => {
  const wiki = tmpWiki("idempotent");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", { entries: [] });
    writeIndex(wiki, "retry/index.md", "retry", { entries: [] });
    writeLeaf(wiki, "retry/dual.md", "dual", {
      parents: ["index.md", "../cache/index.md"],
    });
    applySoftParentEntries(wiki);
    const once = readLeaf(join(wiki, "cache", "index.md"));
    applySoftParentEntries(wiki);
    const twice = readLeaf(join(wiki, "cache", "index.md"));
    assert.deepEqual(
      once.data.entries,
      twice.data.entries,
      "second apply must produce byte-identical entries[]",
    );
    assert.equal(
      once.data.entries.filter((e) => e.id === "dual").length,
      1,
      "a soft-claimed leaf must appear exactly once per target",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: ignores leaves with only a primary parent", () => {
  const wiki = tmpWiki("primary-only");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", { entries: [] });
    writeLeaf(wiki, "cache/single.md", "single", {
      parents: ["index.md"], // no soft parents
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(r.indicesTouched, 0);
    assert.equal(r.softEntriesAdded, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: rejects path-traversal parents[] entries (defense-in-depth)", () => {
  const wiki = tmpWiki("traversal");
  // Plant a sibling `index.md` OUTSIDE the wiki that a hostile leaf
  // might try to mutate via ..-traversal. The guard must keep the
  // propagation pass from touching it — the external file's bytes
  // must be unchanged after the pass runs.
  const external = join(wiki, "..", `skill-llm-wiki-softdag-external-${Date.now()}`);
  mkdirSync(external, { recursive: true });
  const externalIndex = join(external, "index.md");
  writeFileSync(
    externalIndex,
    renderFrontmatter(
      { id: "external-target", type: "index", entries: [] },
      "\n# external\n",
    ),
    "utf8",
  );
  const externalBefore = readFileSync(externalIndex, "utf8");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "legit/index.md", "legit", { entries: [] });
    writeLeaf(wiki, "legit/hostile.md", "hostile", {
      // Traversal attempt: a carefully-tuned chain of ../ takes us
      // one level above wikiRoot and into the external dir.
      parents: ["index.md", `../../${basename(external)}/index.md`],
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(
      r.softEntriesAdded,
      0,
      "traversal attempt must not produce any soft-entry writes",
    );
    const externalAfter = readFileSync(externalIndex, "utf8");
    assert.equal(
      externalAfter,
      externalBefore,
      "external index.md must be byte-unchanged after the guard rejects the traversal",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: rejects symlinked index.md pointing outside wikiRoot", () => {
  const wiki = tmpWiki("symlink");
  // External sibling whose index.md a symlink inside the wiki
  // points at. The lexical guard alone wouldn't catch this because
  // the in-wiki path sits under wikiRoot — only `realpathSync`
  // containment reveals the escape.
  const external = join(wiki, "..", `skill-llm-wiki-softdag-ext-${Date.now()}`);
  mkdirSync(external, { recursive: true });
  const externalIndex = join(external, "index.md");
  writeFileSync(
    externalIndex,
    renderFrontmatter(
      { id: "external-target", type: "index", entries: [] },
      "\n# external\n",
    ),
    "utf8",
  );
  const externalBefore = readFileSync(externalIndex, "utf8");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    mkdirSync(join(wiki, "trap"), { recursive: true });
    // A symlinked index.md inside the wiki pointing at the external
    // target. lexical containment holds (wiki/trap/index.md sits
    // under wikiRoot) but realpath resolves out.
    symlinkSync(externalIndex, join(wiki, "trap", "index.md"));
    writeIndex(wiki, "legit/index.md", "legit", { entries: [] });
    writeLeaf(wiki, "legit/hostile.md", "hostile", {
      parents: ["index.md", "../trap/index.md"],
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(
      r.softEntriesAdded,
      0,
      "symlinked-out index.md must be rejected by realpath guard",
    );
    const externalAfter = readFileSync(externalIndex, "utf8");
    assert.equal(
      externalAfter,
      externalBefore,
      "external target must be byte-unchanged after symlink guard rejects the claim",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: refuses to mutate a file that isn't a managed index (no type: index)", () => {
  const wiki = tmpWiki("non-index");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // `junk/index.md` exists under wikiRoot and has the right
    // filename, but its frontmatter lacks `type: index` — it's a
    // random markdown file that happens to share the name. The
    // sanity check must refuse to append `entries:` into it so
    // arbitrary user content under wikiRoot isn't corrupted by
    // soft-DAG propagation.
    mkdirSync(join(wiki, "junk"), { recursive: true });
    const junkPath = join(wiki, "junk", "index.md");
    writeFileSync(
      junkPath,
      "---\nid: random-notes\n---\n\n# Random notes, not a managed index\n",
      "utf8",
    );
    const junkBefore = readFileSync(junkPath, "utf8");
    writeLeaf(wiki, "junk-sibling.md", "leaf", {
      parents: ["index.md", "junk/index.md"],
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(r.softEntriesAdded, 0, "non-index target must not be touched");
    const junkAfter = readFileSync(junkPath, "utf8");
    assert.equal(
      junkAfter,
      junkBefore,
      "non-index target must be byte-unchanged",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: tolerates malformed parents[] entries without crashing", () => {
  const wiki = tmpWiki("malformed");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", { entries: [] });
    writeLeaf(wiki, "cache/weird.md", "weird", {
      parents: [
        "index.md",
        "", // empty string
        42, // non-string
        "/absolute/path/index.md", // absolute path — rejected
        "../missing-dir/index.md", // points at non-existent target
        "not-an-index.md", // not named index.md — rejected
      ],
    });
    const r = applySoftParentEntries(wiki);
    // No crashes; zero entries added (all malformed).
    assert.equal(r.indicesTouched, 0);
    assert.equal(r.softEntriesAdded, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents: handles CRLF-fence leaves (Windows editor output)", async () => {
  const wiki = tmpWiki("crlf");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", {
      focus: "cache eviction lru",
      covers: ["cache", "eviction"],
    });
    // Write a CRLF-fenced leaf directly — simulate a Windows editor's
    // line endings on the frontmatter. `parseFrontmatter` alone won't
    // recognise the fence; only `readFrontmatterStreaming`'s CRLF-aware
    // path will capture it.
    const crlfLeaf = join(wiki, "cache", "redis-crlf.md");
    const crlfFrontmatter =
      "---\r\nid: redis-crlf\r\ntype: primary\r\nfocus: redis cache eviction\r\n" +
      "covers:\r\n  - redis\r\n  - cache\r\ntags:\r\n  - cache\r\n" +
      "parents:\r\n  - index.md\r\n---\r\n\r\n# redis-crlf\r\n";
    writeFileSync(crlfLeaf, crlfFrontmatter, "utf8");
    const r = await runSoftDagParents(wiki);
    // The CRLF leaf must be in the perLeaf map — i.e., it was
    // recognised as a routable leaf (has id) and processed.
    assert.ok(
      r.perLeaf.has(crlfLeaf),
      `CRLF-fence leaf must be visible to soft-DAG synthesis; got keys ${JSON.stringify(Array.from(r.perLeaf.keys()))}`,
    );
    // Boundary integrity: the rewrite must not leave a "\r\n\n",
    // "\n\r\n", or stray "\r" bytes mixed in — that would happen if
    // `renderFrontmatter` prepended a separator newline to a
    // CRLF-leading body. The wider codebase is LF-only on write,
    // so the re-serialised leaf must be entirely LF.
    const rewritten = readFileSync(crlfLeaf, "utf8");
    assert.ok(
      !rewritten.includes("\r"),
      `rewritten leaf must be LF-only (no stray \\r); got ${JSON.stringify(rewritten.slice(0, 200))}`,
    );
    // Body content preserved modulo EOL normalisation: the heading
    // line survives (leading `# redis-crlf` text).
    assert.ok(
      rewritten.includes("# redis-crlf"),
      "body content must survive the rewrite",
    );
    // Close fence cleanly terminates the frontmatter (no mid-content
    // dashes from a botched rewrite): `---\n` appears as a close
    // fence at most once in the serialised file, and the content
    // starts on the very next line.
    assert.ok(
      /---\n# redis-crlf/.test(rewritten),
      `close fence must sit directly before content on LF boundary; got ${JSON.stringify(rewritten.slice(-80))}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applySoftParentEntries: stats reflect ACTUAL writes, not planned appends", () => {
  const wiki = tmpWiki("stats");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Pre-seed the target index with the leaf's id so the soft-claim
    // de-dupes at apply time. Stats must report zero touched /
    // zero added — pre-round-2 they counted the planned append.
    writeIndex(wiki, "cache/index.md", "cache", {
      entries: [
        { id: "dual", file: "../retry/dual.md", type: "primary", focus: "" },
      ],
    });
    writeIndex(wiki, "retry/index.md", "retry", { entries: [] });
    writeLeaf(wiki, "retry/dual.md", "dual", {
      parents: ["index.md", "../cache/index.md"],
    });
    const r = applySoftParentEntries(wiki);
    assert.equal(r.indicesTouched, 0, "already-deduped claim must not count as a touched index");
    assert.equal(r.softEntriesAdded, 0, "already-deduped claim must not count as an added entry");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runSoftDagParents + applySoftParentEntries: end-to-end synthesis + propagation", async () => {
  const wiki = tmpWiki("e2e");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cache/index.md", "cache", {
      focus: "cache eviction lru ttl",
      covers: ["cache", "eviction"],
      entries: [],
    });
    writeLeaf(wiki, "cache/redis.md", "redis", {
      focus: "redis cache eviction lru",
      covers: ["redis", "cache", "eviction"],
      tags: ["cache"],
    });
    writeLeaf(wiki, "cache/memcached.md", "memcached", {
      focus: "memcached cache slab lru",
      covers: ["memcached", "cache", "slab"],
      tags: ["cache"],
    });
    writeIndex(wiki, "retry/index.md", "retry", {
      focus: "retry backoff timeout",
      covers: ["retry", "backoff"],
      entries: [],
    });
    writeLeaf(wiki, "retry/http.md", "http", {
      focus: "http retry backoff budget",
      covers: ["http", "retry", "backoff"],
      tags: ["retry"],
    });
    writeLeaf(wiki, "retry/cache-aware-retry.md", "cache-aware-retry", {
      focus: "cache retry backoff eviction lru",
      covers: ["cache", "retry", "backoff", "eviction"],
      tags: ["retry", "cache"],
    });
    const synth = await runSoftDagParents(wiki);
    assert.ok(synth.leavesProcessed >= 4);
    const propagate = applySoftParentEntries(wiki);
    // The cross-topic leaf should have claimed the non-primary
    // category and made the round-trip into that category's index.
    const cacheIdx = readLeaf(join(wiki, "cache", "index.md"));
    const ids = cacheIdx.data.entries.map((e) => e.id);
    assert.ok(
      ids.includes("cache-aware-retry"),
      `cache-aware-retry must propagate into cache/ entries[]; got ${JSON.stringify(ids)}`,
    );
    assert.ok(
      propagate.indicesTouched >= 1,
      `propagation must touch at least one index`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
