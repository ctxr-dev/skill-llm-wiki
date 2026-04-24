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
  TIER1_DETERMINISTIC_THRESHOLD,
  decide,
  resolveQualityMode,
} from "../../scripts/lib/tiered.mjs";
import {
  TIER1_DECISIVE_DIFFERENT,
  TIER1_DECISIVE_SAME,
  _isTier1LoaderTouched,
  _resetTier1LoadState,
  embed,
  embeddingCosine,
} from "../../scripts/lib/embeddings.mjs";
import {
  TIER0_DECISIVE_DIFFERENT,
  TIER0_DECISIVE_SAME,
  compareEntries,
  entryText,
} from "../../scripts/lib/similarity.mjs";

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
      resolveQualityMode({ quality_mode: "deterministic" }),
      "deterministic",
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
  assert.deepEqual(
    [...QUALITY_MODES],
    ["tiered-fast", "claude-first", "deterministic"],
  );
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

test("decide: deterministic mode resolves Tier 0 mid-band without Tier 2", async () => {
  // Deterministic mode must never return "undecidable" / "pending-tier2"
  // and must never call tier2Handler. The mid-band pair used here lands
  // at Tier 1 — it may be decisive at Tier 1 (no mid-band resolution
  // needed) or mid-band (deterministic threshold fires). Either way
  // the decision is concrete and Tier 2 is never consulted.
  const wiki = tmpWiki("deterministic");
  try {
    const a = midBandA();
    const b = midBandB();
    let tier2Called = false;
    const r = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "deterministic",
      tier2Handler: async () => {
        tier2Called = true;
        return { decision: "same", reason: "should-never-fire" };
      },
    });
    assert.equal(tier2Called, false, "deterministic mode must not call Tier 2");
    assert.ok(r.tier >= 0 && r.tier <= 1, `unexpected tier ${r.tier}`);
    assert.ok(
      ["same", "different"].includes(r.decision),
      `expected same/different, got ${r.decision}`,
    );
    assert.notEqual(r.decision, "pending-tier2");
    assert.notEqual(r.decision, "undecidable");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("TIER1_DETERMINISTIC_THRESHOLD is derived from the Tier 1 decisive bounds", () => {
  // Constant-level pin: if anyone tunes TIER1_DECISIVE_SAME or
  // TIER1_DECISIVE_DIFFERENT without touching the derivation, this
  // test fires instead of silently drifting mid-band classification.
  assert.equal(
    TIER1_DETERMINISTIC_THRESHOLD,
    (TIER1_DECISIVE_SAME + TIER1_DECISIVE_DIFFERENT) / 2,
  );
});

test("decide: deterministic-mid-band band fires when Tier 1 cosine lands in-band", async () => {
  // Deterministic branch-firing test. The mock Tier 1 embedder hashes
  // token bags into the unit sphere, so pairs with varying token
  // overlap produce cosines that sweep monotonically (in expectation)
  // from ~1.0 down toward ~0. We generate pairs with progressively
  // decreasing token overlap and scan the resulting cosines for one
  // landing in (TIER1_DECISIVE_DIFFERENT, TIER1_DECISIVE_SAME). The
  // sweep is dense enough that at least one k is guaranteed to hit
  // the mid-band — if the mock implementation ever changes so that
  // this guarantee breaks, the test fails LOUDLY via `assert.fail`
  // instead of silently skipping, so a regression in the mock or in
  // threshold tuning surfaces immediately.
  const wiki = tmpWiki("deterministic-midband-branch");
  try {
    const sharedTokens = [
      "alpha", "beta", "gamma", "delta", "epsilon",
      "zeta", "eta", "theta", "iota", "kappa",
      "lambda", "mu", "nu", "xi", "omicron", "pi",
      "rho2", "sigma2", "tau2", "ups2",
    ];
    const variantTokens = [
      "omega", "sigma", "tau", "rho", "phi",
      "chi", "psi", "upsilon", "alef", "bet",
      "gimel", "dalet", "he", "vav", "zayin", "het",
      "tet", "yod", "kaf", "lamed",
    ];
    const total = sharedTokens.length; // == variantTokens.length

    // Padding corpus documents — adding a third+ doc to the IDF corpus
    // keeps TIER 0's IDF weights stable as k varies. Without these,
    // the 2-doc IDF collapses and a and b either score
    // decisive-different (few overlap) or decisive-same (many
    // overlap), skipping the escalation to Tier 1. The padding
    // "unrelated" document contributes diversity to the IDF denominator
    // so intermediate overlaps land in the TIER 0 mid-band.
    const padCorpus = [
      {
        id: "pad-corpus-1",
        focus: "unrelated padding doc for idf stability one",
        covers: ["unrelated cover one"],
        tags: ["padding"],
      },
      {
        id: "pad-corpus-2",
        focus: "different padding doc for idf stability two",
        covers: ["different cover two"],
        tags: ["padding"],
      },
    ];

    // Joint search: find a k where BOTH Tier 0 TF-IDF AND Tier 1 mock
    // cosine land in their respective mid-bands. Need both because
    // `decide()` short-circuits at Tier 0 if Tier 0 is decisive — the
    // deterministic-mid-band branch only fires when Tier 0 says
    // "escalate" AND Tier 1 lands in (0.45, 0.80).
    let inBandPair = null;
    for (let k = 1; k < total; k++) {
      const aTokens = sharedTokens.slice();
      const bTokens = [
        ...sharedTokens.slice(0, k),
        ...variantTokens.slice(k, total),
      ];
      const textA = aTokens.join(" ");
      const textB = bTokens.join(" ");
      const aEntry = { id: `a-overlap${k}`, focus: textA, covers: [], tags: [] };
      const bEntry = { id: `b-overlap${k}`, focus: textB, covers: [], tags: [] };
      const ctx = [aEntry, bEntry, ...padCorpus];

      const tier0 = compareEntries(aEntry, bEntry, ctx);
      if (
        tier0.similarity <= TIER0_DECISIVE_DIFFERENT ||
        tier0.similarity >= TIER0_DECISIVE_SAME
      ) {
        continue;
      }

      // Mirror decide()'s Tier 1 input exactly: `embed(wiki,
      // entryText(entry))` — entryText doubles focus + appends
      // covers/tags/domains. Using raw `textA` here would compute a
      // different cosine than decide() sees, so the branch-firing
      // assertion would be racing against a phantom pair.
      const [vecA, vecB] = await Promise.all([
        embed(wiki, entryText(aEntry)),
        embed(wiki, entryText(bEntry)),
      ]);
      const tier1Sim = embeddingCosine(vecA, vecB);
      if (tier1Sim > TIER1_DECISIVE_DIFFERENT && tier1Sim < TIER1_DECISIVE_SAME) {
        inBandPair = { a: aEntry, b: bEntry, ctx, sim: tier1Sim };
        break;
      }
    }

    if (!inBandPair) {
      // The mock embedder's cosine surface changed, or the Tier 1
      // threshold window shifted. This test relied on at least one
      // progressive-overlap pair landing in-band. Fail loudly so the
      // mock drift / threshold change is noticed, rather than letting
      // the threshold branch silently slip out of coverage.
      assert.fail(
        "progressive-overlap sweep produced no mock Tier 1 cosine in " +
          `(${TIER1_DECISIVE_DIFFERENT}, ${TIER1_DECISIVE_SAME}); ` +
          "mock embedder or Tier 1 thresholds drifted — update this test.",
      );
    }

    const { a, b, ctx, sim } = inBandPair;
    const r = await decide(a, b, ctx, {
      wikiRoot: wiki,
      opId: "op-midband",
      operator: "MERGE",
      qualityMode: "deterministic",
    });
    assert.equal(r.tier, 1, `expected tier=1 for in-band pair (sim=${sim.toFixed(3)})`);
    assert.equal(r.confidence_band, "deterministic-mid-band");
    const expected = sim > TIER1_DETERMINISTIC_THRESHOLD ? "same" : "different";
    assert.equal(r.decision, expected);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: deterministic mode never escalates to Tier 2 even when Tier 1 is mid-band-adjacent", async () => {
  // Soft assertion: whatever band the mock cosine happens to land in,
  // deterministic mode must produce a concrete decision without ever
  // calling tier2Handler. This is the mode's core contract.
  const wiki = tmpWiki("deterministic-no-escalate");
  try {
    let tier2Called = false;
    const r = await decide(midBandA(), midBandB(), midBandContext(), {
      wikiRoot: wiki,
      opId: "op-no-escalate",
      operator: "MERGE",
      qualityMode: "deterministic",
      tier2Handler: async () => {
        tier2Called = true;
        return { decision: "same", reason: "should-never-fire" };
      },
    });
    assert.equal(tier2Called, false);
    assert.ok(["same", "different"].includes(r.decision));
    assert.notEqual(r.decision, "pending-tier2");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: deterministic mode is byte-stable across runs", async () => {
  // Two back-to-back calls on the same pair must return identical
  // decisions. We clear the similarity cache between calls to prove
  // the determinism comes from the decide() path itself rather than
  // the cache short-circuit.
  const wiki = tmpWiki("deterministic-stable");
  try {
    const a = midBandA();
    const b = midBandB();
    const r1 = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "deterministic",
    });
    rmSync(join(wiki, ".llmwiki"), { recursive: true, force: true });
    const r2 = await decide(a, b, midBandContext(), {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "deterministic",
    });
    assert.equal(r1.decision, r2.decision);
    assert.equal(r1.similarity, r2.similarity);
    assert.equal(r1.confidence_band, r2.confidence_band);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("decide: deterministic mode preserves Tier 0 decisive paths", async () => {
  // Decisive Tier 0 pairs short-circuit the ladder regardless of
  // quality mode. Verify that the decisive-same / decisive-different
  // bands still fire cleanly under deterministic mode, so users
  // switching modes don't see a regression on obvious pairs.
  const wiki = tmpWiki("deterministic-decisive");
  try {
    const similar = await decide(similarA(), similarB(), [similarA(), similarB()], {
      wikiRoot: wiki,
      opId: "op-1",
      operator: "MERGE",
      qualityMode: "deterministic",
    });
    assert.equal(similar.tier, 0);
    assert.equal(similar.decision, "same");
    assert.equal(similar.confidence_band, "decisive-same");

    const diff = await decide(unrelatedA(), unrelatedB(), [unrelatedA(), unrelatedB()], {
      wikiRoot: wiki,
      opId: "op-2",
      operator: "MERGE",
      qualityMode: "deterministic",
    });
    assert.equal(diff.tier, 0);
    assert.equal(diff.decision, "different");
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
