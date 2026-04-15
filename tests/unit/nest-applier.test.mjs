// nest-applier.test.mjs — synthetic wiki + NEST proposal; verifies
// files moved, parents[] rewritten, stub created, slug validation,
// and precondition failures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter, renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { applyNest, validateSlug } from "../../scripts/lib/nest-applier.mjs";

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
