// root-containment.test.mjs — synthetic wiki with root-level outliers;
// verifies that `runRootContainment` moves each into its own
// per-slug subcategory, writes a stub index, rewrites parents[]
// correctly, and is byte-stable across repeated runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  renderFrontmatter,
} from "../../scripts/lib/frontmatter.mjs";
import { runRootContainment } from "../../scripts/lib/root-containment.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-rootcont-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    focus: extra.focus ?? `${id} focus`,
    parents: extra.parents ?? ["index.md"],
    covers: extra.covers ?? [`${id} cover`],
    tags: extra.tags ?? ["default"],
    activation: { keyword_matches: extra.kw ?? [id] },
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n"), "utf8");
  return { path: full, data };
}

function writeIndex(wikiRoot, relPath, id, extra = {}) {
  const full = join(wikiRoot, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  const isRootIndex = relPath === "index.md";
  const defaultParents = isRootIndex ? [] : ["../index.md"];
  const data = {
    id,
    type: "index",
    depth_role: extra.depth_role ?? (isRootIndex ? "category" : "subcategory"),
    focus: extra.focus ?? `${id} category`,
    parents: extra.parents ?? defaultParents,
    tags: extra.tags ?? ["default"],
  };
  writeFileSync(full, renderFrontmatter(data, "\n# " + id + "\n"), "utf8");
  return { path: full, data };
}

function readFm(path) {
  return parseFrontmatter(readFileSync(path, "utf8"), path).data;
}

test("runRootContainment: zero outliers → no-op", async () => {
  const wiki = tmpWiki("zero");
  try {
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "alpha/index.md", "alpha");
    writeLeaf(wiki, "alpha/leaf-a.md", "leaf-a");

    const result = await runRootContainment(wiki);
    assert.equal(result.outliers, 0);
    assert.equal(result.moved, 0);
    assert.deepEqual(result.operations, []);
    // Tree unchanged.
    assert.ok(existsSync(join(wiki, "alpha/leaf-a.md")));
    assert.ok(!readdirSync(wiki).some((n) => n.endsWith(".md") && n !== "index.md"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: single outlier → own subcategory", async () => {
  const wiki = tmpWiki("single");
  try {
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "alpha/index.md", "alpha");
    writeLeaf(wiki, "alpha/leaf-a.md", "leaf-a", {
      covers: ["alpha cover"],
      tags: ["alpha-tag"],
      kw: ["alpha"],
    });
    // Outlier at root.
    writeLeaf(wiki, "bidi-rtl-locale.md", "bidi-rtl-locale", {
      focus: "Detect bidirectional text rendering and Turkish I casing",
      covers: ["bidi override characters", "Turkish I case folding"],
      tags: ["bidi", "locale", "rtl"],
      kw: ["bidi", "rtl", "locale"],
    });

    const result = await runRootContainment(wiki);
    assert.equal(result.outliers, 1);
    assert.equal(result.moved, 1);
    assert.equal(result.operations.length, 1);

    const op = result.operations[0];
    assert.match(op.slug, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(existsSync(op.to), "moved leaf exists");
    assert.ok(!existsSync(op.from), "original path is gone");
    const stubIndex = join(wiki, op.slug, "index.md");
    assert.ok(existsSync(stubIndex), "stub index.md exists");

    const stubFm = readFm(stubIndex);
    assert.equal(stubFm.id, op.slug);
    assert.equal(stubFm.type, "index");
    assert.equal(stubFm.depth_role, "subcategory");
    assert.ok(typeof stubFm.focus === "string" && stubFm.focus.length > 0);

    // Leaf parents[] unchanged primary (same-dir "index.md").
    const leafFm = readFm(op.to);
    assert.equal(leafFm.parents[0], "index.md");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: two outliers → two distinct subcategories", async () => {
  const wiki = tmpWiki("two");
  try {
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "alpha/index.md", "alpha");
    writeLeaf(wiki, "alpha/leaf-a.md", "leaf-a");
    writeLeaf(wiki, "bidi-rtl-locale.md", "bidi-rtl-locale", {
      focus: "Detect bidi rtl Turkish casing",
      covers: ["bidi override", "Turkish I"],
      tags: ["bidi", "locale"],
      kw: ["bidi", "rtl", "locale"],
    });
    writeLeaf(wiki, "file-path-cross-platform.md", "file-path-cross-platform", {
      focus: "Detect hardcoded path separators and symlink traversal",
      covers: ["path separator", "symlink traversal"],
      tags: ["path", "symlink"],
      kw: ["path", "symlink", "join"],
    });

    const result = await runRootContainment(wiki);
    assert.equal(result.outliers, 2);
    assert.equal(result.moved, 2);

    const slugs = result.operations.map((o) => o.slug);
    assert.equal(new Set(slugs).size, 2, "slugs must be distinct");

    for (const op of result.operations) {
      assert.ok(existsSync(op.to));
      assert.ok(existsSync(join(wiki, op.slug, "index.md")));
    }

    // No root-level .md left besides index.md.
    const rootFiles = readdirSync(wiki).filter(
      (n) => n.endsWith(".md") && n !== "index.md",
    );
    assert.deepEqual(rootFiles, []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: slug collision with existing subcategory → fallback", async () => {
  const wiki = tmpWiki("collide");
  try {
    writeIndex(wiki, "index.md", "root");
    // Pre-create a subcategory whose name is likely to collide with the
    // generated slug. The outlier is about "locale" and nothing else, so
    // the natural slug candidate is "locale" or similar. We plant an
    // existing "locale" subcat to force collision-resolver to use a
    // "-group" / "-group-N" fallback.
    writeIndex(wiki, "locale/index.md", "locale", {
      focus: "locale handling existing subcategory",
      tags: ["locale"],
    });
    writeLeaf(wiki, "locale/existing-leaf.md", "existing-leaf", {
      tags: ["locale"],
    });
    writeLeaf(wiki, "locale-rtl.md", "locale-rtl", {
      focus: "locale rtl bidi",
      covers: ["locale rtl"],
      tags: ["locale", "rtl"],
      kw: ["locale", "rtl"],
    });

    const result = await runRootContainment(wiki);
    assert.equal(result.moved, 1);
    const op = result.operations[0];
    // The resolver MUST NOT pick "locale" (already taken). Any non-colliding
    // slug is acceptable — the key guarantee is that a new directory was
    // created distinct from the existing one.
    assert.notEqual(op.slug, "locale");
    assert.ok(existsSync(join(wiki, op.slug, "index.md")));
    // Existing "locale" subcat untouched.
    assert.ok(existsSync(join(wiki, "locale/existing-leaf.md")));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: determinism across runs (byte-identical slug assignment)", async () => {
  const buildWiki = (tag) => {
    const wiki = tmpWiki(tag);
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "alpha/index.md", "alpha");
    writeLeaf(wiki, "alpha/leaf-a.md", "leaf-a");
    writeLeaf(wiki, "bidi-rtl-locale.md", "bidi-rtl-locale", {
      focus: "bidi rtl Turkish",
      covers: ["bidi override", "Turkish I"],
      tags: ["bidi", "locale"],
      kw: ["bidi", "rtl"],
    });
    writeLeaf(wiki, "file-path-cross-platform.md", "file-path-cross-platform", {
      focus: "path separators symlink",
      covers: ["path separator", "symlink"],
      tags: ["path", "symlink"],
      kw: ["path", "symlink"],
    });
    return wiki;
  };

  const wikiA = buildWiki("det-a");
  const wikiB = buildWiki("det-b");
  try {
    const a = await runRootContainment(wikiA);
    const b = await runRootContainment(wikiB);
    const slugsA = a.operations
      .map((o) => `${basename(o.from)}→${o.slug}`)
      .sort();
    const slugsB = b.operations
      .map((o) => `${basename(o.from)}→${o.slug}`)
      .sort();
    assert.deepEqual(slugsA, slugsB, "slug assignment must be byte-stable");
  } finally {
    rmSync(wikiA, { recursive: true, force: true });
    rmSync(wikiB, { recursive: true, force: true });
  }
});

test("runRootContainment: already-'../'-prefixed parent is preserved byte-identical", async () => {
  // A depth-1 leaf whose frontmatter carries an already-"../"-prefixed
  // parent is a depth-contract violation on the input — there is no
  // legitimate parent above wikiRoot to reference. Blindly prepending
  // another "../" during containment would turn "../foo" into
  // "../../foo", escaping the wiki root. X.11 preserves the malformed
  // entry as-is and lets validation surface it post-containment.
  const wiki = tmpWiki("escaping");
  try {
    writeIndex(wiki, "index.md", "root");
    writeLeaf(wiki, "escapee.md", "escapee", {
      focus: "escapee focus",
      parents: ["index.md", "../above-root/index.md"],
      tags: ["escapee"],
      kw: ["escapee"],
    });
    const result = await runRootContainment(wiki);
    assert.equal(result.moved, 1);
    const op = result.operations[0];
    const leafFm = readFm(op.to);
    assert.equal(leafFm.parents[0], "index.md", "primary stays same-dir");
    assert.equal(
      leafFm.parents[1],
      "../above-root/index.md",
      "already-escaping entry preserved byte-identical (no double '../')",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: parents[] rewrite — non-primary gains '../' prefix", async () => {
  const wiki = tmpWiki("parents");
  try {
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "beta/index.md", "beta");
    writeLeaf(wiki, "beta/beta-leaf.md", "beta-leaf");
    // Outlier with a soft-parent pointer at wiki root (depth 1).
    // `"beta/index.md"` is relative to the old leaf-dir (wiki root). After
    // containment the leaf moves one level deeper, so the same target must
    // be reachable via `"../beta/index.md"`.
    writeLeaf(wiki, "outlier.md", "outlier", {
      focus: "outlier focus",
      parents: ["index.md", "beta/index.md"],
      tags: ["outlier"],
      kw: ["outlier"],
    });

    const result = await runRootContainment(wiki);
    assert.equal(result.moved, 1);
    const op = result.operations[0];
    const leafFm = readFm(op.to);
    assert.equal(leafFm.parents[0], "index.md", "primary stays index.md");
    assert.equal(
      leafFm.parents[1],
      "../beta/index.md",
      "non-primary gets ../ prefix",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("runRootContainment: skips dotfiles, frontmatter-less, and malformed-fence root files", async () => {
  const wiki = tmpWiki("skip");
  try {
    writeIndex(wiki, "index.md", "root");
    writeIndex(wiki, "alpha/index.md", "alpha");
    writeLeaf(wiki, "alpha/leaf-a.md", "leaf-a");
    // Dotfile at root — must not be treated as outlier.
    writeFileSync(join(wiki, ".gitignore"), "node_modules\n", "utf8");
    // Frontmatter-less root README — no opening `---` fence, so
    // `readFrontmatterStreaming` returns null and `collectRootLeaves`
    // skips it silently. The validator does NOT emit a PARSE finding
    // for this shape (no fence → not recognised as a wiki entry at
    // all); it's invisible to ingest and validation alike. X.11
    // containment is about routable leaves; non-corpus markdown at
    // root stays put.
    writeFileSync(join(wiki, "README.md"), "# Readme\n\nnot corpus\n", "utf8");
    // Malformed frontmatter: opening fence with no closing fence
    // within the streaming read's byte budget. This exercises the
    // `catch` path in `collectRootLeaves` — `readFrontmatterStreaming`
    // throws, the per-file try/catch swallows it, and the file is
    // skipped rather than halting the pass.
    writeFileSync(
      join(wiki, "rogue-unclosed-fence.md"),
      "---\nid: rogue\ntype: primary\n\n# no closing fence ever\n\n" +
        "body text without the terminating --- line\n",
      "utf8",
    );

    const result = await runRootContainment(wiki);
    assert.equal(result.outliers, 0);
    assert.equal(result.moved, 0);
    assert.ok(existsSync(join(wiki, ".gitignore")));
    assert.ok(existsSync(join(wiki, "README.md")));
    assert.ok(existsSync(join(wiki, "rogue-unclosed-fence.md")));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
