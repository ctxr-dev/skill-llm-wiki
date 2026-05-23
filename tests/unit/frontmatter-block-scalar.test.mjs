// frontmatter-block-scalar.test.mjs — regression for the line-based parser
// silently dropping docs whose frontmatter uses a YAML block scalar header
// carrying a chomping or indentation indicator (`>-`, `|-`, `>2`, ...).
//
// A serializer (js-yaml via gray-matter) folds long scalars to `>-` once a
// value exceeds the default ~80-col line width. The parser previously matched
// only the bare `|`/`>` headers, so `>-` was read as the literal string ">-"
// and the indented continuation line tripped "unexpected indent" — excluding
// the whole doc from index-rebuild and failing validate. These tests pin that
// every chomping/indent variant routes through the block-scalar reader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";

test("frontmatter: folded scalar with strip chomping (>-) is read, not dropped", () => {
  const raw = [
    "---",
    "id: >-",
    "  lesson-proactively-invoke-available-skills-for-the-task-frontend-ex-2026-05-23-172853332",
    "type: primary",
    "focus: >-",
    "  Proactively invoke available skills for the task (frontend-excellence,",
    "  frontend-design)",
    "---",
    "body",
    "",
  ].join("\n");
  const { data } = parseFrontmatter(raw, "<mem>");
  assert.equal(
    data.id,
    "lesson-proactively-invoke-available-skills-for-the-task-frontend-ex-2026-05-23-172853332",
  );
  assert.equal(data.type, "primary");
  assert.equal(
    data.focus,
    "Proactively invoke available skills for the task (frontend-excellence, frontend-design)",
  );
});

test("frontmatter: literal scalar with strip chomping (|-) keeps newlines", () => {
  const raw = "---\nnotes: |-\n  line one\n  line two\n---\nbody\n";
  const { data } = parseFrontmatter(raw, "<mem>");
  assert.equal(data.notes, "line one\nline two");
});

test("frontmatter: folded scalar as a bare sequence item (- >-)", () => {
  const raw = [
    "---",
    "covers:",
    "  - >-",
    "    memory: Proactively invoke available skills for the task",
    "    (frontend-excellence, frontend-design)",
    "---",
    "body",
    "",
  ].join("\n");
  const { data } = parseFrontmatter(raw, "<mem>");
  assert.deepEqual(data.covers, [
    "memory: Proactively invoke available skills for the task (frontend-excellence, frontend-design)",
  ]);
});

test("frontmatter: explicit indentation indicator (>2) is recognised", () => {
  const raw = "---\nfocus: >2\n  wrapped value\n---\nbody\n";
  const { data } = parseFrontmatter(raw, "<mem>");
  assert.equal(data.focus, "wrapped value");
});

test("frontmatter: bare | and > headers still parse (no regression)", () => {
  const literal = parseFrontmatter("---\nnote: |\n  a\n  b\n---\nbody\n", "<mem>").data;
  assert.equal(literal.note, "a\nb");
  const folded = parseFrontmatter("---\nnote: >\n  a\n  b\n---\nbody\n", "<mem>").data;
  assert.equal(folded.note, "a b");
});
