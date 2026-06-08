// frontmatter-escaped-quote-seq.test.mjs — regression for the line-based
// parser mis-reading a double-quoted sequence scalar that contains an escaped
// quote (`\"`) followed by an inner `: `.
//
// findKeyColon tracked double-quote state but did not skip `\"` escapes, so in
// a value like `"... fmt.Errorf(\"...: %w\", err) ..."` the escaped quote
// wrongly closed the string and the inner `: ` was seen as a key separator.
// parseSeq then treated the scalar item as a `- key: value` map, dropping the
// string (it came back undefined). On a build round-trip (read-modify-write,
// e.g. soft-dag-parents) the re-render then emitted corrupt, invalid YAML.
// These tests pin that such a scalar parses as a string and round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, renderFrontmatter } from "../../scripts/lib/frontmatter.mjs";

const VALUE =
  'Errors wrapped with `fmt.Errorf("...: %w", err)` for `errors.Is`/`errors.As` chains';

test("seq scalar with an escaped quote and inner colon parses as a string", () => {
  const raw = [
    "---",
    "id: lang-go",
    "audit_surface:",
    '  - "Errors wrapped with `fmt.Errorf(\\"...: %w\\", err)` for `errors.Is`/`errors.As` chains"',
    "---",
    "body",
  ].join("\n");
  const { data } = parseFrontmatter(raw, "lang-go.md");
  assert.ok(Array.isArray(data.audit_surface), "audit_surface should be a list");
  assert.equal(data.audit_surface.length, 1);
  assert.equal(typeof data.audit_surface[0], "string");
  assert.equal(data.audit_surface[0], VALUE);
});

test("the escaped-quote scalar round-trips (parse -> render -> parse) unchanged", () => {
  const raw = [
    "---",
    "id: lang-go",
    "audit_surface:",
    '  - "Errors wrapped with `fmt.Errorf(\\"...: %w\\", err)` for `errors.Is`/`errors.As` chains"',
    "---",
    "the body",
  ].join("\n");
  const first = parseFrontmatter(raw, "lang-go.md");
  const rendered = renderFrontmatter(first.data, first.body);
  const second = parseFrontmatter(rendered, "lang-go.md");
  assert.deepEqual(second.data.audit_surface, [VALUE]);
  // idempotent: a second render equals the first.
  assert.equal(renderFrontmatter(second.data, second.body), rendered);
});

test("a map value with an escaped quote and inner colon keeps its key", () => {
  const raw = [
    "---",
    'focus: "Detect fmt.Errorf(\\"...: %w\\") misuse"',
    "id: x",
    "---",
    "b",
  ].join("\n");
  const { data } = parseFrontmatter(raw, "x.md");
  assert.equal(data.id, "x");
  assert.equal(data.focus, 'Detect fmt.Errorf("...: %w") misuse');
});
