// tiered.mjs — the escalation orchestrator for the tiered AI ladder.
//
// Phase 6 of skill-llm-wiki (methodology §8.5). Every similarity
// decision (classify, MERGE/DECOMPOSE/NEST detection in operator-
// convergence, Rebuild plan-review, Join id-collision) flows through
// this module. It runs Tier 0 (TF-IDF), escalates to Tier 1 (local
// embeddings) on mid-band results, and escalates to Tier 2 (Claude)
// only for the residual ambiguous cases. A similarity-cache hit
// short-circuits the whole ladder.
//
// Three quality modes, selected via --quality-mode or the
// LLM_WIKI_QUALITY_MODE env var:
//
//   tiered-fast (default):
//     Tier 0 → Tier 1 → Tier 2, the full ladder. Mid-band Tier 0
//     escalates to Tier 1; mid-band Tier 1 escalates to Tier 2.
//
//   claude-first:
//     Tier 0 is still consulted for decisive cases (saves tokens on
//     obvious decisions) but anything in the Tier 0 mid-band goes
//     straight to Tier 2, skipping Tier 1. Useful when the user
//     values Claude's judgment over speed/cost.
//
//   tier0-only:
//     Tier 0 decisions only. Mid-band becomes an explicit
//     "undecidable" marker that the caller must resolve manually.
//
// Tier 2 (Claude) is STUBBED in Phase 6. Callers that hit Tier 2
// receive a `{tier: 2, decision: "undecidable", reason: "requires
// Claude review"}` shape. Phase 7 will wire in real Claude calls
// via the AI-call cache mechanism from methodology §9.4.

import { createHash } from "node:crypto";
import { appendDecision } from "./decision-log.mjs";
import {
  ensureTier1,
  embed,
  embeddingCosine,
  TIER1_DECISIVE_DIFFERENT,
  TIER1_DECISIVE_SAME,
} from "./embeddings.mjs";
import { readCached, writeCached } from "./similarity-cache.mjs";
import {
  compareEntries,
  entryText,
  TIER0_DECISIVE_DIFFERENT,
  TIER0_DECISIVE_SAME,
} from "./similarity.mjs";

export const QUALITY_MODES = Object.freeze([
  "tiered-fast",
  "claude-first",
  "tier0-only",
]);

export const DEFAULT_QUALITY_MODE = "tiered-fast";

export function resolveQualityMode(flags = {}) {
  const fromFlag = flags.quality_mode;
  const fromEnv = process.env.LLM_WIKI_QUALITY_MODE;
  const raw = fromFlag || fromEnv || DEFAULT_QUALITY_MODE;
  if (!QUALITY_MODES.includes(raw)) {
    throw new Error(
      `tiered: unknown quality mode "${raw}" (valid: ${QUALITY_MODES.join(", ")})`,
    );
  }
  return raw;
}

// Content-address a pair of entries by hashing their text. Used as
// the cache key so neither the ids nor paths influence symmetry.
// Internal — if a future caller needs to pre-compute cache keys,
// add the `export` keyword and import it from here rather than
// reimplementing the hash.
function entryHash(data) {
  const text = entryText(data);
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

// The main decision entry point. Takes two entries, the shared
// context (for Tier 0 IDF), and options carrying the wiki root,
// op-id, operator name, and quality mode. Returns
//
//   { tier, similarity, decision, confidence_band, reason }
//
// where `tier` is 0, 1, or 2 reflecting the ladder step that
// produced the final decision (cache hits report the tier of the
// cached decision), and `decision` is "same" | "different" |
// "undecidable" (the mode-aware equivalent of "escalate").
export async function decide(
  a,
  b,
  contextEntries,
  options = {},
) {
  const {
    wikiRoot,
    opId,
    operator,
    qualityMode = DEFAULT_QUALITY_MODE,
    writeLog = true,
    readCache = true,
    writeCache = true,
    interactive = false,
    tier2Handler = defaultTier2Handler,
  } = options;
  if (!wikiRoot) {
    throw new Error("tiered.decide requires { wikiRoot }");
  }
  if (!operator) {
    throw new Error("tiered.decide requires { operator }");
  }
  if (!QUALITY_MODES.includes(qualityMode)) {
    throw new Error(`tiered: unknown quality mode "${qualityMode}"`);
  }

  const hashA = entryHash(a);
  const hashB = entryHash(b);

  // Cache short-circuit.
  if (readCache) {
    const cached = readCached(wikiRoot, hashA, hashB);
    if (cached) {
      return {
        tier: cached.tier,
        similarity: cached.similarity,
        decision: cached.decision,
        confidence_band: cached.confidence_band ?? "cached",
        reason: "cached",
      };
    }
  }

  // Tier 0 — always consulted. Cheap and deterministic. Accept a
  // precomputed comparison model (O(N²) path) when the caller
  // hoisted IDF out of the per-pair loop.
  const t0 = compareEntries(a, b, contextEntries, {
    precomputedModel: options.precomputedModel ?? null,
  });
  // "undecidable" (insufficient-text) is a hard stop — not an
  // escalation. Empty-text pairs cannot be meaningfully compared
  // at Tier 1 (embeddings collapse to the model's zero-input
  // vector, producing spurious near-1.0 similarities) and Tier 2
  // has nothing to work with either.
  if (t0.decision === "undecidable") {
    const result = {
      tier: 0,
      similarity: t0.similarity,
      decision: "undecidable",
      confidence_band: t0.confidence_band,
      reason: t0.reason,
    };
    finaliseDecision(result, {
      a, b, hashA, hashB,
      wikiRoot, opId, operator, writeLog, writeCache,
    });
    return result;
  }
  if (t0.decision !== "escalate") {
    const result = {
      tier: 0,
      similarity: t0.similarity,
      decision: t0.decision,
      confidence_band: t0.confidence_band,
      reason: null,
    };
    finaliseDecision(result, {
      a, b, hashA, hashB,
      wikiRoot, opId, operator, writeLog, writeCache,
    });
    return result;
  }

  // Mid-band Tier 0 → escalate. Behaviour depends on quality mode.
  if (qualityMode === "tier0-only") {
    const result = {
      tier: 0,
      similarity: t0.similarity,
      decision: "undecidable",
      confidence_band: t0.confidence_band,
      reason: "tier0-only quality mode — mid-band left unresolved",
    };
    finaliseDecision(result, {
      a, b, hashA, hashB,
      wikiRoot, opId, operator, writeLog, writeCache,
    });
    return result;
  }

  if (qualityMode === "claude-first") {
    // Skip Tier 1 entirely, go straight to Tier 2.
    const t2 = await tier2Handler({ a, b, t0, reason: "claude-first mode" });
    const result = {
      tier: 2,
      similarity: t2.similarity ?? t0.similarity,
      decision: t2.decision,
      confidence_band: t2.confidence_band ?? "claude-resolved",
      reason: t2.reason,
    };
    finaliseDecision(result, {
      a, b, hashA, hashB,
      wikiRoot, opId, operator, writeLog, writeCache,
    });
    return result;
  }

  // tiered-fast — try Tier 1 first.
  const t1Available = await ensureTier1(wikiRoot, { interactive });
  if (t1Available.available) {
    const textA = entryText(a);
    const textB = entryText(b);
    const [vecA, vecB] = await Promise.all([
      embed(wikiRoot, textA),
      embed(wikiRoot, textB),
    ]);
    const sim = embeddingCosine(vecA, vecB);
    if (sim >= TIER1_DECISIVE_SAME) {
      const result = {
        tier: 1,
        similarity: sim,
        decision: "same",
        confidence_band: "decisive-same",
        reason: null,
      };
      finaliseDecision(result, {
        a, b, hashA, hashB,
        wikiRoot, opId, operator, writeLog, writeCache,
      });
      return result;
    }
    if (sim <= TIER1_DECISIVE_DIFFERENT) {
      const result = {
        tier: 1,
        similarity: sim,
        decision: "different",
        confidence_band: "decisive-different",
        reason: null,
      };
      finaliseDecision(result, {
        a, b, hashA, hashB,
        wikiRoot, opId, operator, writeLog, writeCache,
      });
      return result;
    }
    // Mid-band Tier 1 → Tier 2.
    const t2 = await tier2Handler({
      a, b, t0, t1: { similarity: sim },
      reason: "tier1 mid-band",
    });
    const result = {
      tier: 2,
      similarity: t2.similarity ?? sim,
      decision: t2.decision,
      confidence_band: t2.confidence_band ?? "claude-resolved",
      reason: t2.reason,
    };
    finaliseDecision(result, {
      a, b, hashA, hashB,
      wikiRoot, opId, operator, writeLog, writeCache,
    });
    return result;
  }

  // Tier 1 unavailable → fall through to Tier 2.
  const t2 = await tier2Handler({
    a, b, t0, reason: `tier1 unavailable (${t1Available.reason})`,
  });
  const result = {
    tier: 2,
    similarity: t2.similarity ?? t0.similarity,
    decision: t2.decision,
    confidence_band: t2.confidence_band ?? "claude-resolved",
    reason: t2.reason,
  };
  finaliseDecision(result, {
    a, b, hashA, hashB,
    wikiRoot, opId, operator, writeLog, writeCache,
  });
  return result;
}

// Phase 6's Tier 2 is a stub: it records the pair as "undecidable"
// so the caller can surface it to the human or defer. Phase 7 will
// replace this with a real Claude call backed by the AI-call cache.
export async function defaultTier2Handler({ a, b, t0, t1, reason }) {
  void a; void b; void t1;
  return {
    decision: "undecidable",
    similarity: t0.similarity,
    confidence_band: "tier2-stub",
    reason: `Phase 6 stub — ${reason}; Phase 7 will wire in real Claude review`,
  };
}

// Side-effects: write the decision log + the pairwise cache.
// Kept on a seam so `decide` stays pure-data-flow and testable.
function finaliseDecision(result, ctx) {
  const {
    a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache: wc,
  } = ctx;
  if (wc) {
    writeCached(wikiRoot, hashA, hashB, result);
  }
  if (writeLog && opId) {
    appendDecision(wikiRoot, {
      op_id: opId,
      operator,
      sources: [a?.id ?? "anonymous-a", b?.id ?? "anonymous-b"],
      tier_used: result.tier,
      similarity: result.similarity,
      confidence_band: result.confidence_band,
      decision: result.decision,
      reason: result.reason,
    });
  }
}

// Re-export thresholds for convenience.
export {
  TIER0_DECISIVE_SAME,
  TIER0_DECISIVE_DIFFERENT,
  TIER1_DECISIVE_SAME,
  TIER1_DECISIVE_DIFFERENT,
};
