// join.test.mjs — unit coverage for the 11-phase join pipeline.
//
// Each test builds small source wiki fixtures by hand (the unit
// scope avoids the full `build` CLI roundtrip — that's covered by
// the e2e suite) and drives `runJoin` directly. The goal is to
// exercise every phase's contract in isolation:
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
//   - runJoin end-to-end: happy path produces a tree that passes
//     validateWiki

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
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
  validateSources,
} from "../../scripts/lib/join.mjs";

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
  // `leaves` in the simple form are placed under `leaves/` so the
  // fixture respects the X.11 LEAF-AT-WIKI-ROOT invariant. For
  // richer shapes use the `subcats` key directly.
  if (leaves.length > 0) {
    writeFm(
      join(wiki, "leaves", "index.md"),
      {
        id: "leaves",
        type: "index",
        depth_role: "subcategory",
        focus: "leaves subcategory",
        parents: ["../index.md"],
      },
      "",
    );
  }
  for (const leaf of leaves) {
    writeFm(
      join(wiki, "leaves", `${leaf.id}.md`),
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
    assert.ok(renameMap.has("dup"));
    assert.equal(renameMap.get("dup"), renamed);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("resolveIdCollisions: merge policy folds when frontmatter compatible", () => {
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
    assert.ok(Array.isArray(keeper.data.aliases));
    assert.ok(keeper.data.aliases.includes("dup"));
    assert.ok(Array.isArray(keeper.data.source_wikis));
    assert.equal(keeper.data.source_wikis.length, 2);
    assert.equal(renameMap.size, 0);
    assert.equal(mergeMap.size, 1);
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

test("rewireReferences: rewrites links[].id via renameMap", () => {
  const a = buildTinyWiki("rw-a", { leaves: [{ id: "alpha" }] });
  try {
    // Decorate alpha with a links[] pointing at "beta".
    const aPath = join(a, "leaves", "alpha.md");
    const parsed = parseFrontmatter(readFileSync(aPath, "utf8"), aPath);
    parsed.data.links = [{ id: "beta" }];
    writeFileSync(aPath, renderFrontmatter(parsed.data, parsed.body), "utf8");
    const ingested = ingestWiki(a);
    const plan = planUnion([ingested]);
    const renameMap = new Map([["beta", "other.beta"]]);
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
    // buildTinyWiki nests its `leaves[]` under `leaves/` so the
    // fixture respects the X.11 root-containment invariant.
    assert.ok(existsSync(join(out, "leaves", "alpha.md")));
    assert.ok(existsSync(join(out, "index.md")));
    const alphaParsed = parseFrontmatter(
      readFileSync(join(out, "leaves", "alpha.md"), "utf8"),
      join(out, "leaves", "alpha.md"),
    );
    assert.equal(alphaParsed.data.id, "alpha");
    assert.equal(alphaParsed.data.type, "primary");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
