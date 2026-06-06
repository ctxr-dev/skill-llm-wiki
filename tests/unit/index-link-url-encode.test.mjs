// index-link-url-encode.test.mjs — regression guard for navigable links.
//
// rebuildIndex emits the auto-generated navigation as a markdown table of
// `[label](destination)` links. The destination MUST be URL-encoded: a child
// folder or leaf whose name contains a space (or other special char) otherwise
// produces `[Foo Bar](Foo Bar/index.md)`, which Obsidian and standard markdown
// cannot follow (the space terminates the link destination). The label stays
// human-readable; only the destination is encoded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rebuildIndex } from "../../scripts/lib/indices.mjs";
import { withTmp } from "../helpers/tmp.mjs";

function leaf(id, focus) {
  return `---\nid: ${id}\ntype: primary\ndepth_role: leaf\nfocus: ${focus}\nparents:\n  - index.md\n---\n\n# ${focus}\n`;
}
function subIndex(id, focus) {
  return `---\nid: ${id}\ntype: index\ndepth_role: subcategory\nfocus: ${focus}\nparents:\n  - ../index.md\n---\n`;
}

// Pull every link destination out of the rendered index body.
function destinations(body) {
  return [...body.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
}

test("rebuildIndex URL-encodes link destinations for names with spaces", async () => {
  await withTmp("idx-link-enc", async (wiki) => {
    // A leaf and a child subdir, each with a space in the name.
    writeFileSync(join(wiki, "my note.md"), leaf("my-note", "spaced leaf"));
    mkdirSync(join(wiki, "foo bar"), { recursive: true });
    writeFileSync(join(wiki, "foo bar", "index.md"), subIndex("foo-bar", "spaced folder"));
    // A normal slugified leaf must be left untouched (encode is a no-op).
    writeFileSync(join(wiki, "alpha-note.md"), leaf("alpha-note", "normal leaf"));

    rebuildIndex(wiki, wiki);
    const body = readFileSync(join(wiki, "index.md"), "utf8");
    const dests = destinations(body);

    // The spaced names are encoded in the destination...
    assert.ok(dests.includes("my%20note.md"), `leaf dest encoded; got ${JSON.stringify(dests)}`);
    assert.ok(dests.includes("foo%20bar/index.md"), `folder dest encoded; got ${JSON.stringify(dests)}`);
    // ...and the normal name is unchanged (no spurious encoding).
    assert.ok(dests.includes("alpha-note.md"), `normal dest unchanged; got ${JSON.stringify(dests)}`);

    // No destination may contain a raw space (the bug).
    for (const d of dests) {
      assert.ok(!d.includes(" "), `destination has a raw space: ${JSON.stringify(d)}`);
    }

    // Every encoded destination round-trips to a real on-disk relative path.
    for (const d of dests) {
      const decoded = d.split("/").map(decodeURIComponent).join("/");
      assert.ok(
        readFileSync(join(wiki, decoded), "utf8").length >= 0,
        `decoded destination ${decoded} resolves to a file`,
      );
    }

    // The human-readable label keeps the raw (decoded) path.
    assert.match(body, /\[foo bar\/index\.md\]\(foo%20bar\/index\.md\)/);
    assert.match(body, /\[my note\.md\]\(my%20note\.md\)/);
  });
});
