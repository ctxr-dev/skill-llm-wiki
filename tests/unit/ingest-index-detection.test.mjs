// ingest-index-detection.test.mjs — regression for bug #4 in the
// skill-llm-wiki Opus-review sweep. Source files literally named
// `index.md` (and any source with `type: index` in its frontmatter)
// must be classified as index inputs — NOT promoted to leaves.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestSource } from "../../scripts/lib/ingest.mjs";

function tmp() {
  return join(
    tmpdir(),
    `skill-llm-wiki-ingest-idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

test("ingestSource: root index.md is classified as an index source", () => {
  const src = tmp();
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "index.md"),
      "---\nid: wiki\ntype: index\ndepth_role: category\nfocus: root\nparents: []\nshared_covers:\n  - shared A\n---\n\norientation prose\n",
    );
    writeFileSync(
      join(src, "leaf.md"),
      "---\nid: leaf\ntype: primary\ndepth_role: leaf\nfocus: leaf\nparents:\n  - index.md\n---\n\n# Leaf\n",
    );
    const { leaves, indexSources } = ingestSource(src);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].id, "leaf");
    assert.equal(indexSources.length, 1);
    assert.equal(indexSources[0].source_path, "index.md");
    assert.equal(indexSources[0].dir, "");
    assert.deepEqual(indexSources[0].authored_frontmatter.shared_covers, ["shared A"]);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("ingestSource: nested operations/index.md is classified with dir", () => {
  const src = tmp();
  try {
    mkdirSync(join(src, "operations"), { recursive: true });
    writeFileSync(
      join(src, "operations", "index.md"),
      "---\nid: operations\ntype: index\ndepth_role: subcategory\nfocus: ops\nparents:\n  - ../index.md\nactivation_defaults:\n  tag_matches:\n    - operation\n---\n",
    );
    writeFileSync(
      join(src, "operations", "build.md"),
      "---\nid: build\ntype: primary\ndepth_role: leaf\nfocus: build\nparents:\n  - index.md\n---\n\n# Build\n",
    );
    const { leaves, indexSources } = ingestSource(src);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0].id, "build");
    assert.equal(indexSources.length, 1);
    assert.equal(indexSources[0].dir, "operations");
    assert.deepEqual(
      indexSources[0].authored_frontmatter.activation_defaults,
      { tag_matches: ["operation"] },
    );
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("ingestSource: a leaf with type: index in frontmatter is also an index source", () => {
  const src = tmp();
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "catalog.md"),
      "---\nid: catalog\ntype: index\ndepth_role: category\nfocus: catalog\nparents: []\n---\n",
    );
    writeFileSync(
      join(src, "leaf.md"),
      "---\nid: leaf\ntype: primary\ndepth_role: leaf\nfocus: leaf\nparents:\n  - index.md\n---\n\n# Leaf\n",
    );
    const { leaves, indexSources } = ingestSource(src);
    assert.equal(leaves.length, 1);
    assert.equal(indexSources.length, 1);
    assert.equal(indexSources[0].source_path, "catalog.md");
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test("ingestSource: body is stripped of source frontmatter (no double-stack)", () => {
  const src = tmp();
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "leaf.md"),
      "---\nid: leaf\ntype: primary\ndepth_role: leaf\nfocus: leaf\nparents:\n  - index.md\n---\n\n# Body heading\n\nbody content only\n",
    );
    const { leaves } = ingestSource(src);
    assert.equal(leaves.length, 1);
    const body = leaves[0].body;
    // The body must NOT start with another `---` fence.
    assert.ok(!body.startsWith("---\n"), `body should not start with a fence: ${body.slice(0, 30)}`);
    assert.match(body, /# Body heading/);
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});
