// scale.test.mjs — prove the chunk iterator keeps working-set memory
// bounded even when the corpus body total exceeds the heap cap we
// would tolerate for a "load everything" approach.
//
// Two load-bearing assertions:
//
//   1. `iterEntries` over a 200-entry, ~3 MB corpus yields every
//      entry's frontmatter without ever implicitly reading any body.
//      Proven via chunk.mjs's `getBodyMetrics().totalBodyLoads === 0`
//      after the iteration.
//
//   2. A streaming consumer that loads-and-releases each body in
//      turn keeps `peakInFlightBodies === 1` across the whole walk.
//      This is the discipline the orchestrator's operator-convergence
//      and classify phases will rely on at Phase 6.
//
// A third, softer check: the V8 heap growth between iteration start
// and end stays under a threshold that "load everything" would blow.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getBodyMetrics,
  iterEntries,
  releaseBody,
  resetBodyMetrics,
} from "../../scripts/lib/chunk.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-scale-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Build N leaf files whose bodies sum to roughly `targetBytes`. Body
// size is the same for every leaf so peak-1 discipline is easy to
// verify and the total byte count is predictable.
function seedCorpus(wiki, { entries = 200, bytesPerBody = 16 * 1024 } = {}) {
  mkdirSync(join(wiki, "corpus"), { recursive: true });
  for (let i = 0; i < entries; i++) {
    const id = `e${String(i).padStart(4, "0")}`;
    const body = "x".repeat(bytesPerBody);
    const content =
      "---\n" +
      `id: ${id}\n` +
      "type: primary\n" +
      "depth_role: leaf\n" +
      `focus: "entry number ${i}"\n` +
      "parents:\n" +
      "  - ../index.md\n" +
      "covers:\n" +
      "  - concern-a\n" +
      "  - concern-b\n" +
      "---\n\n" +
      body +
      "\n";
    writeFileSync(join(wiki, "corpus", `${id}.md`), content);
  }
  return entries * bytesPerBody;
}

test("scale: 200-entry / ~3 MB corpus iterates frontmatter-only with zero body loads", async () => {
  const wiki = tmpWiki("fm-only");
  try {
    const totalBody = seedCorpus(wiki, { entries: 200, bytesPerBody: 16 * 1024 });
    assert.ok(totalBody >= 3 * 1024 * 1024, "corpus must be ≥ 3 MB");

    resetBodyMetrics();
    let count = 0;
    for await (const entry of iterEntries(wiki)) {
      // Never call entry.loadBody() — the detection phase of an
      // operator would look at covers/tags/focus only.
      assert.ok(entry.data.id.startsWith("e"));
      count++;
    }
    assert.equal(count, 200);
    const m = getBodyMetrics();
    assert.equal(m.totalBodyLoads, 0, "no bodies must be loaded during frontmatter-only walk");
    assert.equal(m.peakInFlightBodies, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("scale: streaming consumer keeps peakInFlightBodies at 1 across 200 entries", async () => {
  const wiki = tmpWiki("streaming-200");
  try {
    seedCorpus(wiki, { entries: 200, bytesPerBody: 16 * 1024 });
    resetBodyMetrics();
    let totalBytesSeen = 0;
    for await (const entry of iterEntries(wiki)) {
      const body = await entry.loadBody();
      // Touch the body so V8 cannot eliminate the load.
      totalBytesSeen += body.length;
      releaseBody(); // discipline: drop before advancing
    }
    assert.ok(totalBytesSeen >= 3 * 1024 * 1024);
    const m = getBodyMetrics();
    assert.equal(
      m.peakInFlightBodies,
      1,
      `streaming consumer must peak at 1 in-flight body, got ${m.peakInFlightBodies}`,
    );
    assert.equal(m.totalBodyLoads, 200);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// Heap-growth assertion requires a deterministic GC trigger. Without
// `--expose-gc` the baseline is too noisy to catch regressions — we
// skip rather than ship an assertion that would pass even with a
// broken streaming path.
const HAS_GC = typeof globalThis.gc === "function";

test(
  "scale: heap growth during frontmatter-only walk is bounded (requires --expose-gc)",
  { skip: !HAS_GC && "this test needs node --expose-gc to measure meaningfully" },
  async () => {
    const wiki = tmpWiki("heap");
    try {
      seedCorpus(wiki, { entries: 200, bytesPerBody: 16 * 1024 });
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      resetBodyMetrics();
      for (const entry of iterEntries(wiki)) {
        void entry.data.id;
      }
      globalThis.gc();
      const after = process.memoryUsage().heapUsed;
      const growth = after - before;
      // Corpus body total is 3.2 MB. A frontmatter-only walk with
      // ~500 bytes of frontmatter per entry + parsed objects should
      // fit well under 1 MB. 2 MB is a tight-but-stable bound under
      // --expose-gc. Loose enough to tolerate V8 noise, tight enough
      // that a regression that retains 200 × 16 KB bodies (= 3.2 MB)
      // would trip it.
      assert.ok(
        growth < 2 * 1024 * 1024,
        `heap grew by ${growth} bytes during frontmatter-only walk (bound: 2 MB)`,
      );
    } finally {
      rmSync(wiki, { recursive: true, force: true });
    }
  },
);

test("scale: rebuildAllIndices routes every leaf through readFrontmatterStreaming", async () => {
  // The honest proof for the Phase 5 listChildren rewire: chunk.mjs
  // increments `totalFrontmatterReads` on every call. Before the
  // rewire, `listChildren` used `readFileSync` + full `parseFrontmatter`
  // and NEVER called `readFrontmatterStreaming` — so this counter
  // would stay at zero on a rebuild. After the rewire, the counter
  // increments once per leaf processed. We assert both that the
  // counter moved AND that it moved by exactly the leaf count.
  const wiki = tmpWiki("listChildren-scale");
  try {
    seedCorpus(wiki, { entries: 200, bytesPerBody: 16 * 1024 });
    writeFileSync(
      join(wiki, "index.md"),
      "---\nid: scale-listChildren\ntype: index\ndepth_role: category\nfocus: root\ngenerator: skill-llm-wiki/v1\n---\n\n",
    );
    writeFileSync(
      join(wiki, "corpus", "index.md"),
      "---\nid: corpus\ntype: index\ndepth_role: subcategory\nfocus: corpus\ngenerator: skill-llm-wiki/v1\n---\n\n",
    );

    const { rebuildAllIndices } = await import(
      "../../scripts/lib/indices.mjs"
    );
    resetBodyMetrics();
    const rebuilt = rebuildAllIndices(wiki);
    assert.ok(rebuilt.length >= 2);

    const m = getBodyMetrics();
    // Zero body loads via the chunk API (belt).
    assert.equal(
      m.totalBodyLoads,
      0,
      `rebuildAllIndices must not load any bodies via the chunk API, got ${m.totalBodyLoads}`,
    );
    // EXACTLY 200 frontmatter streams: the listChildren result is
    // cached in rebuildAllIndices so each leaf's frontmatter is read
    // once, not twice. The strict equality assertion doubles as a
    // regression guard:
    //   - A revert of Phase 5's listChildren rewire would drop the
    //     counter to 0 (readFileSync + parseFrontmatter instead).
    //   - A regression that removed the listChildren cache would
    //     push the counter to 400 (every leaf read twice).
    // Either regression flips the test red immediately.
    assert.equal(
      m.totalFrontmatterReads,
      200,
      `rebuildAllIndices must read each leaf's frontmatter exactly once (got ${m.totalFrontmatterReads}, expected 200)`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
