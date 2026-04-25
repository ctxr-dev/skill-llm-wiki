// join.test.mjs — unit coverage for the 11-phase join pipeline.
//
// Most tests in this file build small source-wiki fixtures by hand
// (raw frontmatter + body writes via writeFm) and exercise
// individual phase helpers (`ingestWiki`, `validateSources`,
// `planUnion`, ...) in isolation — the unit scope avoids the full
// `build` CLI roundtrip wherever possible because the full
// end-to-end pipeline is covered by the e2e build suite. Scope of
// the per-helper tests:
//   - ingestWiki: reads frontmatter + body, skips dotfiles / plain md
//   - validateSources: per-source findings aggregated
//   - planUnion: sourceWiki tag preserved
//   - resolveIdCollisions: all three policies (namespace default,
//     merge when frontmatter compatible, namespace-fallback when not,
//     ask throws JOIN-COLLISION-ASK)
//   - mergeCategoriesWithSameFocus: detection only; actual fold is
//     a convergence-phase concern
//   - rewireReferences: links/overlays rewritten, parents left alone
//   - materialisePlan: leaves + indices land at expected paths;
//     dangling-category indices for fully-merged-away directories
//     are dropped
//
// The single exception is `runJoin: onPhase fires DURING execution`
// (the in-process streaming-contract test added in PR #19). That
// one test deliberately uses `runCliBuild()` + `spawnSync` to
// produce two real source wikis with `.llmwiki/git/` markers
// because the contract under test (onPhase fires before runJoin's
// promise resolves) requires real ingest-able sources. It sets
// `LLM_WIKI_MOCK_TIER1=1` + `LLM_WIKI_SKIP_CLUSTER_NEST=1` on the
// parent process for the runJoin call so the convergence path
// stays hermetic / offline / fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { renderFrontmatter, parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import {
  DEFAULT_COLLISION_POLICY,
  VALID_COLLISION_POLICIES,
  ingestWiki,
  materialisePlan,
  mergeCategoriesWithSameFocus,
  planUnion,
  resolveIdCollisions,
  rewireReferences,
  runJoin,
  validateSources,
} from "../../scripts/lib/join.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);
function runCliBuild(src) {
  // Pin `--quality-mode deterministic` so the subprocess can never
  // enqueue Tier 2 work (which would exit-7 with NEEDS_TIER2 under
  // hermetic test conditions). The default `tiered-fast` mode can
  // still escalate even with `LLM_WIKI_MOCK_TIER1=1` set; only
  // deterministic mode resolves every mid-band similarity decision
  // algorithmically and stays self-contained.
  return spawnSync(
    "node",
    [CLI, "build", src, "--quality-mode", "deterministic"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LLM_WIKI_NO_PROMPT: "1",
        LLM_WIKI_MOCK_TIER1: "1",
        LLM_WIKI_SKIP_CLUSTER_NEST: "1",
      },
    },
  );
}

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-join-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeFm(absPath, data, body = "") {
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, renderFrontmatter(data, body), "utf8");
}

// Minimal source-wiki builder: writes a root `index.md` plus `n`
// leaf files each with distinct ids. No convergence, no indices
// computed — just the raw shape that validateWiki accepts.
function buildTinyWiki(tag, { leaves = [], subcats = {} } = {}) {
  const wiki = tmpWiki(tag);
  // Mark as a skill-managed wiki so `isWikiRoot` accepts it. A
  // real build creates `.llmwiki/git/HEAD`; for unit tests a minimal
  // layout-contract file is sufficient (see paths.mjs::isWikiRoot).
  writeFileSync(join(wiki, ".llmwiki.layout.yaml"), "layout: tiny-test\n", "utf8");
  // Root index with "hosted"-ish shape. Category wiki-root index
  // needs empty `parents: []` to pass the non-root-parents rule.
  writeFm(
    join(wiki, "index.md"),
    {
      id: basename(wiki),
      type: "index",
      depth_role: "category",
      focus: `subtree under ${basename(wiki)}`,
      parents: [],
      generator: "skill-llm-wiki/v1",
    },
    "",
  );
  // `leaves` in the simple form are placed under a tag-derived
  // subcategory so the fixture respects the X.11 LEAF-AT-WIKI-ROOT
  // invariant. Using `section-<tag>` rather than a hardcoded
  // `leaves/` avoids cross-fixture index collisions — two sources
  // built with `buildTinyWiki("a", ...)` and `buildTinyWiki("b", ...)`
  // would otherwise both land a `leaves/index.md` with `id:
  // "leaves"`, tripping `JOIN-INDEX-COLLISION`. Each tag's
  // subcategory id is distinct.
  const subName = `section-${tag}`;
  if (leaves.length > 0) {
    writeFm(
      join(wiki, subName, "index.md"),
      {
        id: subName,
        type: "index",
        depth_role: "subcategory",
        focus: `${subName} subcategory`,
        parents: ["../index.md"],
      },
      "",
    );
  }
  for (const leaf of leaves) {
    writeFm(
      join(wiki, subName, `${leaf.id}.md`),
      {
        id: leaf.id,
        type: "primary",
        depth_role: "leaf",
        focus: leaf.focus || `${leaf.id} focus`,
        parents: ["index.md"],
        covers: leaf.covers || [`${leaf.id} cover`],
        tags: leaf.tags || ["tag"],
        activation: { keyword_matches: [leaf.id] },
      },
      `\n# ${leaf.id}\n\nbody of ${leaf.id}\n`,
    );
  }
  for (const [subName, subLeaves] of Object.entries(subcats)) {
    // Subcategory index
    writeFm(
      join(wiki, subName, "index.md"),
      {
        id: subName,
        type: "index",
        depth_role: "subcategory",
        focus: `subtree under ${subName}`,
        parents: ["../index.md"],
      },
      "",
    );
    for (const leaf of subLeaves) {
      writeFm(
        join(wiki, subName, `${leaf.id}.md`),
        {
          id: leaf.id,
          type: "primary",
          depth_role: "leaf",
          focus: leaf.focus || `${leaf.id} focus`,
          parents: ["index.md"],
          covers: leaf.covers || [`${leaf.id} cover`],
          tags: leaf.tags || ["tag"],
          activation: { keyword_matches: [leaf.id] },
        },
        `\n# ${leaf.id}\n\nbody of ${leaf.id}\n`,
      );
    }
  }
  return wiki;
}

// ── ingestWiki ──────────────────────────────────────────────────

test("ingestWiki: reads leaves + indices from a tiny wiki", () => {
  const wiki = buildTinyWiki("ingest", {
    leaves: [{ id: "alpha" }, { id: "beta" }],
  });
  try {
    const out = ingestWiki(wiki);
    assert.equal(out.wikiRoot, wiki);
    assert.equal(out.leaves.length, 2);
    // Root index + leaves/ subcategory index = 2.
    assert.equal(out.indices.length, 2);
    assert.deepEqual(
      out.leaves.map((l) => l.data.id).sort(),
      ["alpha", "beta"],
    );
    assert.equal(out.indices[0].data.type, "index");
    assert.equal(out.malformed.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("ingestWiki: skips dotfiles and plain markdown", () => {
  const wiki = buildTinyWiki("ingest-skip", { leaves: [{ id: "alpha" }] });
  try {
    writeFileSync(join(wiki, ".hidden.md"), "---\nid: hidden\n---\n", "utf8");
    writeFileSync(join(wiki, "plain.md"), "no fm here\n", "utf8");
    const out = ingestWiki(wiki);
    const ids = out.leaves.map((l) => l.data.id);
    assert.ok(!ids.includes("hidden"));
    assert.equal(out.leaves.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── validateSources ─────────────────────────────────────────────

test("validateSources: passes on clean sources", () => {
  const a = buildTinyWiki("val-a", { leaves: [{ id: "alpha" }] });
  const b = buildTinyWiki("val-b", { leaves: [{ id: "beta" }] });
  try {
    const report = validateSources([ingestWiki(a), ingestWiki(b)]);
    assert.equal(
      report.errors.length,
      0,
      `expected no errors, got: ${JSON.stringify(report.errors, null, 2)}`,
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("validateSources: does not duplicate PARSE findings that validateWiki already reported", () => {
  // When a source wiki has a .md file whose frontmatter fails to
  // parse, both `ingestWiki` (via the streaming reader) AND
  // `validateWiki` (via its collectAll walk) can surface the same
  // PARSE error. The aggregated report should dedupe by
  // (code, target) so the JOIN-SOURCE-INVALID summary isn't
  // noisy with paired duplicate entries.
  const wiki = buildTinyWiki("val-dup", { leaves: [{ id: "alpha" }] });
  try {
    // Plant a malformed-frontmatter file (open fence, no close).
    // Must NOT live at the wiki root — that would trip
    // LEAF-AT-WIKI-ROOT instead of PARSE. Put it inside the
    // `section-val-dup/` subcategory the fixture already creates.
    const malformedPath = join(wiki, "section-val-dup", "broken.md");
    writeFileSync(
      malformedPath,
      "---\nid: broken\ntype: primary\n# no closing fence\nbody\n",
      "utf8",
    );
    const ingested = ingestWiki(wiki);
    const report = validateSources([ingested]);
    const parseFindingsForPath = report.errors.filter(
      (f) => f.code === "PARSE" && f.target === malformedPath,
    );
    assert.equal(
      parseFindingsForPath.length,
      1,
      `expected a single PARSE finding for ${malformedPath}, got ${parseFindingsForPath.length}: ${JSON.stringify(parseFindingsForPath)}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── planUnion ───────────────────────────────────────────────────

test("planUnion: merges per-source records and tags sourceWiki", () => {
  const a = buildTinyWiki("plan-a", { leaves: [{ id: "alpha" }] });
  const b = buildTinyWiki("plan-b", { leaves: [{ id: "beta" }] });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    assert.equal(plan.leaves.length, 2);
    const alphaRec = plan.leaves.find((l) => l.data.id === "alpha");
    const betaRec = plan.leaves.find((l) => l.data.id === "beta");
    assert.equal(alphaRec.sourceWiki, a);
    assert.equal(betaRec.sourceWiki, b);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// ── resolveIdCollisions ─────────────────────────────────────────

test("resolveIdCollisions: namespace policy prefixes second-source id", () => {
  const a = buildTinyWiki("ns-a", { leaves: [{ id: "dup" }] });
  const b = buildTinyWiki("ns-b", { leaves: [{ id: "dup" }] });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    const { plan: resolved, renameMap } = resolveIdCollisions(
      plan,
      "namespace",
    );
    // One record still has id "dup", the other has "<prefix>.dup"
    const ids = resolved.leaves.map((l) => l.data.id).sort();
    assert.equal(ids.length, 2);
    assert.equal(ids.filter((i) => i === "dup").length, 1);
    const renamed = ids.find((i) => i !== "dup");
    assert.match(renamed, /\.dup$/);
    // renameMap is source-scoped: the second source's rename is
    // keyed by its wikiRoot so 3+ colliding sources each get their
    // own slot without clobbering.
    assert.ok(renameMap.has(b));
    assert.equal(renameMap.get(b).get("dup"), renamed);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: namespace policy handles 3+ colliding sources without clobbering", () => {
  // Regression for the N>2 collision case: before the source-scoped
  // renameMap refactor, three sources all sharing id "dup" would
  // overwrite each other's rename entry in a flat Map<oldId,newId>,
  // so phase 6 would rewrite all references to the last-renamed
  // value. With source-scoped scope each source gets its own slot.
  const a = buildTinyWiki("ns3-a", { leaves: [{ id: "dup" }] });
  const b = buildTinyWiki("ns3-b", { leaves: [{ id: "dup" }] });
  const c = buildTinyWiki("ns3-c", { leaves: [{ id: "dup" }] });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b), ingestWiki(c)]);
    const { plan: resolved, renameMap } = resolveIdCollisions(
      plan,
      "namespace",
    );
    const ids = resolved.leaves.map((l) => l.data.id).sort();
    assert.equal(ids.length, 3);
    // One record still "dup" (source A keeper); the other two have
    // distinct namespaced ids.
    const keepers = ids.filter((i) => i === "dup");
    const namespaced = ids.filter((i) => i !== "dup");
    assert.equal(keepers.length, 1);
    assert.equal(namespaced.length, 2);
    assert.equal(new Set(namespaced).size, 2, "namespaced ids must be distinct");
    // renameMap carries per-source entries for B and C.
    assert.ok(renameMap.has(b));
    assert.ok(renameMap.has(c));
    assert.notEqual(
      renameMap.get(b).get("dup"),
      renameMap.get(c).get("dup"),
      "each source's namespaced id must be distinct",
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  }
});

test("rewireReferences: source-scoped renameMap resolves per-referrer", () => {
  // Given two sources B and C both renamed "dup" → "b.dup" and
  // "c.dup" respectively, a link in B's frontmatter pointing at
  // "dup" must resolve to "b.dup", and a link in C's frontmatter
  // pointing at "dup" must resolve to "c.dup". The flat-renameMap
  // regression would rewrite both to the same value.
  const b = buildTinyWiki("rwn-b", { leaves: [{ id: "dup" }] });
  const c = buildTinyWiki("rwn-c", { leaves: [{ id: "dup" }] });
  try {
    // Add a link to each source's leaf pointing at "dup". Subcat
    // name is `section-<tag>` per buildTinyWiki convention.
    for (const [src, tag] of [[b, "rwn-b"], [c, "rwn-c"]]) {
      const p = join(src, `section-${tag}`, "dup.md");
      const parsed = parseFrontmatter(readFileSync(p, "utf8"), p);
      parsed.data.links = [{ id: "dup" }];
      writeFileSync(p, renderFrontmatter(parsed.data, parsed.body), "utf8");
    }
    const renameMap = new Map([
      [b, new Map([["dup", "b.dup"]])],
      [c, new Map([["dup", "c.dup"]])],
    ]);
    const plan = planUnion([ingestWiki(b), ingestWiki(c)]);
    rewireReferences(plan, renameMap, new Map());
    const bLeaf = plan.leaves.find((l) => l.sourceWiki === b);
    const cLeaf = plan.leaves.find((l) => l.sourceWiki === c);
    assert.equal(bLeaf.data.links[0].id, "b.dup");
    assert.equal(cLeaf.data.links[0].id, "c.dup");
  } finally {
    rmSync(b, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: merge policy folds without self-aliasing the keeper", () => {
  // Regression: a prior cut added the absorbed record's id into
  // keeper.aliases[] — but the absorbed id IS the keeper's id
  // under a merge-policy fold (that's what "collision" means),
  // so the aliases entry would be a self-alias the validator
  // rejects under ALIAS-COLLIDES-ID. Keeper now only inherits
  // the absorbed's pre-existing aliases[] (if any) plus the
  // source_wikis[] provenance.
  const a = buildTinyWiki("mg-a", {
    leaves: [{ id: "dup", focus: "shared focus", tags: ["t"] }],
  });
  const b = buildTinyWiki("mg-b", {
    leaves: [{ id: "dup", focus: "shared focus", tags: ["t"] }],
  });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    const { plan: resolved, renameMap, mergeMap } = resolveIdCollisions(
      plan,
      "merge",
    );
    // Only the keeper record remains.
    assert.equal(resolved.leaves.length, 1);
    const keeper = resolved.leaves[0];
    assert.equal(keeper.data.id, "dup");
    // Self-alias on keeper would trip ALIAS-COLLIDES-ID at phase 9.
    if (keeper.data.aliases) {
      assert.ok(
        !keeper.data.aliases.includes("dup"),
        `keeper.aliases must not contain its own id ("dup")`,
      );
    }
    assert.ok(Array.isArray(keeper.data.source_wikis));
    assert.equal(keeper.data.source_wikis.length, 2);
    assert.equal(renameMap.size, 0);
    // mergeMap is 0: identity `{"dup" → "dup"}` entries are
    // skipped so they can't intercept a namespace-rename rewrite
    // on another source sharing the same collision id. The
    // absorbed record is still dropped via absorbedPaths.
    assert.equal(mergeMap.size, 0);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: merge falls back to namespace when focus differs", () => {
  const a = buildTinyWiki("mgf-a", {
    leaves: [{ id: "dup", focus: "focus alpha" }],
  });
  const b = buildTinyWiki("mgf-b", {
    leaves: [{ id: "dup", focus: "focus beta" }],
  });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    const { plan: resolved, renameMap, mergeMap } = resolveIdCollisions(
      plan,
      "merge",
    );
    // Incompatible frontmatter → fallback to namespace.
    assert.equal(resolved.leaves.length, 2);
    assert.equal(renameMap.size, 1);
    assert.equal(mergeMap.size, 0);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: merge policy with 3 sources where one falls back to namespace rewrites references correctly", () => {
  // Covers the mergeMap ↔ renameMap precedence interaction.
  // Three sources all share id "dup". Source A + B have matching
  // focus → merge-fold (B absorbed into A). Source C has a
  // different focus → falls back to namespace ("c.dup"). A link
  // in source C's frontmatter pointing at "dup" MUST resolve to
  // "c.dup" (C's own namespaced id), not to A's keeper id "dup"
  // — an identity mapping in mergeMap would intercept the
  // rewrite and send the reference to A's keeper.
  const a = buildTinyWiki("mix-a", {
    leaves: [{ id: "dup", focus: "shared focus", tags: ["t"] }],
  });
  const b = buildTinyWiki("mix-b", {
    leaves: [{ id: "dup", focus: "shared focus", tags: ["t"] }],
  });
  const c = buildTinyWiki("mix-c", {
    leaves: [{ id: "dup", focus: "DIFFERENT focus", tags: ["t"] }],
  });
  try {
    // Decorate C's dup with a link pointing at "dup" (its own
    // renamed-away id). After rewireReferences this must become
    // "c.dup" — the source-scoped rename for source C.
    const cLeafPath = join(c, "section-mix-c", "dup.md");
    const parsed = parseFrontmatter(readFileSync(cLeafPath, "utf8"), cLeafPath);
    parsed.data.links = [{ id: "dup" }];
    writeFileSync(cLeafPath, renderFrontmatter(parsed.data, parsed.body), "utf8");

    const plan = planUnion([ingestWiki(a), ingestWiki(b), ingestWiki(c)]);
    const { plan: resolved, renameMap, mergeMap } = resolveIdCollisions(
      plan,
      "merge",
    );
    // Plan shape: A's keeper + C's namespaced record (B absorbed).
    assert.equal(resolved.leaves.length, 2, JSON.stringify(resolved.leaves.map((l) => l.data.id)));
    const keeper = resolved.leaves.find((l) => l.data.id === "dup");
    const cRenamed = resolved.leaves.find((l) => l.data.id !== "dup");
    assert.ok(keeper, "A's keeper record still has id 'dup'");
    assert.ok(cRenamed, "C's dup record renamed away");
    assert.match(cRenamed.data.id, /\.dup$/);
    // Under merge-fold with identity, mergeMap should NOT contain
    // {"dup": "dup"} — that would intercept C's rename.
    assert.equal(
      mergeMap.get("dup"),
      undefined,
      `mergeMap must not contain an identity "dup"→"dup" entry that would short-circuit source C's namespace rewrite`,
    );
    // renameMap has C's entry.
    assert.ok(renameMap.has(c));
    assert.equal(renameMap.get(c).get("dup"), cRenamed.data.id);

    // The critical test: rewire C's link and confirm it points at
    // C's namespaced id, not the keeper's "dup".
    rewireReferences(resolved, renameMap, mergeMap);
    const cLeafAfter = resolved.leaves.find((l) => l.sourceWiki === c);
    assert.equal(
      cLeafAfter.data.links[0].id,
      cRenamed.data.id,
      `C's self-link must resolve to C's namespaced id, got ${cLeafAfter.data.links[0].id}`,
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
    rmSync(c, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: index id collision throws JOIN-INDEX-COLLISION", () => {
  // Two sources both carrying a top-level `auth/index.md` whose
  // frontmatter id == "auth". resolveIdCollisions must throw the
  // structured `JOIN-INDEX-COLLISION` with both source wiki paths
  // named in the message, rather than letting the collision slip
  // through to materialisation (where it would trip DUP-ID at
  // phase 9 after a wasteful full-pipeline walk).
  //
  // Also covers the throw-before-mutate contract: even though the
  // throw fires mid-loop over the collisions, in-memory
  // `dup.data.id` and `renameMap` must be byte-identical to the
  // pre-call state (the round-6 fix moved the throw BEFORE the
  // namespace-rename mutations).
  const a = buildTinyWiki("idx-a", {
    subcats: { auth: [{ id: "auth-alpha" }] },
  });
  const b = buildTinyWiki("idx-b", {
    subcats: { auth: [{ id: "auth-beta" }] },
  });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    // Snapshot the indices' current ids + body so we can verify
    // no mutation happened before the throw.
    const pre = plan.indices.map((i) => ({ path: i.absolutePath, id: i.data.id }));
    let caught;
    try {
      resolveIdCollisions(plan, "namespace");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "expected JOIN-INDEX-COLLISION to throw");
    assert.equal(caught.code, "JOIN-INDEX-COLLISION");
    assert.match(caught.message, /index id collision on "auth"/);
    // Substring-match the source paths rather than building regexes
    // from them: Windows tmp paths contain backslashes (and other
    // regex metacharacters on both OSes), so a naive
    // `new RegExp(path)` both trips CodeQL's "incomplete string
    // escaping" detector AND fails to match on Windows because the
    // backslash-separated path isn't escaped. `includes()` sidesteps
    // regex semantics entirely.
    assert.ok(
      caught.message.includes(a),
      `error message must name source A path ${a}; got: ${caught.message}`,
    );
    assert.ok(
      caught.message.includes(b),
      `error message must name source B path ${b}; got: ${caught.message}`,
    );
    // No partial mutation.
    for (const rec of pre) {
      const cur = plan.indices.find((i) => i.absolutePath === rec.path);
      assert.equal(
        cur.data.id,
        rec.id,
        `index id must not be mutated before JOIN-INDEX-COLLISION throws; ${rec.path} changed ${rec.id} → ${cur.data.id}`,
      );
    }
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: ask policy throws JOIN-COLLISION-ASK", () => {
  const a = buildTinyWiki("ask-a", { leaves: [{ id: "dup" }] });
  const b = buildTinyWiki("ask-b", { leaves: [{ id: "dup" }] });
  try {
    const plan = planUnion([ingestWiki(a), ingestWiki(b)]);
    let caught;
    try {
      resolveIdCollisions(plan, "ask");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "JOIN-COLLISION-ASK");
    assert.ok(Array.isArray(caught.collisions));
    assert.equal(caught.collisions[0].id, "dup");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: rejects unknown policy", () => {
  assert.throws(() =>
    resolveIdCollisions({ leaves: [], indices: [] }, "bogus"),
    /unknown id-collision policy/,
  );
});

test("VALID_COLLISION_POLICIES pinned canonical list", () => {
  assert.deepEqual(
    [...VALID_COLLISION_POLICIES],
    ["namespace", "merge", "ask"],
  );
  assert.equal(DEFAULT_COLLISION_POLICY, "namespace");
});

// ── mergeCategoriesWithSameFocus ────────────────────────────────

test("mergeCategoriesWithSameFocus: detects shared-focus top-level categories", () => {
  const a = buildTinyWiki("cat-a", { subcats: { auth: [{ id: "alpha" }] } });
  const b = buildTinyWiki("cat-b", { subcats: { auth: [{ id: "beta" }] } });
  try {
    // Give both auth/index.md the same focus string.
    const aIdx = join(a, "auth", "index.md");
    const raw = readFileSync(aIdx, "utf8");
    const { data, body } = parseFrontmatter(raw, aIdx);
    data.focus = "authentication";
    writeFileSync(aIdx, renderFrontmatter(data, body), "utf8");
    const bIdx = join(b, "auth", "index.md");
    const { data: bData, body: bBody } = parseFrontmatter(
      readFileSync(bIdx, "utf8"),
      bIdx,
    );
    bData.focus = "authentication";
    writeFileSync(bIdx, renderFrontmatter(bData, bBody), "utf8");
    const merges = mergeCategoriesWithSameFocus([ingestWiki(a), ingestWiki(b)]);
    assert.equal(merges.length, 1);
    assert.equal(merges[0].focus, "authentication");
    assert.equal(merges[0].categories.length, 2);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// ── rewireReferences ────────────────────────────────────────────

test("rewireReferences: rewrites links[].id via source-scoped renameMap", () => {
  const a = buildTinyWiki("rw-a", { leaves: [{ id: "alpha" }] });
  try {
    // Decorate alpha with a links[] pointing at "beta".
    const aPath = join(a, "section-rw-a", "alpha.md");
    const parsed = parseFrontmatter(readFileSync(aPath, "utf8"), aPath);
    parsed.data.links = [{ id: "beta" }];
    writeFileSync(aPath, renderFrontmatter(parsed.data, parsed.body), "utf8");
    const ingested = ingestWiki(a);
    const plan = planUnion([ingested]);
    const renameMap = new Map([[a, new Map([["beta", "other.beta"]])]]);
    rewireReferences(plan, renameMap, new Map());
    const rewritten = plan.leaves[0].data.links[0].id;
    assert.equal(rewritten, "other.beta");
  } finally {
    rmSync(a, { recursive: true, force: true });
  }
});

// ── materialisePlan ─────────────────────────────────────────────

test("materialisePlan: writes leaves + indices under target", () => {
  const a = buildTinyWiki("mat-a", { leaves: [{ id: "alpha" }] });
  const out = tmpWiki("mat-out");
  try {
    const plan = planUnion([ingestWiki(a)]);
    materialisePlan(plan, out);
    // buildTinyWiki nests `leaves[]` under `section-<tag>/` so
    // the fixture respects the X.11 root-containment invariant.
    assert.ok(existsSync(join(out, "section-mat-a", "alpha.md")));
    assert.ok(existsSync(join(out, "index.md")));
    const alphaParsed = parseFrontmatter(
      readFileSync(join(out, "section-mat-a", "alpha.md"), "utf8"),
      join(out, "section-mat-a", "alpha.md"),
    );
    assert.equal(alphaParsed.data.id, "alpha");
    assert.equal(alphaParsed.data.type, "primary");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// ── runJoin onPhase streaming contract ─────────────────────────

test("runJoin: onPhase fires DURING execution, not batched after (Promise.race)", async () => {
  // Strongest streaming-contract test for the PR-17-followup
  // wiring. Earlier CLI-side variants couldn't reliably
  // distinguish "streamed during execution" from
  // "batched at end before exit" — both behaviours produce
  // breadcrumbs in stderr before the process exits.
  //
  // This test pins the contract directly via Promise.race:
  // a Promise that resolves on the FIRST `onPhase` callback
  // (`ingest-all` is runJoin's first recorded phase) is raced
  // against runJoin's overall promise. If `onPhase` fires
  // synchronously inside runJoin's body — as it must under
  // the streaming contract — the first-phase Promise settles
  // long before runJoin's promise resolves, and the race
  // returns "phase-fired". A regression that either dropped
  // `onPhase` entirely or only invoked it after all I/O
  // completed would let runJoin's promise win the race
  // (either because onPhase never fires, or because all
  // calls happen too close to runJoin's resolution).
  //
  // The test uses `spawnSync` to build two real source wikis
  // via the build CLI — that gives them the `.llmwiki/git/`
  // private-git markers `validateWiki` requires for source
  // validation, plus enough I/O downstream that
  // ingest-all → … → validation takes a meaningful (~hundreds
  // of ms) amount of time. With deterministic mode (no Tier 2
  // queue), the run is fully self-contained.
  const parent = join(
    tmpdir(),
    `skill-llm-wiki-runjoin-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(parent, { recursive: true });

  // Hermetic-runtime guard. Deterministic mode still routes
  // mid-band similarity decisions through Tier 1 (MiniLM via
  // `tiered.mjs`) and the convergence path may invoke
  // cluster-nest. In a CLI subprocess `runCliBuild()` sets these
  // env flags inside the child, but THIS test calls `runJoin`
  // in-process — without these flags in the parent env, CI runs
  // could load/download the real MiniLM weights and run real
  // clustering, which is slow, network-sensitive, and irrelevant
  // to the streaming-contract assertion below. Save the prior
  // values so we restore them in `finally`, leaving global state
  // untouched for sibling tests.
  const priorMockTier1 = process.env.LLM_WIKI_MOCK_TIER1;
  const priorSkipClusterNest = process.env.LLM_WIKI_SKIP_CLUSTER_NEST;
  process.env.LLM_WIKI_MOCK_TIER1 = "1";
  process.env.LLM_WIKI_SKIP_CLUSTER_NEST = "1";

  try {
    // Source A: notes-a/{alpha-src.md}
    const srcA = join(parent, "src-a");
    mkdirSync(join(srcA, "notes-a"), { recursive: true });
    writeFileSync(
      join(srcA, "notes-a", "alpha-src.md"),
      "# Alpha\n\ndistinct alpha content for streaming test\n",
    );
    const buildA = runCliBuild(srcA);
    assert.equal(buildA.status, 0, buildA.stderr);
    const wikiA = `${srcA}.wiki`;

    // Source B: notes-b/{beta-src.md}
    const srcB = join(parent, "src-b");
    mkdirSync(join(srcB, "notes-b"), { recursive: true });
    writeFileSync(
      join(srcB, "notes-b", "beta-src.md"),
      "# Beta\n\ndistinct beta content for streaming test\n",
    );
    const buildB = runCliBuild(srcB);
    assert.equal(buildB.status, 0, buildB.stderr);
    const wikiB = `${srcB}.wiki`;

    const target = join(parent, "joined.wiki");
    mkdirSync(target, { recursive: true });

    let firstPhaseSignaller;
    const firstPhasePromise = new Promise((resolve) => {
      firstPhaseSignaller = resolve;
    });
    const observedPhases = [];
    const joinPromise = runJoin([wikiA, wikiB], target, {
      qualityMode: "deterministic",
      idCollisionPolicy: "namespace",
      onPhase: ({ phase, summary }) => {
        observedPhases.push(phase);
        if (phase === "ingest-all") firstPhaseSignaller(phase);
      },
    });

    const winner = await Promise.race([
      firstPhasePromise.then(() => "phase-fired"),
      joinPromise.then(() => "join-resolved", () => "join-resolved"),
    ]);
    assert.equal(
      winner,
      "phase-fired",
      `onPhase("ingest-all") must settle BEFORE runJoin's promise resolves — proves the callback wiring exists. The realistic regression this catches is "onPhase support dropped from runJoin" (the wiring this PR adds); the OLD pre-onPhase code path had runJoin's promise resolve before any callback fired, so the race winner would be "join-resolved". Observed phases at race time: ${JSON.stringify(observedPhases)}`,
    );

    // Macrotask-gap timing checks were tried in an earlier
    // round but proved flaky: a join over two-leaf source
    // wikis under deterministic mode + LLM_WIKI_MOCK_TIER1
    // completes in a few hundred microseconds end-to-end with
    // every internal `await` resolving as a microtask in the
    // same event-loop turn — `setImmediate` between phases
    // never gets to fire before runJoin returns, so a
    // "still-pending after first phase" assertion went both
    // ways across runs. The Promise.race winner check above
    // is the authoritative streaming-contract test here; the
    // CLI-side `cli progress: join emits per-phase
    // breadcrumbs in stderr` covers the end-to-end shape.

    // Cleanup: still need to await runJoin's resolution to
    // avoid an unhandled-promise-rejection warning. The
    // runJoin invocation runs without an orchestrator-driven
    // preOpSnapshot, so the target tree never gets the
    // `.llmwiki/git/` markers `validateWiki` requires — we
    // expect the call to fail at phase 9 with
    // `JOIN-TARGET-INVALID`. That's fine: the streaming
    // contract is already proven by the Promise.race winner
    // above; the eventual failure is downstream of the part
    // we're testing. Swallow it.
    await joinPromise.catch((err) => {
      if (err.code !== "JOIN-TARGET-INVALID") throw err;
    });
  } finally {
    if (priorMockTier1 === undefined) delete process.env.LLM_WIKI_MOCK_TIER1;
    else process.env.LLM_WIKI_MOCK_TIER1 = priorMockTier1;
    if (priorSkipClusterNest === undefined) delete process.env.LLM_WIKI_SKIP_CLUSTER_NEST;
    else process.env.LLM_WIKI_SKIP_CLUSTER_NEST = priorSkipClusterNest;
    rmSync(parent, { recursive: true, force: true });
  }
});
