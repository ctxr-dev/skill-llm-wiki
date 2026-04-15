// draft-frontmatter-preserve.test.mjs — regression for bug #2 in the
// skill-llm-wiki Opus-review sweep. When a source leaf already carries
// a valid frontmatter block, the drafter must forward authored fields
// (activation, covers, tags, focus, domains, aliases) verbatim rather
// than inventing heuristic junk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { draftLeafFrontmatter } from "../../scripts/lib/draft.mjs";

function fakeCandidate(overrides = {}) {
  return {
    id: "sample",
    source_path: "sample.md",
    absolute_path: "/tmp/sample.md",
    ext: ".md",
    size: 500,
    hash: "sha256:deadbeef",
    kind: "prose",
    title: "Sample",
    lead: "A sample lead paragraph.",
    headings: [{ level: 2, text: "H2" }],
    authored_frontmatter: {},
    has_authored_frontmatter: false,
    body: "# Sample\n\nbody\n",
    ...overrides,
  };
}

test("draftLeafFrontmatter: authored activation block is preserved", () => {
  const authored = {
    focus: "authored focus string",
    activation: {
      keyword_matches: ["alpha", "beta"],
      tag_matches: ["any-op"],
      escalation_from: ["build", "rebuild"],
    },
    covers: ["authored cover 1", "authored cover 2"],
    tags: ["authored-tag"],
  };
  const candidate = fakeCandidate({
    authored_frontmatter: authored,
    has_authored_frontmatter: true,
  });
  const { data } = draftLeafFrontmatter(candidate, { categoryPath: "" });
  assert.equal(data.focus, "authored focus string");
  assert.deepEqual(data.activation, authored.activation);
  assert.deepEqual(data.covers, ["authored cover 1", "authored cover 2"]);
  assert.deepEqual(data.tags, ["authored-tag"]);
});

test("draftLeafFrontmatter: additional authored fields are forwarded", () => {
  const authored = {
    focus: "f",
    domains: ["dom-1"],
    aliases: ["alt"],
    overlay_targets: ["target-a"],
    links: [{ id: "target-a" }],
  };
  const candidate = fakeCandidate({
    authored_frontmatter: authored,
    has_authored_frontmatter: true,
  });
  const { data } = draftLeafFrontmatter(candidate, { categoryPath: "ops" });
  assert.deepEqual(data.domains, ["dom-1"]);
  assert.deepEqual(data.aliases, ["alt"]);
  assert.deepEqual(data.overlay_targets, ["target-a"]);
  assert.deepEqual(data.links, [{ id: "target-a" }]);
});

test("draftLeafFrontmatter: falls back to heuristics when authored is empty", () => {
  const candidate = fakeCandidate({
    title: "Fallback Title",
    headings: [{ level: 2, text: "Section A" }, { level: 2, text: "Section B" }],
  });
  const { data } = draftLeafFrontmatter(candidate, { categoryPath: "" });
  assert.equal(data.focus, "Fallback Title");
  // drafted covers from H2 headings
  assert.ok(data.covers.includes("Section A"));
  assert.ok(data.covers.includes("Section B"));
  // Without authored activation, there should be no activation key.
  assert.equal(data.activation, undefined);
});

test("draftLeafFrontmatter: heuristic values fill in for partial authored frontmatter", () => {
  // Author supplied focus + activation but NOT covers. Drafter should
  // still synthesise covers from the headings while keeping the
  // authored focus and activation intact.
  const authored = {
    focus: "authored focus",
    activation: { keyword_matches: ["kw"] },
  };
  const candidate = fakeCandidate({
    authored_frontmatter: authored,
    has_authored_frontmatter: true,
    headings: [{ level: 2, text: "Cover Synth" }],
  });
  const { data } = draftLeafFrontmatter(candidate, { categoryPath: "" });
  assert.equal(data.focus, "authored focus");
  assert.deepEqual(data.activation, { keyword_matches: ["kw"] });
  assert.ok(data.covers.includes("Cover Synth"));
});
