// index-activation-aggregation.test.mjs — historical regression
// test file for the literal-routing substrate. The semantic
// routing rewrite (see SKILL.md "Routing into guide.wiki/") drops
// the two aggregation tests that used to live here: parent
// `entries[]` no longer carries child `activation` blocks, and
// parent indices no longer synthesise `activation_defaults` from
// their members. The remaining test covers the still-relevant
// authored-source forwarding path: a user-authored source
// `index.md` that carries `activation_defaults` round-trips
// through rebuildIndex unmolested, because the field is still in
// AUTHORED_FIELDS as a free-form hint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rebuildAllIndices, rebuildIndex } from "../../scripts/lib/indices.mjs";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";

function tmp() {
  return join(
    tmpdir(),
    `skill-llm-wiki-idx-act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

test("rebuildIndex: parent entries[] carries leaf id/type/focus/tags but NOT activation", () => {
  // Post-semantic-routing behaviour: the parent's entries[] is
  // the self-sufficient semantic routing table — `id`, `file`,
  // `type`, `focus`, and any authored `tags`. The child's own
  // `activation` block stays on the leaf file (as an optional
  // hint consulted AFTER the leaf is opened) and is NOT copied
  // into the parent index.
  const wiki = tmp();
  try {
    mkdirSync(wiki, { recursive: true });
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: wiki\ntype: index\ndepth_role: category\nfocus: root\nparents: []\ngenerator: skill-llm-wiki/v1\n---\n",
    );
    writeFileSync(
      join(wiki, "alpha.md"),
      [
        "---",
        "id: alpha",
        "type: primary",
        "depth_role: leaf",
        "focus: alpha entry",
        "parents:",
        "  - index.md",
        "tags:",
        "  - alpha-tag",
        "activation:",
        "  keyword_matches:",
        "    - alpha",
        "    - primary",
        "  tag_matches:",
        "    - any-op",
        "  escalation_from:",
        "    - build",
        "---",
        "",
        "# Alpha body",
      ].join("\n"),
    );
    rebuildAllIndices(wiki);
    const { data } = parseFrontmatter(
      readFileSync(join(wiki, "index.md"), "utf8"),
    );
    assert.ok(Array.isArray(data.entries));
    const alpha = data.entries.find((e) => e.id === "alpha");
    assert.ok(alpha, "alpha entry missing from index");
    assert.equal(alpha.id, "alpha");
    assert.equal(alpha.type, "primary");
    assert.equal(alpha.focus, "alpha entry");
    assert.deepEqual(alpha.tags, ["alpha-tag"]);
    // Semantic-routing guarantee: no activation block bubbles
    // up into the parent record. This is the literal-routing
    // substrate that was removed.
    assert.equal(
      alpha.activation,
      undefined,
      "leaf activation must NOT leak into parent entries[]",
    );
    // And the parent index itself does not synthesise an
    // activation_defaults block from member signals.
    assert.equal(
      data.activation_defaults,
      undefined,
      "parent index must NOT auto-aggregate activation_defaults",
    );

    // The leaf file itself still carries its authored activation
    // block — the hint data survives on-disk for the semantic
    // router to consult after it opens the leaf.
    const leafRaw = readFileSync(join(wiki, "alpha.md"), "utf8");
    const { data: leafData } = parseFrontmatter(leafRaw);
    assert.deepEqual(leafData.activation, {
      keyword_matches: ["alpha", "primary"],
      tag_matches: ["any-op"],
      escalation_from: ["build"],
    });
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("rebuildIndex: derives a descriptive focus + tag union from children, bubbling up", () => {
  const wiki = tmp();
  try {
    mkdirSync(join(wiki, "cat"), { recursive: true });
    // root + cat indices start as stale "subtree under" placeholders.
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: wiki\ntype: index\ndepth_role: category\nfocus: subtree under wiki\nparents: []\ngenerator: skill-llm-wiki/v1\n---\n",
    );
    writeFileSync(
      join(wiki, "cat", "index.md"),
      "---\nid: cat\ntype: index\ndepth_role: subcategory\nfocus: subtree under cat\nparents:\n  - ../index.md\ngenerator: skill-llm-wiki/v1\n---\n",
    );
    writeFileSync(
      join(wiki, "cat", "leaf-cards.md"),
      [
        "---",
        "id: leaf-cards",
        "type: primary",
        "depth_role: leaf",
        "focus: backtest cards badges must read as data-driven",
        "parents:",
        "  - index.md",
        "tags:",
        "  - cards",
        "  - badges",
        "---",
        "",
        "# Backtest cards",
      ].join("\n"),
    );
    rebuildAllIndices(wiki);

    const cat = parseFrontmatter(readFileSync(join(wiki, "cat", "index.md"), "utf8")).data;
    assert.ok(!/^subtree under /.test(cat.focus), `cat focus still a placeholder: ${cat.focus}`);
    assert.match(cat.focus, /backtest cards/, `cat focus should summarise its leaf: ${cat.focus}`);
    assert.ok(
      Array.isArray(cat.tags) && cat.tags.includes("cards"),
      `cat tag-union should include 'cards': ${JSON.stringify(cat.tags)}`,
    );

    // Bubble-up: the root focus aggregates the cat subtree, so 'cards' is reachable from the top.
    const root = parseFrontmatter(readFileSync(join(wiki, "index.md"), "utf8")).data;
    assert.ok(!/^subtree under /.test(root.focus), `root focus still a placeholder: ${root.focus}`);
    assert.match(root.focus, /cards/, `root focus should bubble up the leaf topic: ${root.focus}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("rebuildIndex: authored source index shared_covers and activation_defaults are forwarded", () => {
  const wiki = tmp();
  try {
    mkdirSync(wiki, { recursive: true });
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: wiki\ntype: index\ndepth_role: category\nfocus: root\nparents: []\ngenerator: skill-llm-wiki/v1\n---\n",
    );
    writeFileSync(
      join(wiki, "leaf.md"),
      "---\nid: leaf\ntype: primary\ndepth_role: leaf\nfocus: leaf\nparents:\n  - index.md\n---\n\n# Leaf\n",
    );
    // Simulate the orchestrator having picked up an authored source
    // index with shared_covers + activation_defaults + orientation.
    const indexInputs = {
      "": {
        source_path: "index.md",
        dir: "",
        body:
          "<!-- BEGIN AUTO-GENERATED NAVIGATION -->\n\n<!-- END AUTO-GENERATED NAVIGATION -->\n\n<!-- BEGIN AUTHORED ORIENTATION -->\nauthored prose from source\n<!-- END AUTHORED ORIENTATION -->\n",
        authored_frontmatter: {
          shared_covers: ["covered thing one", "covered thing two"],
          activation_defaults: { tag_matches: ["operation"] },
          orientation: "fallback orientation",
        },
      },
    };
    rebuildAllIndices(wiki, { indexInputs });
    const raw = readFileSync(join(wiki, "index.md"), "utf8");
    const { data, body } = parseFrontmatter(raw);
    assert.ok(
      data.shared_covers.includes("covered thing one"),
      `shared_covers missing authored source entry: ${JSON.stringify(data.shared_covers)}`,
    );
    assert.deepEqual(data.activation_defaults, { tag_matches: ["operation"] });
    assert.match(body, /authored prose from source/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
