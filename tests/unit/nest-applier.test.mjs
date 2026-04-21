// nest-applier.test.mjs — synthetic wiki + NEST proposal; verifies
// files moved, parents[] rewritten, stub created, slug validation,
// and precondition failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter, renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import {
  applyNest,
  buildWikiForbiddenIndex,
  resolveNestSlug,
  validateSlug,
} from "../../scripts/lib/nest-applier.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-nest-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeLeaf(wikiRoot, relPath, id, extra = {}) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: `${id} focus`,
    parents: ["index.md"],
    covers: [`${id} cover`],
    tags: extra.tags || ["default"],
    activation: { keyword_matches: extra.kw || [id] },
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n"), "utf8");
  return { path: full, data };
}

// Write an `index.md` with index-shaped frontmatter (type: "index",
// depth_role: "category"), matching what the validator enforces for
// every index entry in a real wiki (id == basename(dirname), type ==
// "index", non-empty parents[] for every non-root index). Use this
// instead of writeLeaf whenever a test plants a directory index, so
// fixtures mirror the production shape and future stricter
// validators don't start failing these tests for type / depth_role /
// parents mismatches.
//
// `parents` default shape:
//   - Root index (relPath === "index.md" at wikiRoot): `[]` — roots
//     have no parent. The validator's non-empty-parents rule
//     carves out the root.
//   - Non-root index (any `<subdir>/index.md`): `["../index.md"]` —
//     non-empty, points at the directory above, which is what every
//     real non-root index carries. Callers can override via
//     `extra.parents` if a test needs a specific path.
function writeIndex(wikiRoot, relPath, id, extra = {}) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const isRootIndex = relPath === "index.md";
  const defaultParents = isRootIndex ? [] : ["../index.md"];
  const data = {
    id,
    type: "index",
    depth_role: extra.depth_role ?? "category",
    focus: `${id} category`,
    parents: extra.parents ?? defaultParents,
    tags: extra.tags ?? ["default"],
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n"), "utf8");
  return { path: full, data };
}

test("validateSlug: accepts kebab-case, rejects everything else", () => {
  assert.equal(validateSlug("operations"), true);
  assert.equal(validateSlug("layout-modes"), true);
  assert.equal(validateSlug("a"), true);
  assert.equal(validateSlug(""), false);
  assert.equal(validateSlug("Operations"), false); // uppercase
  assert.equal(validateSlug("oper ations"), false); // space
  assert.equal(validateSlug("ops/"), false); // slash
  assert.equal(validateSlug("1ops"), false); // starts with digit
  assert.equal(validateSlug("-ops"), false); // starts with dash
  assert.equal(validateSlug(null), false);
});

test("applyNest: moves leaves, rewrites parents, creates stub", () => {
  const wiki = tmpWiki("apply");
  try {
    const l1 = writeLeaf(wiki, "foo.md", "foo", { tags: ["group"], kw: ["foo", "group"] });
    const l2 = writeLeaf(wiki, "bar.md", "bar", { tags: ["group"], kw: ["bar", "group"] });
    const l3 = writeLeaf(wiki, "baz.md", "baz", { tags: ["group"], kw: ["baz", "group"] });
    const proposal = { operator: "NEST", leaves: [l1, l2, l3] };
    const result = applyNest(wiki, proposal, "my-cluster");
    // New dir exists
    const targetDir = join(wiki, "my-cluster");
    assert.ok(existsSync(targetDir));
    // Old files gone
    assert.ok(!existsSync(l1.path));
    assert.ok(!existsSync(l2.path));
    assert.ok(!existsSync(l3.path));
    // New leaves present
    for (const name of ["foo.md", "bar.md", "baz.md"]) {
      const newPath = join(targetDir, name);
      assert.ok(existsSync(newPath), `missing ${newPath}`);
      const raw = readFileSync(newPath, "utf8");
      const { data } = parseFrontmatter(raw, newPath);
      assert.deepEqual(data.parents, ["index.md"]);
    }
    // Stub index.md exists with expected fields
    const stub = join(targetDir, "index.md");
    assert.ok(existsSync(stub));
    const stubRaw = readFileSync(stub, "utf8");
    const { data: stubData } = parseFrontmatter(stubRaw, stub);
    assert.equal(stubData.id, "my-cluster");
    assert.equal(stubData.type, "index");
    assert.deepEqual(stubData.tags, ["group"]);
    // Semantic routing: the stub must NOT carry an aggregated
    // activation_defaults block. Routing descends on the stub's
    // `focus` / `shared_covers` instead. (Historical assertion
    // that the union of member `keyword_matches` landed here was
    // the literal-routing substrate and is removed.)
    assert.equal(
      stubData.activation_defaults,
      undefined,
      "NEST stub must not auto-aggregate activation_defaults",
    );
    // result summary
    assert.equal(result.moved.length, 3);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: refuses invalid slug", () => {
  const wiki = tmpWiki("badslug");
  try {
    const l1 = writeLeaf(wiki, "a.md", "a");
    const l2 = writeLeaf(wiki, "b.md", "b");
    assert.throws(
      () => applyNest(wiki, { leaves: [l1, l2] }, "Invalid Name!"),
      /invalid slug/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: refuses leaves with different parent dirs", () => {
  const wiki = tmpWiki("crossparent");
  try {
    const l1 = writeLeaf(wiki, "dir1/a.md", "a");
    const l2 = writeLeaf(wiki, "dir2/b.md", "b");
    assert.throws(
      () => applyNest(wiki, { leaves: [l1, l2] }, "cluster"),
      /different parent dirs/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: refuses when target dir already exists", () => {
  const wiki = tmpWiki("exists");
  try {
    const l1 = writeLeaf(wiki, "a.md", "a");
    const l2 = writeLeaf(wiki, "b.md", "b");
    mkdirSync(join(wiki, "clash"), { recursive: true });
    assert.throws(
      () => applyNest(wiki, { leaves: [l1, l2] }, "clash"),
      /already exists/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: refuses proposal with <2 leaves", () => {
  const wiki = tmpWiki("solo");
  try {
    const l1 = writeLeaf(wiki, "a.md", "a");
    assert.throws(
      () => applyNest(wiki, { leaves: [l1] }, "cluster"),
      /at least 2 leaves/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ─── Stub-shape tests (post semantic-routing rewrite) ───────────────
//
// The NEST applier no longer aggregates member activation signals
// into an `activation_defaults` block on the new subcategory stub.
// Routing is semantic: Claude descends based on the stub's
// `focus` (from the Tier 2 cluster purpose) and `shared_covers`
// (intersection of member covers). The aggregation regression
// tests that used to live here proved the literal-routing
// substrate is working; they were removed along with the
// substrate. See SKILL.md "Routing into guide.wiki/".

function writeRichLeaf(wikiRoot, relPath, id, frontmatter) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const data = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: `${id} focus`,
    parents: ["index.md"],
    ...frontmatter,
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n"), "utf8");
  return { path: full, data };
}

test("applyNest: stub does NOT carry aggregated activation_defaults", () => {
  const wiki = tmpWiki("noaggr");
  try {
    const l1 = writeRichLeaf(wiki, "a.md", "a", {
      tags: ["alpha-tag"],
      activation: {
        keyword_matches: ["a"],
        tag_matches: ["validating", "mutation"],
      },
    });
    const l2 = writeRichLeaf(wiki, "b.md", "b", {
      tags: ["beta-tag"],
      activation: {
        keyword_matches: ["b"],
        tag_matches: ["fixing", "any-op"],
      },
    });
    applyNest(wiki, { leaves: [l1, l2] }, "correctness");
    const stub = join(wiki, "correctness", "index.md");
    const { data } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    assert.equal(
      data.activation_defaults,
      undefined,
      "stub must not carry auto-aggregated activation_defaults",
    );
    // The leaves themselves still carry their authored activation
    // blocks — the hint data survives on-disk for the semantic
    // router to consult once a leaf is open.
    const leafRaw = readFileSync(join(wiki, "correctness", "a.md"), "utf8");
    const { data: leafData } = parseFrontmatter(leafRaw);
    assert.deepEqual(
      leafData.activation.tag_matches,
      ["validating", "mutation"],
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: shared_covers is intersection of member covers", () => {
  const wiki = tmpWiki("covers");
  try {
    const l1 = writeRichLeaf(wiki, "a.md", "a", {
      tags: ["t"],
      covers: ["how to X", "how to Y", "unique to a"],
      activation: { keyword_matches: ["a"] },
    });
    const l2 = writeRichLeaf(wiki, "b.md", "b", {
      tags: ["t"],
      covers: ["how to X", "how to Y", "unique to b"],
      activation: { keyword_matches: ["b"] },
    });
    applyNest(wiki, { leaves: [l1, l2] }, "shared");
    const stub = join(wiki, "shared", "index.md");
    const { data } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    // Sorted intersection
    assert.deepEqual(data.shared_covers, ["how to X", "how to Y"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: no shared covers → shared_covers omitted", () => {
  const wiki = tmpWiki("nocovers");
  try {
    const l1 = writeRichLeaf(wiki, "a.md", "a", {
      tags: ["t"],
      covers: ["only a"],
      activation: { keyword_matches: ["a"] },
    });
    const l2 = writeRichLeaf(wiki, "b.md", "b", {
      tags: ["t"],
      covers: ["only b"],
      activation: { keyword_matches: ["b"] },
    });
    applyNest(wiki, { leaves: [l1, l2] }, "split");
    const stub = join(wiki, "split", "index.md");
    const { data } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    assert.equal(data.shared_covers, undefined);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: cluster purpose becomes the subcat focus", () => {
  const wiki = tmpWiki("focus");
  try {
    const l1 = writeRichLeaf(wiki, "a.md", "a", {
      tags: ["t"],
      activation: { keyword_matches: ["a"] },
    });
    const l2 = writeRichLeaf(wiki, "b.md", "b", {
      tags: ["t"],
      activation: { keyword_matches: ["b"] },
    });
    const proposal = {
      operator: "NEST",
      leaves: [l1, l2],
      purpose: "invariants and safety: the correctness substrate",
    };
    applyNest(wiki, proposal, "correctness");
    const stub = join(wiki, "correctness", "index.md");
    const { data } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    assert.equal(
      data.focus,
      "invariants and safety: the correctness substrate",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: missing purpose falls back to placeholder focus", () => {
  const wiki = tmpWiki("focusfallback");
  try {
    const l1 = writeRichLeaf(wiki, "a.md", "a", {
      tags: ["t"],
      activation: { keyword_matches: ["a"] },
    });
    const l2 = writeRichLeaf(wiki, "b.md", "b", {
      tags: ["t"],
      activation: { keyword_matches: ["b"] },
    });
    applyNest(wiki, { leaves: [l1, l2] }, "fallback");
    const stub = join(wiki, "fallback", "index.md");
    const { data } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    assert.equal(data.focus, "subtree under fallback");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ─── resolveNestSlug: DUP-ID pre-apply rename ──────────────────────
//
// The observed collision case on the v0.4.1 novel-corpus run:
// Tier 2's propose_structure response picked slug "security" for a
// cluster whose members included a leaf with id "security". After
// apply, both the new subcategory stub (id: security) and the moved
// leaf (id: security, now at <parent>/security/security.md) lived in
// the same subtree — DUP-ID at validate time, forcing a full
// pipeline rollback. resolveNestSlug auto-suffixes before apply so
// the NEST lands on the first try.

test("resolveNestSlug: non-colliding slug is returned unchanged", () => {
  const wiki = tmpWiki("resolve-noop");
  try {
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    const resolved = resolveNestSlug("greek", { leaves: [l1, l2] });
    assert.equal(resolved, "greek");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug collision with member leaf id → suffixed", () => {
  const wiki = tmpWiki("resolve-member");
  try {
    const l1 = writeLeaf(wiki, "security.md", "security");
    const l2 = writeLeaf(wiki, "audit.md", "audit");
    const l3 = writeLeaf(wiki, "hardening.md", "hardening");
    const resolved = resolveNestSlug("security", { leaves: [l1, l2, l3] });
    assert.equal(resolved, "security-group");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug collision with non-member sibling leaf → suffixed", () => {
  const wiki = tmpWiki("resolve-sibling");
  try {
    // Cluster members
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    // Non-member sibling in the same parent
    writeLeaf(wiki, "greek.md", "greek");
    const resolved = resolveNestSlug("greek", { leaves: [l1, l2] });
    assert.equal(resolved, "greek-group");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug collision with existing sibling subdir → suffixed", () => {
  const wiki = tmpWiki("resolve-subdir");
  try {
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    mkdirSync(join(wiki, "greek"), { recursive: true });
    const resolved = resolveNestSlug("greek", { leaves: [l1, l2] });
    assert.equal(resolved, "greek-group");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: `-group` also collides → numeric fallback", () => {
  const wiki = tmpWiki("resolve-chain");
  try {
    const l1 = writeLeaf(wiki, "security.md", "security");
    const l2 = writeLeaf(wiki, "security-group.md", "security-group");
    const l3 = writeLeaf(wiki, "audit.md", "audit");
    const resolved = resolveNestSlug("security", { leaves: [l1, l2, l3] });
    assert.equal(resolved, "security-group-2");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: invalid slug passes through for applyNest to reject", () => {
  const wiki = tmpWiki("resolve-invalid");
  try {
    const l1 = writeLeaf(wiki, "a.md", "a");
    const l2 = writeLeaf(wiki, "b.md", "b");
    assert.equal(resolveNestSlug("Invalid Name!", { leaves: [l1, l2] }), "Invalid Name!");
    assert.equal(resolveNestSlug("", { leaves: [l1, l2] }), "");
    assert.equal(resolveNestSlug(null, { leaves: [l1, l2] }), null);
    assert.equal(resolveNestSlug(undefined, { leaves: [l1, l2] }), undefined);
    assert.equal(resolveNestSlug(42, { leaves: [l1, l2] }), 42);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: parent's own index.md does NOT poison the forbidden set", () => {
  // The parent's index.md carries id = parent basename. If collectForbiddenIds
  // failed to skip it, a slug that happens to equal the parent's basename
  // would be suffixed even though applyNest already catches that case via
  // its existsSync(targetDir) check. Here we seed a parent whose index.md
  // id is "foo" and verify that proposing slug "foo" is NOT touched by
  // resolveNestSlug — it passes through unchanged and applyNest will (or
  // will not) catch the actual directory collision separately.
  const wiki = tmpWiki("resolve-indexmd");
  try {
    // Parent directory: wiki itself. Seed an index.md with id "foo".
    const parentIndex = join(wiki, "index.md");
    writeFileSync(
      parentIndex,
      renderFrontmatter(
        { id: "foo", type: "index", depth_role: "root" },
        "\n",
      ),
      "utf8",
    );
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    const resolved = resolveNestSlug("foo", { leaves: [l1, l2] });
    assert.equal(
      resolved,
      "foo",
      "parent's own index.md id must not enter the forbidden set",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: length-overflow on suffix short-circuits instead of spinning", () => {
  // 58-char slug: "${slug}-group" is 64 chars, which IS the SLUG_RE cap.
  // 59-char slug: "${slug}-group" is 65 chars, which FAILS validateSlug.
  // The short-circuit path must return the original slug unchanged
  // rather than spinning the numeric-suffix loop pointlessly.
  const wiki = tmpWiki("resolve-overflow");
  try {
    const longSlug = "a".repeat(59); // 59 chars
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, longSlug + ".md", longSlug); // forces collision
    const resolved = resolveNestSlug(longSlug, { leaves: [l1, l2] });
    // Short-circuit: primary "${slug}-group" fails validateSlug
    // (65 chars), so return original. Numeric suffix candidates are
    // all longer and would also fail — spinning the loop is pointless.
    assert.equal(resolved, longSlug);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: numeric-suffix loop re-validates each candidate against SLUG_RE", () => {
  // Boundary case: base slug at 57 chars. `${slug}-group` is 63
  // chars (valid), but `${slug}-group-2` is 65 (invalid) and every
  // `${slug}-group-N` from N=2..99 is equally invalid. Plant a
  // collision on both the base slug AND "-group" so the resolver is
  // forced past them into the numeric-suffix loop; the loop must
  // re-check validateSlug on each candidate and bail back to the
  // original slug when the first candidate overflows — NOT return an
  // invalid slug that applyNest would reject with "invalid slug".
  const wiki = tmpWiki("resolve-numeric-overflow");
  try {
    const base = "a".repeat(57);
    const primary = `${base}-group`; // 63 chars, valid
    assert.ok(validateSlug(primary), "baseline: -group variant validates");
    const numeric2 = `${base}-group-2`; // 65 chars, invalid
    assert.ok(!validateSlug(numeric2), "baseline: -group-2 variant overflows");
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    // Force collisions on both `base` and `${base}-group` so the
    // resolver has to step into the numeric-suffix loop.
    const l2 = writeLeaf(wiki, base + ".md", base);
    writeLeaf(wiki, primary + ".md", primary);
    const resolved = resolveNestSlug(base, { leaves: [l1, l2] });
    assert.equal(
      resolved,
      base,
      "numeric-suffix loop must bail out when the candidate overflows SLUG_RE",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("applyNest: slug pre-resolved against member collision lands cleanly", () => {
  const wiki = tmpWiki("apply-resolved");
  try {
    const l1 = writeLeaf(wiki, "security.md", "security", { tags: ["t"] });
    const l2 = writeLeaf(wiki, "audit.md", "audit", { tags: ["t"] });
    const l3 = writeLeaf(wiki, "hardening.md", "hardening", { tags: ["t"] });
    const proposal = { operator: "NEST", leaves: [l1, l2, l3] };
    const resolved = resolveNestSlug("security", proposal);
    applyNest(wiki, proposal, resolved);
    // New dir is suffixed
    assert.ok(existsSync(join(wiki, "security-group")));
    // Stub id equals the resolved slug (no collision with moved child)
    const stub = join(wiki, "security-group", "index.md");
    const { data: stubData } = parseFrontmatter(readFileSync(stub, "utf8"), stub);
    assert.equal(stubData.id, "security-group");
    // Moved child still carries its original id
    const moved = join(wiki, "security-group", "security.md");
    const { data: childData } = parseFrontmatter(
      readFileSync(moved, "utf8"),
      moved,
    );
    assert.equal(childData.id, "security");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ─── resolveNestSlug: full-tree cross-depth collision (Bug 2 fix) ──
//
// The v1.0.0 resolver checked only the cluster's immediate parent
// directory for collisions. On real-world multi-branch wikis (first
// observed during the skill-code-review 596-leaf build), a slug like
// "event-patterns" proposed for a cluster in one branch could collide
// with a leaf id or subdirectory at a completely different depth in
// another branch — and the resolver would miss it, causing a
// DUP-ID rollback downstream at validation.
//
// The fix: when wikiRoot is provided, walk the full tree and collect
// every live id + directory basename into the forbidden set. These
// tests exercise the new paths and confirm the parent-dir-only
// behaviour is preserved when wikiRoot is absent (backward-compat).

test("resolveNestSlug: cross-depth leaf-id collision in another branch → suffixed", () => {
  // Structure:
  //   <wiki>/
  //     arch/
  //       event-patterns/
  //         index.md            (id: event-patterns)
  //         cqrs.md             (id: cqrs)
  //     design-patterns/        (cluster parent)
  //       observer.md           (member)
  //       publish-subscribe.md  (member)
  //
  // Proposal: NEST the two design-patterns/*.md leaves under a new
  // subcategory with slug "event-patterns". Without full-tree walk,
  // the resolver misses the arch/event-patterns/ collision; with
  // wikiRoot, the walk catches it and auto-suffixes.
  const wiki = tmpWiki("resolve-cross-depth-leaf");
  try {
    // Seed the `arch/event-patterns/` branch. writeIndex writes
    // validator-shaped index frontmatter (`type: "index"`,
    // `depth_role: "subcategory"`) and auto-mkdirs the parent.
    writeIndex(wiki, "arch/event-patterns/index.md", "event-patterns", {
      depth_role: "subcategory",
    });
    writeLeaf(wiki, "arch/event-patterns/cqrs.md", "cqrs");
    // Seed the cluster parent
    mkdirSync(join(wiki, "design-patterns"), { recursive: true });
    const l1 = writeLeaf(wiki, "design-patterns/observer.md", "observer");
    const l2 = writeLeaf(
      wiki,
      "design-patterns/publish-subscribe.md",
      "publish-subscribe",
    );

    // Without wikiRoot — cross-depth collision missed (legacy behaviour)
    assert.equal(
      resolveNestSlug("event-patterns", { leaves: [l1, l2] }),
      "event-patterns",
      "parent-dir-only walk should NOT see the cross-depth collision",
    );

    // With wikiRoot — collision caught, suffixed
    assert.equal(
      resolveNestSlug("event-patterns", { leaves: [l1, l2] }, wiki),
      "event-patterns-group",
      "full-tree walk should catch the cross-depth collision",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: cross-depth subdir-basename collision → suffixed", () => {
  // A subdirectory elsewhere in the tree carries a name that matches
  // the proposed slug. Applying NEST with that slug would create two
  // directories with the same basename id in the corpus — prevent it.
  const wiki = tmpWiki("resolve-cross-depth-subdir");
  try {
    // Unrelated branch with a subdirectory named "patterns".
    // writeIndex writes validator-shaped frontmatter and auto-mkdirs
    // the parent, reusing the same helper every other index fixture
    // in this suite goes through.
    writeIndex(wiki, "other-branch/patterns/index.md", "patterns", {
      depth_role: "subcategory",
    });
    // Cluster parent
    mkdirSync(join(wiki, "cluster-parent"), { recursive: true });
    const l1 = writeLeaf(wiki, "cluster-parent/alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "cluster-parent/beta.md", "beta");

    assert.equal(
      resolveNestSlug("patterns", { leaves: [l1, l2] }, wiki),
      "patterns-group",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: full-tree walk still returns unchanged when no collision anywhere", () => {
  // Regression guard: don't over-suffix on wikis with no real
  // collision just because wikiRoot is provided.
  const wiki = tmpWiki("resolve-cross-depth-clean");
  try {
    // Unrelated branch
    mkdirSync(join(wiki, "other"), { recursive: true });
    writeLeaf(wiki, "other/gamma.md", "gamma");
    // Cluster parent
    mkdirSync(join(wiki, "parent"), { recursive: true });
    const l1 = writeLeaf(wiki, "parent/alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "parent/beta.md", "beta");

    assert.equal(
      resolveNestSlug("greek-letters", { leaves: [l1, l2] }, wiki),
      "greek-letters",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: full-tree walk skips every dot-directory (blanket rule)", () => {
  // Per Copilot review on PR #5: the walk uses a blanket
  // `entry.name.startsWith(".")` rule consistent with
  // `scripts/lib/chunk.mjs::collectEntryPaths`. This covers not only
  // `.llmwiki/` and `.work/` (skill-owned) but any user dotfile the
  // corpus might carry: `.git/`, `.github/`, `.shape/`, etc.
  // Arbitrary files under these locations must never poison the
  // forbidden set.
  const wiki = tmpWiki("resolve-cross-depth-internals");
  try {
    // Seed fake internals with deliberately colliding names
    mkdirSync(join(wiki, ".llmwiki", "git", "refs"), { recursive: true });
    writeFileSync(
      join(wiki, ".llmwiki", "git", "refs", "greek"),
      "ref data\n",
      "utf8",
    );
    // User `.git/` dir — common in corpora hosted inside a real repo.
    // A markdown file under `.git/` with a colliding frontmatter id
    // must NOT leak into the forbidden set.
    mkdirSync(join(wiki, ".git", "logs"), { recursive: true });
    writeFileSync(
      join(wiki, ".git", "greek.md"),
      renderFrontmatter({ id: "greek", type: "primary" }, "\n"),
      "utf8",
    );
    // User `.github/` workflows dir — similar reasoning.
    mkdirSync(join(wiki, ".github"), { recursive: true });
    writeFileSync(
      join(wiki, ".github", "greek.md"),
      renderFrontmatter({ id: "greek", type: "primary" }, "\n"),
      "utf8",
    );
    mkdirSync(join(wiki, ".work", "tier2"), { recursive: true });
    writeFileSync(
      join(wiki, ".work", "tier2", "greek.json"),
      "{}\n",
      "utf8",
    );
    // A real sibling leaf NOT named greek — confirms the walk still
    // finds actual content.
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");

    // "greek" should pass through unchanged — .llmwiki and .work
    // contents must not poison the forbidden set.
    assert.equal(
      resolveNestSlug("greek", { leaves: [l1, l2] }, wiki),
      "greek",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: cross-depth collision chains to -group-N numeric fallback", () => {
  // Both "event-patterns" and "event-patterns-group" exist at
  // different depths in the tree. The resolver should fall through
  // "-group" (collides) and land on "-group-2".
  const wiki = tmpWiki("resolve-cross-depth-chain");
  try {
    // Branch 1: id "event-patterns"
    mkdirSync(join(wiki, "branch-a", "event-patterns"), { recursive: true });
    writeFileSync(
      join(wiki, "branch-a", "event-patterns", "index.md"),
      renderFrontmatter(
        { id: "event-patterns", type: "index", depth_role: "subcategory" },
        "\n",
      ),
      "utf8",
    );
    // Branch 2: id "event-patterns-group"
    mkdirSync(join(wiki, "branch-b", "event-patterns-group"), {
      recursive: true,
    });
    writeFileSync(
      join(wiki, "branch-b", "event-patterns-group", "index.md"),
      renderFrontmatter(
        { id: "event-patterns-group", type: "index", depth_role: "subcategory" },
        "\n",
      ),
      "utf8",
    );
    // Cluster parent
    mkdirSync(join(wiki, "cluster-parent"), { recursive: true });
    const l1 = writeLeaf(wiki, "cluster-parent/alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "cluster-parent/beta.md", "beta");

    assert.equal(
      resolveNestSlug("event-patterns", { leaves: [l1, l2] }, wiki),
      "event-patterns-group-2",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("buildWikiForbiddenIndex: captures every leaf id + dir basename", () => {
  // Snapshot contract: index contains every non-dot directory basename
  // and every leaf frontmatter id under wikiRoot. Consumers use this as
  // a reusable snapshot in multi-NEST iterations to avoid paying for a
  // full-tree walk on every resolveNestSlug call.
  //
  // Use a custom short-basename wikiRoot (like the `short-wiki` test
  // further down) so the root `index.md` id can legitimately equal
  // `basename(wikiRoot)` — which is what the validator enforces for
  // every index entry (`type: index` id === basename(dirname(index.md))).
  // A made-up id like "wiki-root" would violate that invariant and
  // diverge from production shape.
  const parent = tmpWiki("forbidden-index-parent");
  const wiki = join(parent, "root-wiki");
  mkdirSync(wiki, { recursive: true });
  try {
    const rootId = basename(wiki); // "root-wiki"
    writeLeaf(wiki, "alpha.md", "alpha");
    writeLeaf(wiki, "beta.md", "beta");
    writeLeaf(wiki, "sub/gamma.md", "gamma");
    writeLeaf(wiki, "sub/delta.md", "delta");
    writeLeaf(wiki, "other/epsilon.md", "epsilon");
    // Root index.md — id must match basename(wikiRoot) per validator.
    writeIndex(wiki, "index.md", rootId);
    // Dot-directory — must be skipped.
    writeLeaf(wiki, ".cache/ignored.md", "ignored");

    const index = buildWikiForbiddenIndex(wiki);
    for (const id of [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      rootId,
      "sub",
      "other",
    ]) {
      assert.ok(index.has(id), `index should contain "${id}"`);
    }
    assert.equal(
      index.has("ignored"),
      false,
      "dot-directory entries must be skipped",
    );
    assert.equal(
      index.has(".cache"),
      false,
      "dot-directory basenames must be skipped",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveNestSlug: opts.wikiIndex short-circuits the full-tree walk", () => {
  // Performance contract: when a precomputed index is supplied, the
  // resolver must NOT re-walk wiki-wide. We verify behaviourally by
  // constructing a tree, building the index, then deleting the files
  // that the walk would have consulted — a post-build deletion would
  // flip the result if the resolver re-read them. With the precomputed
  // path the result must stay consistent with the snapshot.
  const wiki = tmpWiki("wiki-index-short-circuit");
  try {
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    // Seed a collider leaf in a sibling branch at snapshot time.
    writeLeaf(wiki, "arch/event-patterns.md", "event-patterns");
    const wikiIndex = buildWikiForbiddenIndex(wiki);
    // Delete the collider AFTER the snapshot. The snapshot still
    // "remembers" it — so the resolver must auto-suffix.
    rmSync(join(wiki, "arch"), { recursive: true, force: true });
    assert.equal(
      resolveNestSlug(
        "event-patterns",
        { leaves: [l1, l2] },
        wiki,
        { wikiIndex },
      ),
      "event-patterns-group",
      "precomputed wikiIndex drives the decision even after tree mutates",
    );
    // And a non-collider stays unchanged via the precomputed set.
    assert.equal(
      resolveNestSlug("fresh-slug", { leaves: [l1, l2] }, wiki, { wikiIndex }),
      "fresh-slug",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: caller-driven wikiIndex mutation reflects applied NESTs", () => {
  // Integration contract: the multi-NEST caller mutates the index after
  // each successful apply by `wikiIndex.add(resolvedSlug)`. The NEXT
  // resolveNestSlug call must see the new directory as occupied and
  // auto-suffix. This is the sequencing guarantee operators.mjs relies
  // on when applying multiple non-conflicting NESTs in one iteration.
  const wiki = tmpWiki("wiki-index-mutation");
  try {
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    const l3 = writeLeaf(wiki, "gamma.md", "gamma");
    const l4 = writeLeaf(wiki, "delta.md", "delta");
    const wikiIndex = buildWikiForbiddenIndex(wiki);
    // First proposal: slug "patterns" — no collision anywhere.
    const first = resolveNestSlug(
      "patterns",
      { leaves: [l1, l2] },
      wiki,
      { wikiIndex },
    );
    assert.equal(first, "patterns");
    // Simulate a successful apply.
    wikiIndex.add(first);
    // Second proposal wants the same slug — must auto-suffix because
    // the first pick has taken it.
    const second = resolveNestSlug(
      "patterns",
      { leaves: [l3, l4] },
      wiki,
      { wikiIndex },
    );
    assert.equal(
      second,
      "patterns-group",
      "second pick in same iteration must see the first pick's slug as occupied",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug matching a parent-index alias auto-suffixes", () => {
  // The parent-dir walk explicitly skips `index.md` (its id is covered
  // by the `basename(parentDir)` add). But the parent's own
  // `aliases[]` aren't reconstructible from the directory name, so
  // they get harvested via a targeted streaming read separate from
  // the loop. Without that read, a slug equal to a parent-index alias
  // would slip past every other guard and trip ALIAS-COLLIDES-ID at
  // validate time.
  //
  // This test uses the legacy (no-wikiRoot) path to exercise the
  // parent-index-alias branch directly. The full-tree walkers
  // (walkWikiIds / buildWikiForbiddenIndex) already harvest every
  // entry's aliases including indices, so they're covered by the
  // preceding test.
  const parent = tmpWiki("parent-index-alias");
  const wiki = join(parent, "root-wiki");
  mkdirSync(wiki, { recursive: true });
  try {
    // Cluster parent carries an alias `canonical-patterns` on its
    // own index.md. A cluster proposal with slug "canonical-patterns"
    // would otherwise pass every other guard.
    const clusterParent = join(wiki, "mod");
    mkdirSync(clusterParent, { recursive: true });
    writeFileSync(
      join(clusterParent, "index.md"),
      renderFrontmatter(
        {
          id: "mod",
          type: "index",
          depth_role: "subcategory",
          focus: "mod category",
          parents: ["../index.md"],
          aliases: ["canonical-patterns"],
          tags: ["default"],
        },
        "\n# mod\n",
      ),
      "utf8",
    );
    const l1 = writeLeaf(clusterParent, "alpha.md", "alpha");
    const l2 = writeLeaf(clusterParent, "beta.md", "beta");

    assert.equal(
      resolveNestSlug("canonical-patterns", { leaves: [l1, l2] }),
      "canonical-patterns-group",
      "parent-index alias must enter the forbidden set via its targeted streaming read",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug matching an existing alias auto-suffixes (ALIAS-COLLIDES-ID guard)", () => {
  // The validator enforces ALIAS-COLLIDES-ID in addition to DUP-ID.
  // Before this guard, the forbidden set collected only frontmatter
  // `id`s, so a slug equal to an existing alias would pass
  // resolveNestSlug but trip ALIAS-COLLIDES-ID at validate-time,
  // forcing a rollback. Now aliases are reserved alongside ids in
  // every walk (parent-dir, walkWikiIds fallback, buildWikiForbiddenIndex
  // precompute). This test pins the three walk paths:
  //   (a) wikiRoot omitted → legacy parent-dir walk
  //   (b) wikiRoot provided → walkWikiIds fallback
  //   (c) opts.wikiIndex provided → precomputed path
  const wiki = tmpWiki("alias-collision");
  try {
    // Plant a sibling leaf with an alias the cluster slug will match.
    // (filename matches the leaf's id to keep the fixture
    // invariant-clean; the alias is the collision surface.)
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    writeLeaf(wiki, "gamma.md", "gamma", { tags: ["default"] });
    // Manually rewrite gamma to carry an alias.
    const gammaPath = join(wiki, "gamma.md");
    const gammaFrontmatter = {
      id: "gamma",
      type: "primary",
      depth_role: "leaf",
      focus: "gamma focus",
      parents: ["index.md"],
      covers: ["gamma cover"],
      tags: ["default"],
      aliases: ["claimed-slug"],
      activation: { keyword_matches: ["gamma"] },
    };
    writeFileSync(
      gammaPath,
      renderFrontmatter(gammaFrontmatter, "\n# gamma\n"),
      "utf8",
    );

    // (a) Legacy parent-dir walk.
    assert.equal(
      resolveNestSlug("claimed-slug", { leaves: [l1, l2] }),
      "claimed-slug-group",
      "parent-dir walk must reserve aliases",
    );

    // (b) Full-tree walkWikiIds path.
    assert.equal(
      resolveNestSlug("claimed-slug", { leaves: [l1, l2] }, wiki),
      "claimed-slug-group",
      "walkWikiIds fallback must reserve aliases",
    );

    // (c) Precomputed wikiIndex path.
    const idx = buildWikiForbiddenIndex(wiki);
    assert.ok(
      idx.has("claimed-slug"),
      "buildWikiForbiddenIndex must include aliases",
    );
    assert.equal(
      resolveNestSlug("claimed-slug", { leaves: [l1, l2] }, wiki, {
        wikiIndex: idx,
      }),
      "claimed-slug-group",
      "opts.wikiIndex path must reserve aliases",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("resolveNestSlug: slug equal to parent-dir basename auto-suffixes (DUP-ID guard)", () => {
  // The parent's `index.md` carries id === basename(parentDir) under
  // the validator invariant. If NEST's slug equals that basename, the
  // new subdir's stub index.md would also carry id === slug ===
  // basename(parentDir) → two index.md files with the same id →
  // DUP-ID at validate time. Earlier versions of this function's doc
  // claimed `applyNest`'s `existsSync(targetDir)` check caught this;
  // it doesn't, because `<parentDir>/<basename(parentDir)>/` normally
  // does NOT exist (applyNest is about to create it). The fix: add
  // basename(parentDir) to the forbidden set explicitly. This test
  // pins that behaviour.
  const parent = tmpWiki("resolve-parent-name");
  const wiki = join(parent, "root-wiki");
  mkdirSync(wiki, { recursive: true });
  try {
    const parentName = "mod-group"; // basename(cluster's parentDir)
    const clusterParent = join(wiki, parentName);
    mkdirSync(clusterParent, { recursive: true });
    writeIndex(clusterParent, "index.md", parentName);
    const l1 = writeLeaf(clusterParent, "alpha.md", "alpha");
    const l2 = writeLeaf(clusterParent, "beta.md", "beta");

    // Slug equal to parent basename must auto-suffix, NOT pass through.
    assert.equal(
      resolveNestSlug(parentName, { leaves: [l1, l2] }, wiki),
      `${parentName}-group`,
      "slug equal to basename(parentDir) must route through -group",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveNestSlug: collides with wiki-root index.md id even without wikiIndex", () => {
  // walkWikiIds' `dir === parentDir` skip used to drop every file at
  // wikiRoot, including wikiRoot/index.md. Under the validator contract
  // (validate.mjs enforces `type: index` id === `basename(dirname(
  // index.md))`), the root index id is mandatorily equal to
  // basename(wikiRoot). walkWikiIds starts iteration AT wikiRoot, so
  // wikiRoot is never encountered as a subdirectory entry and
  // basename(wikiRoot) is never added to forbidden via the
  // `entry.isDirectory()` branch. The old skip therefore left
  // basename(wikiRoot) unrepresented in the forbidden set, and a slug
  // equal to that name would slip past the resolver and surface only
  // at post-apply DUP-ID. Fixed by parsing parent's index.md as an
  // exception.
  //
  // Use a custom short-basename wiki path so (a) basename(wikiRoot)
  // passes `validateSlug` (kebab-case, ≤ 64 chars) and (b) the test
  // asserts the invariant-compliant root-id shape instead of a
  // hypothetical "public name" shape the validator would reject.
  const parent = tmpWiki("resolve-root-index");
  const wiki = join(parent, "short-wiki");
  mkdirSync(wiki, { recursive: true });
  try {
    const rootId = basename(wiki); // "short-wiki"
    // Root index is written with index-shaped frontmatter so the
    // fixture mirrors a real wiki's root shape (type: "index",
    // depth_role: "category") — the validator enforces both.
    writeIndex(wiki, "index.md", rootId);
    const l1 = writeLeaf(wiki, "alpha.md", "alpha");
    const l2 = writeLeaf(wiki, "beta.md", "beta");
    // Slug equals the root index id (== basename(wikiRoot)) → collision,
    // must auto-suffix.
    assert.equal(
      resolveNestSlug(rootId, { leaves: [l1, l2] }, wiki),
      `${rootId}-group`,
      "wiki-root index.md id must enter the forbidden set",
    );
    // Control: a slug that matches no live id returns unchanged.
    assert.equal(
      resolveNestSlug("fresh-slug", { leaves: [l1, l2] }, wiki),
      "fresh-slug",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveNestSlug: same-depth behaviour preserved when wikiRoot is provided", () => {
  // Regression: the v1.0.0 same-depth collision logic must still fire
  // with wikiRoot present. Tests the classical observed case — slug
  // matches a member leaf's id — but with the new full-tree path
  // exercised.
  const wiki = tmpWiki("resolve-cross-depth-regression");
  try {
    const l1 = writeLeaf(wiki, "security.md", "security");
    const l2 = writeLeaf(wiki, "audit.md", "audit");
    const l3 = writeLeaf(wiki, "hardening.md", "hardening");

    assert.equal(
      resolveNestSlug("security", { leaves: [l1, l2, l3] }, wiki),
      "security-group",
      "member-id collision detection still works with full-tree walk",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
