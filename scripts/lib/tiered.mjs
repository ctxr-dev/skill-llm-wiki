// tiered.mjs — the escalation orchestrator for the tiered AI ladder.
//
// Every similarity decision (classify, MERGE/DECOMPOSE/NEST
// detection in operator-convergence, cluster-name at NEST time,
// Rebuild plan-review, Join id-collision) flows through this
// module. It runs Tier 0 (TF-IDF), escalates to Tier 1 (local
// MiniLM embeddings — now a required dep) on mid-band results, and
// escalates to Tier 2 (sub-agent, via exit-7 handshake) only for
// the residual ambiguous cases. A similarity-cache hit short-
// circuits the whole ladder.
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
//     straight to Tier 2, skipping Tier 1.
//
//   tier0-only:
//     Tier 0 decisions only. Mid-band becomes an explicit
//     "undecidable" marker that the caller must resolve manually.
//
// Tier 2 escalation contract: the skill's CLI runs under Node with
// no access to Claude Code's `Agent` tool, so it cannot spawn
// sub-agents directly. Instead, Tier 2 requests are accumulated in
// a per-batch pending queue (tier2-protocol.mjs). When a phase
// finishes, the caller writes the batch to
// `<wiki>/.work/tier2/pending-<batch-id>.json` and the CLI exits
// with code 7 (NEEDS_TIER2). The wiki-runner sub-agent spawns one
// `Agent` per request, writes the responses back, and re-invokes
// the CLI. On resume `tiered.decide` reads the responses from the
// fixture/response-map and returns inline.
//
// Test hermeticity: `LLM_WIKI_TIER2_FIXTURE=<path>` wires a
// pre-canned fixture into the decide() path so unit/e2e tests can
// drive Tier 2 decisions without exit-7.

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
import {
  loadFixture,
  makeRequest,
  resolveFromFixture,
} from "./tier2-protocol.mjs";

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

// ── Tier 2 pending queue ────────────────────────────────────────────
//
// A lightweight per-wiki queue of Tier 2 requests that the caller
// accumulates during a phase. When the phase finishes, the caller
// drains the queue and writes the batch via tier2-protocol. The
// queue is a module-level Map keyed by wikiRoot so multiple
// operations in the same process (tests) don't collide.

const PENDING_QUEUES = new Map();

export function takePendingRequests(wikiRoot) {
  const list = PENDING_QUEUES.get(wikiRoot) || [];
  PENDING_QUEUES.delete(wikiRoot);
  return list;
}

export function countPendingRequests(wikiRoot) {
  return (PENDING_QUEUES.get(wikiRoot) || []).length;
}

export function _resetPendingQueues() {
  PENDING_QUEUES.clear();
}

export function enqueuePending(wikiRoot, request) {
  if (!PENDING_QUEUES.has(wikiRoot)) {
    PENDING_QUEUES.set(wikiRoot, []);
  }
  // Dedup by request_id — same question asked twice answers once.
  const list = PENDING_QUEUES.get(wikiRoot);
  if (list.some((r) => r.request_id === request.request_id)) return;
  list.push(request);
}

// Backwards-compatible seam used by operators.mjs to push
// cluster_name requests onto the shared queue.
export const _appendPending = enqueuePending;

// ── Resolved-response cache ────────────────────────────────────────
//
// Once the wiki-runner has written responses, we load them once at
// phase-resume and then queries into this Map return the resolved
// value inline. Unit tests can seed via `seedTier2Responses`.

const RESOLVED_RESPONSES = new Map();

export function seedTier2Responses(wikiRoot, map) {
  RESOLVED_RESPONSES.set(wikiRoot, map);
}

export function clearTier2Responses(wikiRoot) {
  RESOLVED_RESPONSES.delete(wikiRoot);
}

function resolvedResponseFor(wikiRoot, requestId) {
  const m = RESOLVED_RESPONSES.get(wikiRoot);
  if (!m) return undefined;
  return m.get(requestId);
}

// Public lookup used by operators.mjs's cluster path to check
// whether a naming request has already been answered by a prior
// wiki-runner response (seeded via seedTier2Responses during
// resume).
export function getResolvedResponse(wikiRoot, requestId) {
  return resolvedResponseFor(wikiRoot, requestId);
}

// Content-address a pair of entries by hashing their text. Used as
// the cache key so neither the ids nor paths influence symmetry.
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
// "undecidable" | "pending-tier2".
//
// `pending-tier2` means the decision was escalated to Tier 2 and
// the response isn't available yet. The caller must queue the
// request via the pending queue and trigger exit-7 at the end of
// the current phase. On the re-invocation after the wiki-runner
// writes responses, `decide` will find the answer in the resolved-
// responses map and return it as a regular `tier=2` decision.
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
    tier2Handler = null, // legacy custom handler for unit tests
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

  // Tier 0 — always consulted. Cheap and deterministic.
  const t0 = compareEntries(a, b, contextEntries, {
    precomputedModel: options.precomputedModel ?? null,
  });
  if (t0.decision === "undecidable") {
    const result = {
      tier: 0,
      similarity: t0.similarity,
      decision: "undecidable",
      confidence_band: t0.confidence_band,
      reason: t0.reason,
    };
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
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
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
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
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
    return result;
  }

  if (qualityMode === "claude-first") {
    // Skip Tier 1 entirely, go straight to Tier 2.
    return await escalateToTier2(
      a, b, hashA, hashB, wikiRoot, opId, operator,
      t0.similarity, "claude-first mode", writeLog, writeCache,
      tier2Handler, t0, null,
    );
  }

  // tiered-fast — try Tier 1. With the required dep this must
  // always succeed; if it doesn't, surface a hard error rather than
  // silently falling through to Tier 2 (which would make every
  // build exit 7 on the first mid-band pair — a hidden regression).
  const t1Available = await ensureTier1(wikiRoot);
  if (!t1Available.available) {
    throw new Error(
      `tiered.decide: Tier 1 embeddings unavailable (${t1Available.reason}). ` +
        "Tier 1 is a required dependency — run `npm install` in the skill directory. " +
        "For test isolation set LLM_WIKI_MOCK_TIER1=1.",
    );
  }

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
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
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
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
    return result;
  }
  // Mid-band Tier 1 → Tier 2.
  return await escalateToTier2(
    a, b, hashA, hashB, wikiRoot, opId, operator,
    sim, "tier1 mid-band", writeLog, writeCache,
    tier2Handler, t0, { similarity: sim },
  );
}

// ── Tier 2 escalation ──────────────────────────────────────────────
//
// Three paths, in priority order:
//
//   1. Unit-test `tier2Handler` option — a callback that runs
//      inline and returns the decision. Used by tests that want to
//      assert the escalation path fires with specific context.
//   2. LLM_WIKI_TIER2_FIXTURE — a fixture JSON file that pre-
//      resolves request_ids. Used by e2e tests.
//   3. Resolved-responses map seeded via seedTier2Responses() — the
//      runtime-resume path: the wiki-runner wrote responses after a
//      previous exit-7 and the orchestrator seeded them for the re-
//      invocation.
//   4. Otherwise: build a merge_decision request, enqueue it, and
//      return `{ decision: "pending-tier2" }`. The caller's phase
//      handler propagates this up to drain the queue and exit 7.
async function escalateToTier2(
  a, b, hashA, hashB, wikiRoot, opId, operator,
  similarity, reason, writeLog, writeCache,
  tier2Handler, t0, t1,
) {
  // Path 1: unit-test inline handler.
  if (tier2Handler) {
    const t2 = await tier2Handler({ a, b, t0, t1, reason });
    const result = {
      tier: 2,
      similarity: t2.similarity ?? similarity,
      decision: t2.decision,
      confidence_band: t2.confidence_band ?? "claude-resolved",
      reason: t2.reason ?? reason,
    };
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
    return result;
  }

  // Build the merge_decision request. The request_id is
  // deterministic in the pair of entry texts, so the same pair
  // asked twice produces the same id and the wiki-runner only
  // answers it once.
  const request = makeRequest("merge_decision", {
    prompt:
      "Are these two frontmatter blobs describing the SAME concept " +
      "(for MERGE), DIFFERENT concepts, or is it unclear? Answer " +
      "one of 'same' / 'different' / 'undecidable' with a one-line reason.",
    inputs: { a, b, operator, tier0_similarity: t0.similarity, tier1_similarity: t1?.similarity ?? null },
  });

  // Path 2: fixture file.
  const fixture = loadFixture();
  if (fixture) {
    const resp = resolveFromFixture(fixture, request);
    if (resp && typeof resp.decision === "string") {
      const result = {
        tier: 2,
        similarity: resp.similarity ?? similarity,
        decision: resp.decision,
        confidence_band: "fixture-resolved",
        reason: resp.reason ?? "fixture",
      };
      finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
      return result;
    }
  }

  // Path 3: runtime-resolved response seeded from a previous
  // exit-7 + wiki-runner cycle.
  const resolved = resolvedResponseFor(wikiRoot, request.request_id);
  if (resolved && typeof resolved.decision === "string") {
    const result = {
      tier: 2,
      similarity: resolved.similarity ?? similarity,
      decision: resolved.decision,
      confidence_band: "runner-resolved",
      reason: resolved.reason ?? "wiki-runner",
    };
    finaliseDecision(result, { a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache });
    return result;
  }

  // Path 4: queue the request for the wiki-runner and return
  // pending-tier2. The caller's phase handler will drain the
  // queue, write a batch file, and exit 7.
  enqueuePending(wikiRoot, request);
  return {
    tier: 2,
    similarity,
    decision: "pending-tier2",
    confidence_band: "tier2-queued",
    reason,
    request_id: request.request_id,
  };
}

// Side-effects: write the decision log + the pairwise cache.
function finaliseDecision(result, ctx) {
  const {
    a, b, hashA, hashB, wikiRoot, opId, operator, writeLog, writeCache: wc,
  } = ctx;
  if (result.decision === "pending-tier2") return; // never cache pending state
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

// Legacy compat: the old handler lives on as a stub that returns
// undecidable, in case a test imports it directly. New code should
// use the exit-7 protocol.
export async function defaultTier2Handler({ t0, reason }) {
  return {
    decision: "undecidable",
    similarity: t0.similarity,
    confidence_band: "tier2-stub",
    reason: `legacy stub — ${reason}; use tier2-protocol.mjs for real escalation`,
  };
}

// Re-export thresholds for convenience.
export {
  TIER0_DECISIVE_SAME,
  TIER0_DECISIVE_DIFFERENT,
  TIER1_DECISIVE_SAME,
  TIER1_DECISIVE_DIFFERENT,
};
