// chunk-iterator.test.mjs — unit tests for scripts/lib/chunk.mjs.
//
// Properties under test:
//   1. Deterministic sort order across the full walk.
//   2. `.llmwiki/`, `.work/`, `.shape/` are never yielded.
//   3. Files without a `---\n` opening fence are silently skipped.
//   4. Files whose frontmatter exceeds 64 KB without a closing fence
//      raise a loud error.
//   5. `loadBody()` is lazy: iterating without calling it performs
//      zero body-byte loads (proven via `getBodyMetrics().totalBodyLoads`).
//   6. `loadBody()` returns only the body (no frontmatter).
//   7. `loadBody()` increments the in-flight counter; `releaseBody()`
//      decrements it; the peak reflects reality.
//   8. Multi-level nesting is handled (iterative walk, deterministic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  collectEntryPaths,
  collectFrontmatterOnly,
  getBodyMetrics,
  iterEntries,
  readFrontmatterStreaming,
  releaseBody,
  resetBodyMetrics,
} from "../../scripts/lib/chunk.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-chunk-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function leaf(id, { focus = "x", body = "body bytes\n" } = {}) {
  return (
    "---\n" +
    `id: ${id}\n` +
    "type: primary\n" +
    "depth_role: leaf\n" +
    `focus: "${focus}"\n` +
    "parents:\n" +
    "  - ../index.md\n" +
    "---\n\n" +
    body
  );
}

test("collectEntryPaths returns md files in sorted order, skipping dot dirs", () => {
  const wiki = tmpWiki("sort");
  try {
    mkdirSync(join(wiki, "api"), { recursive: true });
    mkdirSync(join(wiki, "concepts"), { recursive: true });
    mkdirSync(join(wiki, ".llmwiki", "git"), { recursive: true });
    mkdirSync(join(wiki, ".work"), { recursive: true });
    mkdirSync(join(wiki, ".shape"), { recursive: true });
    writeFileSync(join(wiki, "index.md"), leaf("root"));
    writeFileSync(join(wiki, "api", "zeta.md"), leaf("zeta"));
    writeFileSync(join(wiki, "api", "alpha.md"), leaf("alpha"));
    writeFileSync(join(wiki, "concepts", "beta.md"), leaf("beta"));
    // Files inside the dot dirs MUST be skipped.
    writeFileSync(join(wiki, ".llmwiki", "noise.md"), leaf("noise"));
    writeFileSync(join(wiki, ".work", "scratch.md"), leaf("scratch"));
    writeFileSync(join(wiki, ".shape", "hint.md"), leaf("hint"));

    const paths = collectEntryPaths(wiki);
    // Normalize to POSIX-separator relative paths so the assertion is
    // platform-independent. `relative` uses the current platform's
    // separator (`\` on Windows); we swap to `/` before comparing.
    const rel = paths.map((p) => relative(wiki, p).split(sep).join("/"));
    assert.deepEqual(rel, [
      "api/alpha.md",
      "api/zeta.md",
      "concepts/beta.md",
      "index.md",
    ]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("iterEntries yields frontmatter parsed for every entry, zero bodies loaded", async () => {
  const wiki = tmpWiki("lazy");
  try {
    writeFileSync(join(wiki, "a.md"), leaf("a", { body: "A body\n" }));
    writeFileSync(join(wiki, "b.md"), leaf("b", { body: "B body\n" }));
    resetBodyMetrics();
    const ids = [];
    for await (const entry of iterEntries(wiki)) {
      ids.push(entry.data.id);
    }
    assert.deepEqual(ids.sort(), ["a", "b"]);
    // Consumer never called loadBody — counters must be zero.
    assert.equal(getBodyMetrics().totalBodyLoads, 0);
    assert.equal(getBodyMetrics().peakInFlightBodies, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("loadBody returns only the body, no frontmatter bytes", async () => {
  const wiki = tmpWiki("body-only");
  try {
    writeFileSync(
      join(wiki, "entry.md"),
      leaf("entry", { body: "LEAF_BODY_MARKER\n" }),
    );
    resetBodyMetrics();
    for await (const entry of iterEntries(wiki)) {
      const body = await entry.loadBody();
      assert.ok(body.includes("LEAF_BODY_MARKER"));
      assert.ok(!body.includes("id: entry"));
      assert.ok(!body.includes("---"));
      releaseBody();
    }
    assert.equal(getBodyMetrics().totalBodyLoads, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("body metrics track peak concurrent loads when a consumer holds multiple", async () => {
  const wiki = tmpWiki("peak");
  try {
    writeFileSync(join(wiki, "a.md"), leaf("a"));
    writeFileSync(join(wiki, "b.md"), leaf("b"));
    writeFileSync(join(wiki, "c.md"), leaf("c"));
    resetBodyMetrics();
    const held = [];
    for await (const entry of iterEntries(wiki)) {
      held.push(await entry.loadBody());
    }
    // Never released → in-flight stays at 3, peak is 3.
    const m = getBodyMetrics();
    assert.equal(m.inFlightBodies, 3);
    assert.equal(m.peakInFlightBodies, 3);
    assert.equal(m.totalBodyLoads, 3);
    // Explicit release brings it back to zero.
    held.forEach(() => releaseBody());
    assert.equal(getBodyMetrics().inFlightBodies, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("streaming consumer pattern keeps peak at 1 even for large corpora", async () => {
  const wiki = tmpWiki("streaming");
  try {
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(wiki, `e${String(i).padStart(2, "0")}.md`),
        leaf(`e${i}`, { body: "x".repeat(200) }),
      );
    }
    resetBodyMetrics();
    let total = 0;
    for await (const entry of iterEntries(wiki)) {
      const body = await entry.loadBody();
      total += body.length;
      releaseBody(); // discipline: release before moving on
    }
    assert.ok(total > 0);
    const m = getBodyMetrics();
    assert.equal(m.peakInFlightBodies, 1, "streaming consumer must peak at 1");
    assert.equal(m.totalBodyLoads, 20);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("files without a frontmatter fence are skipped silently", async () => {
  const wiki = tmpWiki("no-fm");
  try {
    writeFileSync(join(wiki, "plain.md"), "# Just a heading\n\nno frontmatter\n");
    writeFileSync(join(wiki, "real.md"), leaf("real"));
    const ids = [];
    for await (const entry of iterEntries(wiki)) {
      ids.push(entry.data.id);
    }
    assert.deepEqual(ids, ["real"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readFrontmatterStreaming throws on frontmatter exceeding the pathology ceiling", () => {
  const wiki = tmpWiki("huge-fm");
  try {
    // > 256 KB of frontmatter-looking content with no closing fence.
    // One line is 44 bytes; we need > 256*1024 = 262144 bytes of
    // bloat. 6500 lines × 44 bytes ≈ 286 KB, safely above the ceiling.
    const bloat = Array(6500).fill("  - " + "x".repeat(40)).join("\n");
    const pathologic =
      "---\n" + "id: huge\n" + "bloat:\n" + bloat + "\nbody never arrives\n";
    const full = join(wiki, "huge.md");
    writeFileSync(full, pathologic);
    assert.throws(
      () => readFrontmatterStreaming(full),
      /no closing --- fence within 262144 bytes/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readFrontmatterStreaming handles exact-fit frontmatter near the read chunk boundary", () => {
  const wiki = tmpWiki("boundary");
  try {
    // Produce a frontmatter whose closing fence lands within the first
    // 4 KB chunk but right at the edge, to exercise the split-across-
    // chunks path. We pad the yaml so the closing `---` sits at offset
    // ~4090, forcing two fs.readSync calls before the fence is found.
    const pad = "pad: " + "x".repeat(3900);
    const content = "---\nid: edge\n" + pad + "\n---\n\nbody\n";
    const p = join(wiki, "edge.md");
    writeFileSync(p, content);
    const captured = readFrontmatterStreaming(p);
    assert.ok(captured !== null);
    assert.ok(captured.frontmatterText.endsWith("\n---\n"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectFrontmatterOnly returns the full set as an array", async () => {
  const wiki = tmpWiki("collect");
  try {
    writeFileSync(join(wiki, "a.md"), leaf("a"));
    writeFileSync(join(wiki, "b.md"), leaf("b"));
    resetBodyMetrics();
    const entries = await collectFrontmatterOnly(wiki);
    assert.equal(entries.length, 2);
    assert.equal(getBodyMetrics().totalBodyLoads, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("includeIndexFiles: false excludes index.md", async () => {
  const wiki = tmpWiki("no-index");
  try {
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: root\ntype: index\ndepth_role: category\nfocus: root\ngenerator: skill-llm-wiki/v1\n---\n\n",
    );
    writeFileSync(join(wiki, "leaf.md"), leaf("leaf"));
    const withIndex = await collectFrontmatterOnly(wiki, {
      includeIndexFiles: true,
    });
    const withoutIndex = await collectFrontmatterOnly(wiki, {
      includeIndexFiles: false,
    });
    assert.equal(withIndex.length, 2);
    assert.equal(withoutIndex.length, 1);
    assert.equal(withoutIndex[0].data.id, "leaf");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("malformed frontmatter triggers onMalformed (defaults to throw)", async () => {
  const wiki = tmpWiki("malformed");
  try {
    writeFileSync(
      join(wiki, "bad.md"),
      "---\nid: :::bad-yaml:::\n",
    );
    // No closing fence ever — readFrontmatterStreaming throws first.
    // We catch with onMalformed override and count calls.
    const errors = [];
    const onMalformed = (err) => errors.push(err);
    let yielded = 0;
    for await (const _entry of iterEntries(wiki, { onMalformed })) {
      yielded++;
    }
    assert.equal(yielded, 0);
    assert.equal(errors.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("releaseBody without a matching loadBody throws loudly", () => {
  resetBodyMetrics();
  assert.throws(
    () => releaseBody(),
    /releaseBody called without a matching loadBody/,
  );
});

test("empty file is skipped silently (not misreported as huge frontmatter)", () => {
  const wiki = tmpWiki("empty");
  try {
    const p = join(wiki, "empty.md");
    writeFileSync(p, "");
    const captured = readFrontmatterStreaming(p);
    assert.equal(captured, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("3-byte file (---) is skipped silently", () => {
  const wiki = tmpWiki("three-byte");
  try {
    const p = join(wiki, "tiny.md");
    writeFileSync(p, "---");
    const captured = readFrontmatterStreaming(p);
    assert.equal(captured, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("file containing only `---\\n` has no closing fence and throws", () => {
  const wiki = tmpWiki("fence-only");
  try {
    const p = join(wiki, "fenceonly.md");
    writeFileSync(p, "---\n");
    // The opening fence is recognised but no closing fence follows
    // within the budget (the file IS the entire budget), so this
    // throws with the "no closing --- fence" diagnostic.
    assert.throws(
      () => readFrontmatterStreaming(p),
      /no closing --- fence/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("BOM-prefixed file is treated as non-frontmatter and skipped", () => {
  const wiki = tmpWiki("bom");
  try {
    const p = join(wiki, "bom.md");
    // U+FEFF BOM followed by a fence. The leading bytes are EF BB BF
    // which do not match `---\n`, so readFrontmatterStreaming should
    // return null rather than trying to parse.
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const rest = Buffer.from("---\nid: bom\n---\nbody\n", "utf8");
    writeFileSync(p, Buffer.concat([bom, rest]));
    const captured = readFrontmatterStreaming(p);
    assert.equal(captured, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("non-ASCII frontmatter round-trips: body offset is byte-authoritative", async () => {
  // This is the regression test for the UTF-8 chunk-boundary corruption
  // and the byte-vs-code-unit slicing bug. A frontmatter containing
  // 4-byte UTF-8 codepoints (like emoji, CJK characters, or math
  // symbols) must parse correctly AND loadBody must return the exact
  // body bytes — zero corruption, zero offset drift.
  const wiki = tmpWiki("utf8");
  try {
    const p = join(wiki, "utf8.md");
    const content =
      "---\n" +
      `id: utf8-entry\n` +
      `type: primary\n` +
      `depth_role: leaf\n` +
      `focus: "日本語のタイトル — mit Ümläuten und 🦀 emoji"\n` +
      "parents:\n" +
      "  - ../index.md\n" +
      "covers:\n" +
      `  - "concern with 中文 characters"\n` +
      `  - "concern with ✨ emoji"\n` +
      "---\n\n" +
      "THIS_IS_THE_BODY_MARKER ÄÖÜ 日本 🦀\n";
    writeFileSync(p, content, "utf8");

    // Streaming reader must parse the frontmatter without corruption.
    const captured = readFrontmatterStreaming(p);
    assert.ok(captured !== null);
    assert.ok(
      captured.frontmatterText.includes("日本語のタイトル"),
      "frontmatter CJK must survive",
    );
    assert.ok(
      captured.frontmatterText.includes("🦀 emoji"),
      "frontmatter emoji must survive",
    );

    // bodyOffset is bytes; loadBody must use it against a Buffer.
    resetBodyMetrics();
    let bodyText = null;
    for (const entry of iterEntries(wiki)) {
      bodyText = await entry.loadBody();
      releaseBody();
    }
    assert.ok(bodyText !== null);
    // The body returned by loadBody starts immediately after the
    // closing fence, which includes the blank-line separator
    // `\n` before the visible body content. trimStart for the
    // substring check.
    assert.ok(
      bodyText.trimStart().startsWith("THIS_IS_THE_BODY_MARKER"),
      `body must start at the correct byte offset; got: ${JSON.stringify(bodyText.slice(0, 40))}`,
    );
    assert.ok(
      bodyText.includes("ÄÖÜ"),
      "body must preserve non-ASCII bytes",
    );
    assert.ok(
      bodyText.includes("🦀"),
      "body must preserve emoji",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("frontmatter spanning a 4 KB chunk boundary with multi-byte codepoints", async () => {
  // Force a split across the 4096-byte read boundary by padding the
  // frontmatter with 4-byte emoji until the closing fence lands near
  // byte 4090–4100. A naive decode-per-chunk implementation emits
  // U+FFFD on the split codepoint; a Buffer-first implementation
  // does not.
  const wiki = tmpWiki("chunk-boundary-utf8");
  try {
    const p = join(wiki, "boundary.md");
    // Each 🦀 is 4 bytes in UTF-8. We want ~4090 bytes of pad before
    // the closing fence so the boundary slices a codepoint.
    const padBytes = 4090 - "---\npad: ".length;
    const emojiCount = Math.floor(padBytes / 4);
    const pad = "🦀".repeat(emojiCount);
    const content = "---\npad: " + pad + "\n---\nBODY\n";
    writeFileSync(p, content, "utf8");
    const captured = readFrontmatterStreaming(p);
    assert.ok(captured !== null);
    // The captured frontmatter must NOT contain U+FFFD replacement
    // characters — that would indicate per-chunk decoding corrupted
    // a multi-byte sequence at the boundary.
    assert.ok(
      !captured.frontmatterText.includes("\uFFFD"),
      "chunk-boundary decoding must not produce replacement characters",
    );
    // And the body must still be intact via the thunk.
    resetBodyMetrics();
    for (const entry of iterEntries(wiki)) {
      const body = await entry.loadBody();
      assert.ok(body.startsWith("BODY"));
      releaseBody();
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("CRLF frontmatter with CRLF fences is recognised", async () => {
  const wiki = tmpWiki("crlf");
  try {
    const p = join(wiki, "crlf.md");
    const content =
      "---\r\n" +
      "id: crlf-entry\r\n" +
      "type: primary\r\n" +
      "depth_role: leaf\r\n" +
      'focus: "crlf file"\r\n' +
      "parents:\r\n" +
      "  - ../index.md\r\n" +
      "---\r\n" +
      "\r\n" +
      "CRLF body\r\n";
    writeFileSync(p, content, "utf8");
    const captured = readFrontmatterStreaming(p);
    assert.ok(captured !== null);
    // CRLF files are normalised to LF before parsing so downstream
    // parsers (which are LF-only on this codebase) work uniformly.
    // The BYTE offset into the file is unaffected by normalisation.
    assert.equal(captured.lineEnding, "crlf");
    assert.ok(captured.frontmatterText.startsWith("---\n"));
    assert.ok(captured.frontmatterText.endsWith("\n---\n"));
    assert.ok(
      !captured.frontmatterText.includes("\r"),
      "normalised frontmatter must not contain CR",
    );
    resetBodyMetrics();
    for (const entry of iterEntries(wiki)) {
      assert.equal(entry.data.id, "crlf-entry");
      const body = await entry.loadBody();
      assert.ok(body.includes("CRLF body"));
      releaseBody();
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("collectEntryPaths onDirError surfaces directory I/O failures", () => {
  const wiki = tmpWiki("dir-error");
  try {
    writeFileSync(join(wiki, "a.md"), leaf("a"));
    // Point at a nonexistent sub-wiki root to force a readdir error.
    const bogus = join(wiki, "does-not-exist");
    const seen = [];
    const paths = collectEntryPaths(bogus, {
      onDirError: (err, dir) => seen.push({ dir, code: err.code }),
    });
    assert.deepEqual(paths, []);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].code, "ENOENT");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("nested subdirs are walked and yielded with stable ordering", async () => {
  const wiki = tmpWiki("nested");
  try {
    mkdirSync(join(wiki, "api", "v1"), { recursive: true });
    mkdirSync(join(wiki, "api", "v2"), { recursive: true });
    mkdirSync(join(wiki, "concepts"), { recursive: true });
    writeFileSync(join(wiki, "index.md"), leaf("root"));
    writeFileSync(join(wiki, "api", "v1", "hello.md"), leaf("hello-v1"));
    writeFileSync(join(wiki, "api", "v2", "hello.md"), leaf("hello-v2"));
    writeFileSync(join(wiki, "concepts", "overview.md"), leaf("overview"));
    const ids = [];
    for await (const e of iterEntries(wiki)) {
      ids.push(e.data.id);
    }
    // Sorted path order: api/v1/hello, api/v2/hello, concepts/overview, index
    assert.deepEqual(ids, ["hello-v1", "hello-v2", "overview", "root"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
