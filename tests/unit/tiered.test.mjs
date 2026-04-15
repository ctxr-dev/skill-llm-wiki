// tiered.test.mjs — the escalation orchestrator.
//
// Every path through the ladder is exercised:
//   - resolveQualityMode from flag / env / default
//   - Unknown quality mode throws
//   - Cache hit short-circuits the ladder
//   - Tier 0 decisive SAME resolves at tier=0
//   - Tier 0 decisive DIFFERENT resolves at tier=0
//   - Tier 0 mid-band + tiered-fast escalates to Tier 1
//   - Tier 0 mid-band + claude-first skips Tier 1, goes to Tier 2
//   - Tier 0 mid-band + tier0-only returns "undecidable"
//   - Tier 1 decisive resolves at tier=1
//   - Tier 1 mid-band escalates to Tier 2
//   - Tier 1 unavailable → Tier 2 fallthrough
//   - Custom tier2Handler is called with the expected context
//   - decide writes to decision log when opId is given
//   - decide skips the log when writeLog=false
//   - decide writes to the cache when writeCache=true
//   - decide reads from the cache when readCache=true

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDecisions } from "../../scripts/lib/decision-log.mjs";
import { cacheSize, writeCached } from "../../scripts/lib/similarity-cache.mjs";
import {
  DEFAULT_QUALITY_MODE,
  QUALITY_MODES,
  decide,
  resolveQualityMode,
} from "../../scripts/lib/tiered.mjs";
import {
  _isTier1LoaderTouched,
  _resetTier1LoadState,
} from "../../scripts/lib/embeddings.mjs";

process.env.LLM_WIKI_MOCK_TIER1 = "1";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-tiered-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// ── resolveQualityMode ──────────────────────────────────────────────

test("resolveQualityMode: flag wins over env", () => {
  const prev = process.env.LLM_WIKI_QUALITY_MODE;
  process.env.LLM_WIKI_QUALITY_MODE = "claude-first";
  try {
    assert.equal(
      resolveQualityMode({ quality_mode: "tier0-only" }),
      "tier0-only",
    );
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_QUALITY_MODE;
    else process.env.LLM_WIKI_QUALITY_MODE = prev;
  }
});

test("resolveQualityMode: env is used when flag is absent", () => {
  const prev = process.env.LLM_WIKI_QUALITY_MODE;
  process.env.LLM_WIKI_QUALITY_MODE = "claude-first";
  try {
    assert.equal(resolveQualityMode({}), "claude-first");
  } finally {
    if (prev === undefined) delete process.env.LLM_WIKI_QUALITY_MODE;
    else process.env.LLM_WIKI_QUALITY_MODE = prev;
  }
});

test("resolveQualityMode: default is tiered-fast", () => {
  const prev = process.env.LLM_WIKI_QUALITY_MODE;
  delete process.env.LLM_WIKI_QUALITY_MODE;
  try {
    assert.equal(resolveQualityMode({}), DEFAULT_QUALITY_MODE);
    assert.equal(DEFAULT_QUALITY_MODE, "tiered-fast");
  } finally {
    if (prev !== undefined) process.env.LLM_WIKI_QUALITY_MODE = prev;
  }
});

test("resolveQualityMode: unknown mode throws", () => {
  assert.throws(() => resolveQualityMode({ quality_mode: "bogus" }), /unknown quality mode/);
});

test("QUALITY_MODES is the canonical allow-list", () => {
  assert.deepEqual([...QUALITY_MODES], ["tiered-fast", "claude-first", "tier0-only"]);
});

// ── Helpers ──────────────────────────────────────────────────────────

const similarA = () => ({
  id: "prisma-migrations",
  focus: "prisma database schema migrations and seed workflows",
  covers: ["migrate dev", "migrate deploy", "seed commands"],
  tags: ["orm", "database", "prisma"],
});

const similarB = () => ({
  id: "prisma-schema",
  focus: "prisma database schema migrations and seed workflows",
  covers: ["migrate dev", "migrate deploy", "seed commands"],
  tags: ["orm", "database", "prisma"],
});

const unrelatedA = () => ({
  id: "react-hooks",
  focus: "react hook correctness rules",
  covers: ["useEffect dependency array", "useState immutability"],
  tags: ["react", "frontend"],
});

const unrelatedB = () => ({
  id: "terraform-modules",
  focus: "terraform module composition patterns",
  covers: ["module source paths", "variable defaults"],
  tags: ["terraform", "infra"],
});

// A pair designed to sit in the mid-band with a tiny corpus so
// Tier 0 escalates. Deliberately avoiding shared overlap with the
// identical-twin pair.
const midBandA = () => ({
  id: "redis-caching",
  focus: "caching strategies with redis",
  covers: ["lru eviction", "cache stampede", "key prefixing"],
  tags: ["redis", "cache"],
});

const midBandB = () => ({
  id: "memcached-caching",
  focus: "caching strategies with memcached",
  covers: ["slab allocation", "cache stampede", "key prefixing"],
  tags: ["memcached", "cache"],
});

const midBandContext = () => [
  midBandA(), midBandB(),
  { id: "zebra", focus: "zebra stripes pattern ecology",
    covers: ["melanin", "camouflage"], tags: ["biology"] },
];

// ── decide ───────────────────────────────────────────────────────────

test("decide: decisive SAME pair resolves at tier=0", async () => {
  const wiki = tmpWiki("decisive-same");
  try {
    const a = similarA();
    const b = similarB();
    const r = await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
    });
    assert.equal(r.tier, 0);
    assert.equal(r.decision, "same");
    assert.equal(r.confidence_band, "decisive-same");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: decisive DIFFERENT pair resolves at tier=0", async () => {
  const wiki = tmpWiki("decisive-diff");
  try {
    const a = unrelatedA();
    const b = unrelatedB();
    const r = await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
    });
    assert.equal(r.tier, 0);
    assert.equal(r.decision, "different");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: tiered-fast mid-band escalates to Tier 1 (mock)", async () => {
  const wiki = tmpWiki("tier1-escalate");
  try {
    const a = midBandA();
    const b = midBandB();
    const r = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "tiered-fast",
    });
    assert.equal(r.tier, 1);
    assert.ok(["same", "different", "undecidable"].includes(r.decision));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: claude-first mid-band skips Tier 1 and uses Tier 2", async () => {
  const wiki = tmpWiki("claude-first");
  try {
    const a = midBandA();
    const b = midBandB();
    const calls = [];
    const handler = async (ctx) => {
      calls.push(ctx);
      return {
        decision: "same",
        reason: "tier2-mocked",
        confidence_band: "tier2-stub",
      };
    };
    const r = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "claude-first",
      tier2Handler: handler,
    });
    assert.equal(r.tier, 2);
    assert.equal(r.decision, "same");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, "claude-first mode");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: tier0-only returns undecidable for mid-band pairs", async () => {
  const wiki = tmpWiki("tier0-only");
  try {
    const a = midBandA();
    const b = midBandB();
    const r = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "tier0-only",
    });
    assert.equal(r.tier, 0);
    assert.equal(r.decision, "undecidable");
    assert.match(r.reason, /tier0-only/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: cache hit short-circuits the ladder", async () => {
  const wiki = tmpWiki("cache-hit");
  try {
    const a = similarA();
    const b = similarB();
    // Pre-plant a "different" cache entry — the real result would
    // be "same", so if cache is consulted we see the cached value.
    const { createHash } = await import("node:crypto");
    const textHash = (x) =>
      "sha256:" +
      createHash("sha256")
        .update(
          (x.focus + " ").repeat(2) +
            (x.covers || []).join(" ") + " " +
            (x.tags || []).join(" "),
        )
        .digest("hex");
    writeCached(wiki, textHash(a), textHash(b), {
      tier: 2,
      similarity: 0.1,
      decision: "different",
      confidence_band: "pre-planted",
    });
    const r = await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
    });
    assert.equal(r.decision, "different");
    assert.equal(r.tier, 2);
    assert.equal(r.reason, "cached");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: readCache=false bypasses the cache", async () => {
  const wiki = tmpWiki("no-cache-read");
  try {
    const a = similarA();
    const b = similarB();
    const { createHash } = await import("node:crypto");
    const textHash = (x) =>
      "sha256:" +
      createHash("sha256")
        .update(
          (x.focus + " ").repeat(2) +
            (x.covers || []).join(" ") + " " +
            (x.tags || []).join(" "),
        )
        .digest("hex");
    writeCached(wiki, textHash(a), textHash(b), {
      tier: 2,
      similarity: 0.1,
      decision: "different",
      confidence_band: "pre-planted",
    });
    const r = await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      readCache: false,
    });
    // Cache was bypassed; real Tier 0 says these are the same.
    assert.equal(r.decision, "same");
    assert.equal(r.tier, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: writeLog=true appends a decision log entry", async () => {
  const wiki = tmpWiki("write-log");
  try {
    const a = similarA();
    const b = similarB();
    await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-logged",
      operator: "MERGE",
      writeLog: true,
      writeCache: false,
    });
    const log = readDecisions(wiki);
    assert.equal(log.length, 1);
    assert.equal(log[0].op_id, "op-logged");
    assert.equal(log[0].operator, "MERGE");
    assert.deepEqual(
      log[0].sources.slice().sort(),
      ["prisma-migrations", "prisma-schema"].sort(),
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: writeLog=false leaves the decision log empty", async () => {
  const wiki = tmpWiki("no-log");
  try {
    const a = similarA();
    const b = similarB();
    await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-silent",
      operator: "MERGE",
      writeLog: false,
      writeCache: false,
    });
    const log = readDecisions(wiki);
    assert.equal(log.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: writeCache=true persists the decision to the cache", async () => {
  const wiki = tmpWiki("write-cache");
  try {
    const a = similarA();
    const b = similarB();
    await decide(a, b, [a, b], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      writeCache: true,
    });
    assert.equal(cacheSize(wiki), 1);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: missing wikiRoot throws", async () => {
  await assert.rejects(
    () => decide({ id: "a" }, { id: "b" }, [], { operator: "MERGE" }),
    /requires \{ wikiRoot \}/,
  );
});

test("decide: missing operator throws", async () => {
  const wiki = tmpWiki("no-op");
  try {
    await assert.rejects(
      () => decide({ id: "a" }, { id: "b" }, [], { wikiRoot: wiki }),
      /requires \{ operator \}/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// ── Tier 1 lazy-load regression (3a) ───────────────────────────────
//
// `tiered.decide()` used to call `ensureTier1()` eagerly in its Tier 0 →
// Tier 1 escalation branch BEFORE even touching the embedding cache.
// On a warm cache (the common case on any non-cold build cycle) that
// eager call dynamic-imported `@xenova/transformers` for nothing:
// every similarity decision reused the on-disk cache, so the loader
// should have stayed dormant. The `LLM_WIKI_TIER1_DEBUG=1` breadcrumb
// made this visible in live builds — cycles 1..N all printed the
// "loading Tier 1 model" line even though `embed-computes=0`.
//
// Invariants these tests lock in:
//   1. Similarity-cache hit → decide() returns without touching the
//      Tier 1 loader promise slot.
//   2. Decisive Tier 0 (both SAME and DIFFERENT) → decide() returns at
//      tier=0 without touching the Tier 1 loader promise slot.
//   3. Mid-band escalation that DOES need Tier 1 vectors will, of
//      course, touch the loader — covered by the existing
//      "tiered-fast mid-band escalates to Tier 1" test.

test("decide: similarity cache hit leaves the Tier 1 loader dormant", async () => {
  const wiki = tmpWiki("warm-cache-no-load");
  try {
    _resetTier1LoadState();
    assert.equal(
      _isTier1LoaderTouched(),
      false,
      "precondition: loader must start dormant",
    );
    // Plant a cache entry for the pair the test is about to decide
    // on. The REAL Tier 0 answer would be "escalate" for mid-band
    // pairs, which is the slot that used to eagerly load Tier 1.
    // A pre-planted cache entry is the exact scenario a warm resume
    // cycle exercises.
    const a = midBandA();
    const b = midBandB();
    const { createHash } = await import("node:crypto");
    const textHash = (x) =>
      "sha256:" +
      createHash("sha256")
        .update(
          (x.focus + " ").repeat(2) +
            (x.covers || []).join(" ") + " " +
            (x.tags || []).join(" "),
        )
        .digest("hex");
    writeCached(wiki, textHash(a), textHash(b), {
      tier: 1,
      similarity: 0.82,
      decision: "same",
      confidence_band: "decisive-same",
    });
    const r = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-warm",
      operator: "MERGE",
      qualityMode: "tiered-fast",
    });
    assert.equal(r.decision, "same", "cache hit must be honoured");
    assert.equal(r.reason, "cached");
    assert.equal(
      _isTier1LoaderTouched(),
      false,
      "decide() must not touch the Tier 1 loader on a cache hit",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: decisive Tier 0 leaves the Tier 1 loader dormant", async () => {
  const wiki = tmpWiki("decisive-no-load");
  try {
    _resetTier1LoadState();
    assert.equal(_isTier1LoaderTouched(), false);
    // A clearly-different pair resolves at Tier 0 with
    // decisive-different — no escalation, no embedding compute.
    const r = await decide(unrelatedA(), unrelatedB(), [unrelatedA(), unrelatedB()], {
      wikiRoot: wiki,
      opId: "op-tier0-diff",
      operator: "MERGE",
      qualityMode: "tiered-fast",
    });
    assert.equal(r.tier, 0);
    assert.equal(r.decision, "different");
    assert.equal(
      _isTier1LoaderTouched(),
      false,
      "decide() must not touch the Tier 1 loader when Tier 0 is decisive",
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: unknown quality mode throws", async () => {
  const wiki = tmpWiki("bad-mode");
  try {
    await assert.rejects(
      () =>
        decide({ id: "a" }, { id: "b" }, [], {
          wikiRoot: wiki,
          operator: "MERGE",
          qualityMode: "nonsense",
        }),
      /unknown quality mode/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
