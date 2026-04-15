// provenance.test.mjs — round-trip + coverage-verification unit tests
// for the provenance manifest module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
// writeFileSync, mkdirSync used by the fixture-manifest tests below.
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readProvenance,
  recordDiscarded,
  recordSource,
  startCorpus,
  verifyCoverage,
  writeProvenance,
} from "../../scripts/lib/provenance.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-prov-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("startCorpus writes the corpus block and readProvenance round-trips", () => {
  const wiki = tmpWiki("startCorpus");
  try {
    startCorpus(wiki, {
      root: "/abs/src",
      root_hash: "sha256:abc",
      pre_commit: "deadbeef",
      ingested_at: "2026-04-14T00:00:00Z",
    });
    const doc = readProvenance(wiki);
    assert.equal(doc.version, 1);
    assert.equal(doc.corpus.root, "/abs/src");
    assert.equal(doc.corpus.root_hash, "sha256:abc");
    assert.equal(doc.corpus.pre_commit, "deadbeef");
    assert.equal(doc.corpus.ingested_at, "2026-04-14T00:00:00Z");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource appends and round-trips a source entry", () => {
  const wiki = tmpWiki("recordSource");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "cat/entry.md", {
      source_path: "entry.md",
      source_pre_hash: "sha256:beef",
      source_size: 100,
      byte_range: [0, 100],
      disposition: "preserved",
    });
    const doc = readProvenance(wiki);
    const sources = doc.targets["cat/entry.md"].sources;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source_path, "entry.md");
    assert.deepEqual(sources[0].byte_range, [0, 100]);
    assert.equal(sources[0].disposition, "preserved");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource is idempotent on an identical triple", () => {
  const wiki = tmpWiki("idempotent");
  try {
    startCorpus(wiki, { root: "/src" });
    const spec = {
      source_path: "a.md",
      source_pre_hash: "sha256:1",
      source_size: 50,
      byte_range: [0, 50],
    };
    recordSource(wiki, "a.md", spec);
    recordSource(wiki, "a.md", spec);
    const doc = readProvenance(wiki);
    assert.equal(doc.targets["a.md"].sources.length, 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordDiscarded + recordSource together cover the whole source", () => {
  const wiki = tmpWiki("discarded");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "x.md", {
      source_path: "x.md",
      source_pre_hash: null,
      source_size: 200,
      byte_range: [0, 180],
    });
    recordDiscarded(wiki, "x.md", [180, 200], "trailing whitespace");
    const result = verifyCoverage(wiki, (p) => (p === "x.md" ? 200 : null));
    assert.equal(result.ok, true);
    assert.deepEqual(result.uncovered, []);
    assert.deepEqual(result.overlaps, []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("verifyCoverage detects a gap in the middle of a source", () => {
  const wiki = tmpWiki("gap");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "a.md", {
      source_path: "hole.md",
      source_pre_hash: null,
      source_size: 100,
      byte_range: [0, 40],
    });
    recordSource(wiki, "b.md", {
      source_path: "hole.md",
      source_pre_hash: null,
      source_size: 100,
      byte_range: [60, 100],
    });
    const result = verifyCoverage(wiki, (p) => (p === "hole.md" ? 100 : null));
    assert.equal(result.ok, false);
    assert.ok(
      result.uncovered.some(
        (u) =>
          u.source_path === "hole.md" &&
          u.byte_range &&
          u.byte_range[0] === 40 &&
          u.byte_range[1] === 60,
      ),
      `expected gap 40..60 in uncovered: ${JSON.stringify(result.uncovered)}`,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("verifyCoverage detects an overlap between two targets", () => {
  const wiki = tmpWiki("overlap");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "a.md", {
      source_path: "shared.md",
      source_pre_hash: null,
      source_size: 100,
      byte_range: [0, 60],
    });
    recordSource(wiki, "b.md", {
      source_path: "shared.md",
      source_pre_hash: null,
      source_size: 100,
      byte_range: [50, 100],
    });
    const result = verifyCoverage(wiki, () => 100);
    assert.equal(result.ok, false);
    assert.ok(result.overlaps.length > 0, "overlap must be reported");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("verifyCoverage detects an uncovered tail", () => {
  const wiki = tmpWiki("tail");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "a.md", {
      source_path: "half.md",
      source_pre_hash: null,
      source_size: 100,
      byte_range: [0, 50],
    });
    const result = verifyCoverage(wiki, () => 100);
    assert.equal(result.ok, false);
    assert.ok(
      result.uncovered.some((u) => u.reason === "tail not covered"),
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("hazardous string values (paths with colons, discard reasons) round-trip", () => {
  const wiki = tmpWiki("hazard");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "cat:with:colons/entry.md", {
      source_path: "path: with spaces/colons.md",
      source_pre_hash: null,
      source_size: 42,
      byte_range: [0, 42],
    });
    recordDiscarded(
      wiki,
      "path: with spaces/colons.md",
      [0, 5],
      "reason with \"quotes\" and\nnewlines",
    );
    const doc = readProvenance(wiki);
    const entry = doc.targets["cat:with:colons/entry.md"];
    assert.ok(entry);
    assert.equal(entry.sources[0].source_path, "path: with spaces/colons.md");
    const discarded = doc.targets._discarded.discarded_ranges[0];
    assert.equal(discarded.reason, "reason with \"quotes\" and\nnewlines");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource rejects invalid byte_range", () => {
  const wiki = tmpWiki("bad-range");
  try {
    assert.throws(
      () =>
        recordSource(wiki, "a.md", {
          source_path: "x.md",
          source_size: 10,
          byte_range: [5, 3],
        }),
      /invalid byte_range/,
    );
    assert.throws(
      () =>
        recordSource(wiki, "a.md", {
          source_path: "x.md",
          source_size: 10,
          byte_range: [0],
        }),
      /byte_range must be \[startInclusive/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource rejects byte_range end beyond source_size", () => {
  const wiki = tmpWiki("past-size");
  try {
    startCorpus(wiki, { root: "/src" });
    assert.throws(
      () =>
        recordSource(wiki, "a.md", {
          source_path: "x.md",
          source_size: 10,
          byte_range: [0, 20],
        }),
      /exceeds source_size/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource rejects zero-length byte_range", () => {
  const wiki = tmpWiki("zero-len");
  try {
    startCorpus(wiki, { root: "/src" });
    assert.throws(
      () =>
        recordSource(wiki, "a.md", {
          source_path: "x.md",
          source_size: 10,
          byte_range: [5, 5],
        }),
      /invalid byte_range/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("verifyCoverage reports out_of_bounds when an older manifest has a runaway range", async () => {
  // Simulate a tampered manifest that was written before the
  // range-past-size validation existed. We bypass recordSource and
  // writeProvenance directly with a doc that contains the bug.
  const wiki = tmpWiki("oob");
  try {
    const doc = {
      version: 1,
      corpus: { root: "/src", root_hash: null, pre_commit: null, ingested_at: "2026-04-14T00:00:00Z" },
      targets: {
        "a.md": {
          sources: [
            {
              source_path: "x.md",
              source_pre_hash: null,
              source_size: 50,
              byte_range: [0, 100],
              disposition: "preserved",
            },
          ],
          discarded_ranges: [],
        },
      },
    };
    writeProvenance(wiki, doc);
    const result = verifyCoverage(wiki, () => 50);
    assert.equal(result.ok, false);
    assert.ok(result.out_of_bounds.length > 0);
    assert.equal(result.out_of_bounds[0].source_path, "x.md");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("startCorpus resets prior targets (no cross-op bleed)", () => {
  const wiki = tmpWiki("reset");
  try {
    startCorpus(wiki, { root: "/src" });
    recordSource(wiki, "a.md", {
      source_path: "x.md",
      source_size: 10,
      byte_range: [0, 10],
    });
    // Start a new operation: all prior targets must be gone.
    startCorpus(wiki, { root: "/src", pre_commit: "new-commit" });
    const doc = readProvenance(wiki);
    assert.deepEqual(doc.targets, {});
    assert.equal(doc.corpus.pre_commit, "new-commit");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser strips comments uniformly and preserves the real document", () => {
  const wiki = tmpWiki("uniform-comments");
  try {
    const llmwiki = join(wiki, ".llmwiki");
    mkdirSync(llmwiki, { recursive: true });
    const raw =
      "# header\n" +
      "version: 1\n" +
      "# between fields\n" +
      "corpus: null\n" +
      "# another comment\n" +
      "targets:\n" +
      "  {}\n";
    writeFileSync(join(llmwiki, "provenance.yaml"), raw);
    const doc = readProvenance(wiki);
    assert.equal(doc.version, 1);
    assert.equal(doc.corpus, null);
    assert.deepEqual(doc.targets, {});
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser fails loud on unknown target-child field", () => {
  const wiki = tmpWiki("unknown-field");
  try {
    const llmwiki = join(wiki, ".llmwiki");
    mkdirSync(llmwiki, { recursive: true });
    const raw =
      "version: 1\n" +
      "corpus: null\n" +
      "targets:\n" +
      "  a.md:\n" +
      "    sources:\n" +
      "      []\n" +
      "    bogus_field: 42\n" +
      "    discarded_ranges:\n" +
      "      []\n";
    writeFileSync(join(llmwiki, "provenance.yaml"), raw);
    assert.throws(
      () => readProvenance(wiki),
      /unknown target field/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser rejects unsafe integer in byte_range", () => {
  const wiki = tmpWiki("unsafe-int");
  try {
    const llmwiki = join(wiki, ".llmwiki");
    mkdirSync(llmwiki, { recursive: true });
    const raw =
      "version: 1\n" +
      "corpus: null\n" +
      "targets:\n" +
      "  a.md:\n" +
      "    sources:\n" +
      "      - source_path: x.md\n" +
      "        source_pre_hash: null\n" +
      "        source_size: null\n" +
      "        byte_range: [0, 999999999999999999999]\n" +
      "        disposition: preserved\n" +
      "    discarded_ranges:\n" +
      "      []\n";
    writeFileSync(join(llmwiki, "provenance.yaml"), raw);
    assert.throws(
      () => readProvenance(wiki),
      /not a safe JavaScript integer/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser rejects unbalanced quote in a value", () => {
  const wiki = tmpWiki("unclosed-quote");
  try {
    const llmwiki = join(wiki, ".llmwiki");
    mkdirSync(llmwiki, { recursive: true });
    const raw =
      "version: 1\n" +
      'corpus:\n  root: "unclosed\n' +
      "targets:\n  {}\n";
    writeFileSync(join(llmwiki, "provenance.yaml"), raw);
    assert.throws(
      () => readProvenance(wiki),
      /unbalanced quote/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("recordSource rejects unknown disposition", () => {
  const wiki = tmpWiki("bad-disp");
  try {
    assert.throws(
      () =>
        recordSource(wiki, "a.md", {
          source_path: "x.md",
          source_size: 10,
          byte_range: [0, 10],
          disposition: "mutated",
        }),
      /unknown disposition/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
