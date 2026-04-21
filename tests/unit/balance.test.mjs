// balance.test.mjs — unit tests for the post-convergence rebalance
// phase. Covers the pure helpers (computeDepthMap, computeFanoutStats,
// detectFanoutOverload, detectDepthOverage) + the mutating
// applyBalanceFlatten + the runBalance fixed-point loop.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  applyBalanceFlatten,
  computeDepthMap,
  computeFanoutStats,
  detectDepthOverage,
  detectFanoutOverload,
  FANOUT_OVERLOAD_MULTIPLIER,
  getMaxDepth,
  runBalance,
} from "../../scripts/lib/balance.mjs";
import { parseFrontmatter, renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";

process.env.LLM_WIKI_MOCK_TIER1 = "1";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-balance-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeIndex(wikiRoot, relPath, id, extra = {}) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const isRoot = relPath === "index.md";
  const data = {
    id,
    type: "index",
    depth_role: extra.depth_role ?? (isRoot ? "category" : "subcategory"),
    focus: extra.focus ?? `${id} category`,
    parents: extra.parents ?? (isRoot ? [] : ["../index.md"]),
    tags: extra.tags ?? ["default"],
  };
  writeFileSync(full, renderFrontmatter(data, `\n# ${id}\n`), "utf8");
  return { path: full, data };
}

function writeLeaf(wikiRoot, relPath, id, extra = {}) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: extra.focus ?? `${id} focus`,
    parents: extra.parents ?? ["index.md"],
    covers: extra.covers ?? [`${id} cover`],
    tags: extra.tags ?? ["default"],
    activation: { keyword_matches: extra.kw ?? [id] },
  };
  writeFileSync(full, renderFrontmatter(data, `\n# ${id}\n`), "utf8");
  return { path: full, data };
}

test("computeDepthMap: root is 0, children are 1, grandchildren are 2", () => {
  const wiki = tmpWiki("depth-map");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "cat-a/index.md", "cat-a");
    writeIndex(wiki, "cat-a/sub/index.md", "sub");
    writeIndex(wiki, "cat-b/index.md", "cat-b");
    const depths = computeDepthMap(wiki);
    assert.equal(depths.get(wiki), 0);
    assert.equal(depths.get(join(wiki, "cat-a")), 1);
    assert.equal(depths.get(join(wiki, "cat-a", "sub")), 2);
    assert.equal(depths.get(join(wiki, "cat-b")), 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("computeDepthMap: includes index-less directories (pre-Phase-5 category dirs)", () => {
  const wiki = tmpWiki("depth-map-index-less");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Two fixtures:
    //  - `real/` with index.md (normal, post-bootstrap shape).
    //  - `draft-category/` with leaves but NO index.md (simulating
    //    the Phase-3 draft state: the category dir was mkdir'd by
    //    draftCategory, leaves were written, but bootstrapIndexStubs
    //    hasn't run yet). Balance runs at Phase 4.3 in this state.
    //    The dir MUST appear in the depth map so the fanout + depth
    //    passes can see it; a previous draft of computeDepthMap
    //    required index.md and silently hid it.
    writeIndex(wiki, "real/index.md", "real");
    writeIndex(wiki, "real/child/index.md", "child");
    mkdirSync(join(wiki, "draft-category"), { recursive: true });
    writeLeaf(wiki, "draft-category/leaf-a.md", "leaf-a");
    writeLeaf(wiki, "draft-category/leaf-b.md", "leaf-b");
    const depths = computeDepthMap(wiki);
    assert.equal(depths.get(wiki), 0);
    assert.equal(depths.get(join(wiki, "real")), 1);
    assert.equal(depths.get(join(wiki, "real", "child")), 2);
    assert.equal(
      depths.get(join(wiki, "draft-category")),
      1,
      "index-less draft-category must be present in depth map",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("getMaxDepth: returns the deepest directory's depth", () => {
  const wiki = tmpWiki("max-depth");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "a/index.md", "a");
    writeIndex(wiki, "a/b/index.md", "b");
    writeIndex(wiki, "a/b/c/index.md", "c");
    assert.equal(getMaxDepth(wiki), 3);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("computeFanoutStats: counts leaves + subdirs per directory (and returns leafCounts)", () => {
  const wiki = tmpWiki("fanout");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    for (let i = 0; i < 7; i++) writeLeaf(wiki, `leaf-${i}.md`, `leaf-${i}`);
    writeIndex(wiki, "sub/index.md", "sub");
    writeLeaf(wiki, "sub/child.md", "child");
    const stats = computeFanoutStats(wiki);
    // Root: 7 leaves + 1 subdir = 8 combined, 7 leaves
    assert.equal(stats.perDir.get(wiki), 8);
    assert.equal(stats.leafCounts.get(wiki), 7);
    // sub: 1 leaf + 0 subdirs = 1 combined, 1 leaf
    assert.equal(stats.perDir.get(join(wiki, "sub")), 1);
    assert.equal(stats.leafCounts.get(join(wiki, "sub")), 1);
    assert.equal(stats.maxFanout, 8);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectFanoutOverload: returns only dirs with children > target × 1.5", () => {
  const wiki = tmpWiki("overload");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Root: 10 leaves — at target=6 the threshold is 9, so root IS overfull.
    for (let i = 0; i < 10; i++) writeLeaf(wiki, `leaf-${i}.md`, `leaf-${i}`);
    // sub: 7 leaves — at target=6 the threshold is 9, so sub is NOT overfull.
    writeIndex(wiki, "sub/index.md", "sub");
    for (let i = 0; i < 7; i++) writeLeaf(wiki, `sub/item-${i}.md`, `item-${i}`);

    const overfull = detectFanoutOverload(wiki, 6);
    assert.equal(overfull.length, 1, "only root should be overfull at target=6");
    assert.equal(overfull[0], wiki);

    // At target=4, threshold is 6; sub (7 children) + root (11) are both overfull.
    const overfullTight = detectFanoutOverload(wiki, 4);
    assert.equal(overfullTight.length, 2);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectFanoutOverload: ignores dirs overfull only via subdir count (leaf metric)", () => {
  const wiki = tmpWiki("overload-subdir-only");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Root: 2 leaves + 10 subdirs = 12 routing-items. At target=6 the
    // threshold is 9 so the pre-fix metric (leaves+subdirs) would flag
    // it. Under the leaf-movable metric, root has only 2 leaves, well
    // below threshold — rebalance has nothing to extract here, so the
    // candidate is correctly ignored.
    writeLeaf(wiki, "one.md", "one");
    writeLeaf(wiki, "two.md", "two");
    for (let i = 0; i < 10; i++) writeIndex(wiki, `sub-${i}/index.md`, `sub-${i}`);
    const overfull = detectFanoutOverload(wiki, 6);
    assert.equal(
      overfull.length,
      0,
      "root has 10 subdirs but only 2 leaves — un-actionable, not overfull",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectFanoutOverload: nested paths sort by POSIX-normalised key (cross-platform stable)", () => {
  const wiki = tmpWiki("overload-sort-order");
  try {
    // Two sibling subdirs that each hold 10 leaves. Lex-order must be
    // `a-first` < `b-second` regardless of host platform's path
    // separator. Windows uses `\`, POSIX uses `/`. Normalised via
    // `posixSortKey` the `relative` strings become `a-first` and
    // `b-second`, both separator-free in this fixture — so this
    // test pins the ordering at the API level. A deeper fixture
    // (nested `x/y` vs `x/y-early`) is still covered implicitly by
    // the POSIX-normalisation since `x/y` < `x/y-early` under both
    // separator conventions once normalised.
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "a-first/index.md", "a-first");
    for (let i = 0; i < 10; i++) writeLeaf(wiki, `a-first/leaf-${i}.md`, `a-first-leaf-${i}`);
    writeIndex(wiki, "b-second/index.md", "b-second");
    for (let i = 0; i < 10; i++) writeLeaf(wiki, `b-second/leaf-${i}.md`, `b-second-leaf-${i}`);
    const overfull = detectFanoutOverload(wiki, 6);
    assert.equal(overfull[0], join(wiki, "a-first"));
    assert.equal(overfull[1], join(wiki, "b-second"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectFanoutOverload: honours nestedParents exclusion", () => {
  const wiki = tmpWiki("overload-nested");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    for (let i = 0; i < 12; i++) writeLeaf(wiki, `leaf-${i}.md`, `leaf-${i}`);
    const overfull = detectFanoutOverload(wiki, 6, new Set([wiki]));
    assert.equal(
      overfull.length,
      0,
      "nestedParents entries must be excluded even when overfull",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("detectDepthOverage: returns only single-child passthroughs beyond maxDepth", () => {
  const wiki = tmpWiki("depth-overage");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Branch 1: depth 3 passthrough (a > b > c) where c has one child leaf.
    writeIndex(wiki, "a/index.md", "a");
    writeIndex(wiki, "a/b/index.md", "b");
    writeIndex(wiki, "a/b/c/index.md", "c");
    writeLeaf(wiki, "a/b/c/only.md", "only");
    // Branch 2: depth 3 with multiple children — NOT a passthrough.
    writeIndex(wiki, "x/index.md", "x");
    writeIndex(wiki, "x/y/index.md", "y");
    writeIndex(wiki, "x/y/z/index.md", "z");
    writeLeaf(wiki, "x/y/z/first.md", "first");
    writeLeaf(wiki, "x/y/z/second.md", "second");

    // At maxDepth=1, /a/b/ (depth 2, single subdir, no leaves) is a
    // passthrough and exceeds target. /a/b/c/ (depth 3) is NOT a
    // passthrough because it holds a leaf. /x/y/ (depth 2, 1 subdir, 0
    // leaves) is also a passthrough.
    const over = detectDepthOverage(wiki, 1);
    // a/b and x/y are both depth 2 > maxDepth 1 AND single-child
    // passthroughs (one subdir, zero leaves).
    assert.ok(
      over.includes(join(wiki, "a", "b")),
      `expected a/b in ${JSON.stringify(over)}`,
    );
    assert.ok(
      over.includes(join(wiki, "x", "y")),
      `expected x/y in ${JSON.stringify(over)}`,
    );
    // Lex order: a/b < x/y.
    assert.equal(over[0], join(wiki, "a", "b"));
    assert.equal(over[1], join(wiki, "x", "y"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyBalanceFlatten: promotes single child and preserves unchanged parents[] references", () => {
  const wiki = tmpWiki("flatten");
  try {
    // parent/pass/target/leaf.md — flatten `pass` so target moves up
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "pass/index.md", "pass");
    writeIndex(wiki, "pass/target/index.md", "target");
    writeLeaf(wiki, "pass/target/leaf.md", "leaf", {
      parents: ["index.md"],
    });
    // Plant a descendant deeper so we can verify parents[] rewrite
    writeIndex(wiki, "pass/target/sub/index.md", "sub", {
      parents: ["../index.md"],
    });
    writeLeaf(wiki, "pass/target/sub/inner.md", "inner", {
      parents: ["index.md"],
    });

    const result = applyBalanceFlatten(wiki, join(wiki, "pass"));
    assert.equal(
      result.promoted,
      join(wiki, "target"),
      "target should be promoted up one level",
    );
    assert.equal(
      result.removed,
      join(wiki, "pass"),
      "pass should be removed",
    );
    assert.ok(!existsSync(join(wiki, "pass")), "pass dir must be gone");
    assert.ok(existsSync(join(wiki, "target")), "target dir must exist at new location");
    assert.ok(existsSync(join(wiki, "target", "leaf.md")));
    assert.ok(existsSync(join(wiki, "target", "sub", "inner.md")));

    // parents[] stays "index.md" for leaves directly under target —
    // those referenced their own index, which hasn't moved RELATIVE
    // to them. Only descendants whose parents[] traversed through
    // `pass/..` need to drop a "../" — none in this fixture.
    const leaf = parseFrontmatter(
      readFileSync(join(wiki, "target", "leaf.md"), "utf8"),
      "leaf.md",
    );
    assert.deepEqual(leaf.data.parents, ["index.md"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyBalanceFlatten: refuses to flatten non-passthrough", () => {
  const wiki = tmpWiki("flatten-refuse");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "multi/index.md", "multi");
    writeLeaf(wiki, "multi/a.md", "a");
    writeLeaf(wiki, "multi/b.md", "b");
    assert.throws(
      () => applyBalanceFlatten(wiki, join(wiki, "multi")),
      /not a single-child passthrough/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyBalanceFlatten: refuses to rmSync a passthrough with stray non-listChildren content", () => {
  const wiki = tmpWiki("flatten-stray");
  try {
    // Build a pure single-child passthrough as detectDepthOverage sees
    // it: listChildren returns {leaves: 0, subdirs: 1}. But plant a
    // stray non-.md file alongside — e.g., an asset left over from a
    // manual edit or a README.txt. listChildren ignores it, but a
    // naive `rmSync(passthroughDir, {recursive: true})` would silently
    // wipe it out. The defensive emptiness check must catch this.
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "pass/index.md", "pass");
    writeIndex(wiki, "pass/child/index.md", "child");
    writeLeaf(wiki, "pass/child/leaf.md", "leaf");
    writeFileSync(join(wiki, "pass", "unexpected-asset.bin"), "binary-content");
    assert.throws(
      () => applyBalanceFlatten(wiki, join(wiki, "pass")),
      /unexpected non-listChildren content/,
      "must refuse rather than silently delete unexpected content",
    );
    // The refusal must happen BEFORE any filesystem mutation — the
    // stray file is still there, the child is still at its original
    // path (not promoted), and the passthrough index.md is intact.
    assert.ok(
      existsSync(join(wiki, "pass", "unexpected-asset.bin")),
      "stray file must survive the refusal",
    );
    assert.ok(
      existsSync(join(wiki, "pass", "child", "index.md")),
      "child must NOT have been promoted — preflight refuses before any mutation",
    );
    assert.ok(
      existsSync(join(wiki, "pass", "index.md")),
      "passthrough index.md must still exist — preflight refuses before rmSync",
    );
    assert.ok(
      !existsSync(join(wiki, "child")),
      "child must NOT have been moved to grandparent path",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyBalanceFlatten: tolerates dot-prefixed entries (noise), cleans them before flatten", () => {
  const wiki = tmpWiki("flatten-dotfile");
  try {
    // Pure passthrough with a `.DS_Store` alongside. The rest of the
    // pipeline (`listChildren`, `buildWikiForbiddenIndex`,
    // `collectEntryPaths`) all skip dot-prefixed entries under the
    // same blanket rule, so a `.DS_Store` is non-routable noise; the
    // flatten must NOT refuse on it. Instead the preflight cleans
    // dotfiles before the rename so rmdirSync succeeds.
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "pass/index.md", "pass");
    writeIndex(wiki, "pass/child/index.md", "child");
    writeLeaf(wiki, "pass/child/leaf.md", "leaf");
    writeFileSync(join(wiki, "pass", ".DS_Store"), "mac-noise");
    const r = applyBalanceFlatten(wiki, join(wiki, "pass"));
    assert.equal(r.promoted, join(wiki, "child"));
    assert.equal(r.removed, join(wiki, "pass"));
    // The passthrough is gone (rmdir succeeded) and the dotfile was
    // cleaned up with it.
    assert.ok(!existsSync(join(wiki, "pass")), "passthrough must be removed");
    assert.ok(
      existsSync(join(wiki, "child", "index.md")),
      "child subdir must be promoted",
    );
    assert.ok(
      existsSync(join(wiki, "child", "leaf.md")),
      "leaf must follow the promoted subdir",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runBalance: no-op when neither flag is set", async () => {
  const wiki = tmpWiki("noop");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    for (let i = 0; i < 20; i++) writeLeaf(wiki, `leaf-${i}.md`, `leaf-${i}`);
    const r = await runBalance(wiki, {}); // no flags
    assert.equal(r.iterations, 0);
    assert.equal(r.applied.length, 0);
    assert.equal(r.converged, true);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runBalance: fanout-only pass sub-clusters an overfull directory", async () => {
  const wiki = tmpWiki("fanout-only");
  try {
    writeIndex(wiki, "index.md", basename(wiki));
    // Seven leaves with two clear themes (cache vs. retry) under a
    // single parent — at target=3 the root is overfull (7 > 4.5) and
    // the cluster detector will carve out at least one theme.
    const themes = [
      ["redis-cache", "cache", "redis eviction lru"],
      ["memcached-cache", "cache", "memcached slab lru"],
      ["varnish-cache", "cache", "varnish edge vcl"],
      ["http-retry", "retry", "http retry budget"],
      ["rpc-retry", "retry", "rpc retry deadline"],
      ["circuit-breaker", "retry", "circuit breaker half-open"],
      ["orphan", "other", "unrelated standalone"],
    ];
    for (const [id, tag, focus] of themes) {
      writeLeaf(wiki, `${id}.md`, id, {
        tags: [tag],
        focus,
        kw: [tag, id.split("-")[0]],
      });
    }
    const r = await runBalance(wiki, {
      fanoutTarget: 3,
    });
    assert.ok(r.iterations >= 1, "should iterate at least once");
    assert.ok(r.applied.length >= 1, "should apply at least one sub-cluster");
    const hasSubcluster = r.applied.some((a) => a.operator === "BALANCE_SUBCLUSTER");
    assert.ok(hasSubcluster, "at least one BALANCE_SUBCLUSTER must fire");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runBalance: depth-only pass flattens a passthrough chain", async () => {
  const wiki = tmpWiki("depth-only");
  try {
    // Build a depth-3 tree where `a/b/` is a passthrough: it holds
    // exactly one subdir (`c/`) and zero leaves. At maxDepth=1 it
    // exceeds the allowed depth (b is at depth 2) and qualifies for
    // flattening. Using maxDepth=1 — the in-range minimum per the
    // intent validator — keeps this test exercising the SAME runtime
    // value that the CLI would produce on `--max-depth 1`.
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "a/index.md", "a");
    writeIndex(wiki, "a/b/index.md", "b");
    writeIndex(wiki, "a/b/c/index.md", "c");
    writeLeaf(wiki, "a/b/c/leaf.md", "leaf");
    const r = await runBalance(wiki, {
      maxDepth: 1,
    });
    assert.ok(r.iterations >= 1);
    const flattened = r.applied.some((a) => a.operator === "BALANCE_FLATTEN");
    assert.ok(flattened, "at least one BALANCE_FLATTEN must fire");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runBalance: fanout pass skips un-actionable overfull[0], acts on a later candidate", async () => {
  const wiki = tmpWiki("fanout-skip-first");
  try {
    // Two sibling subcategories, both above the leaf-count threshold
    // at target=3 (threshold=4.5, so any dir with ≥ 5 leaves qualifies).
    //
    //   /diverse/   — 5 unrelated leaves with no coherent cluster.
    //                Lex-smallest (overfull[0]).
    //                detectClusters will find no partition above the
    //                shape-score floor and return [] — un-actionable.
    //   /themed/    — 7 leaves with two clean themes.
    //                detectClusters returns a live proposal.
    //
    // With the pre-fix behaviour, runBalance picked overfull[0] only,
    // saw no live cluster, and declared convergence despite /themed/
    // being right there. The fix iterates through overfull candidates
    // until one yields a live proposal. Assert at least one
    // BALANCE_SUBCLUSTER fires under /themed/.
    writeIndex(wiki, "index.md", basename(wiki));
    writeIndex(wiki, "diverse/index.md", "diverse");
    const diverseLeaves = [
      ["diverse/astronomy.md", "astronomy", "orbital mechanics telescope"],
      ["diverse/baking.md", "baking", "sourdough hydration levain"],
      ["diverse/cryptography.md", "cryptography", "elliptic curve signature"],
      ["diverse/dancing.md", "dancing", "ballet pointe barre"],
      ["diverse/etymology.md", "etymology", "indo-european root derivation"],
    ];
    for (const [path, id, focus] of diverseLeaves) {
      writeLeaf(wiki, path, id, {
        tags: [id],
        focus,
        kw: [id, focus.split(" ")[0]],
      });
    }
    writeIndex(wiki, "themed/index.md", "themed");
    const themedLeaves = [
      ["themed/redis-cache.md", "redis-cache", "cache", "redis eviction lru"],
      ["themed/memcached-cache.md", "memcached-cache", "cache", "memcached slab lru"],
      ["themed/varnish-cache.md", "varnish-cache", "cache", "varnish edge vcl"],
      ["themed/http-retry.md", "http-retry", "retry", "http retry budget"],
      ["themed/rpc-retry.md", "rpc-retry", "retry", "rpc retry deadline"],
      ["themed/circuit-breaker.md", "circuit-breaker", "retry", "circuit breaker half-open"],
      ["themed/orphan.md", "orphan", "other", "unrelated standalone"],
    ];
    for (const [path, id, tag, focus] of themedLeaves) {
      writeLeaf(wiki, path, id, {
        tags: [tag],
        focus,
        kw: [tag, id.split("-")[0]],
      });
    }
    const r = await runBalance(wiki, { fanoutTarget: 3 });
    const subclustered = r.applied.filter((a) => a.operator === "BALANCE_SUBCLUSTER");
    assert.ok(
      subclustered.length >= 1,
      `expected at least one BALANCE_SUBCLUSTER despite diverse/ being un-actionable; got ${JSON.stringify(r.applied)}`,
    );
    // Every sub-cluster must have come out of /themed/, not /diverse/.
    // Use `sources[]` (absolute paths with OS-native separators) as the
    // ground-truth — the `describe` string rendering uses OS-native
    // separators on Windows (`themed\\...`) which a bare `"themed/"`
    // substring match would miss. Checking each source starts with the
    // themed parent path is platform-agnostic.
    const themedDir = join(wiki, "themed");
    const diverseDir = join(wiki, "diverse");
    for (const app of subclustered) {
      for (const src of app.sources) {
        assert.ok(
          src.startsWith(themedDir),
          `sub-cluster source must be under themed/, got: ${src}`,
        );
        assert.ok(
          !src.startsWith(diverseDir),
          `sub-cluster source must NOT be under diverse/, got: ${src}`,
        );
      }
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("FANOUT_OVERLOAD_MULTIPLIER is the documented 1.5 slack", () => {
  // Pin the multiplier constant so future tuning doesn't silently
  // shift the rebalance trigger and surprise consumers.
  assert.equal(FANOUT_OVERLOAD_MULTIPLIER, 1.5);
});
