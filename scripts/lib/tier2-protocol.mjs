// tier2-protocol.mjs — the contract between the skill's CLI and the
// wiki-runner sub-agent that answers Tier 2 requests.
//
// Design A: exit-7 handshake. The CLI runs under Node and cannot
// call Claude Code's Agent tool directly. So when a convergence
// phase accumulates Tier 2 requests we:
//
//   1. Write a pending-batch file listing all open requests.
//   2. Exit with code 7 (NEEDS_TIER2).
//   3. The wiki-runner spawns one sub-agent per request, collects
//      structured responses, writes a sibling response file.
//   4. The wiki-runner re-invokes the CLI with the same op-id.
//   5. On resume the CLI reads the response files, feeds the
//      answers into the tiered decision cache, and continues.
//
// This module owns:
//
//   - Batch path helpers (`pending` + `responses`)
//   - Request builders + response validators for each `kind`
//   - Batch read / write / merge helpers
//   - Pollution-key defence for JSON parse
//
// Request shape (JSON):
//   {
//     request_id:      string, unique per batch
//     kind:            "merge_decision" | "nest_decision" | "cluster_name"
//                    | "propose_structure"
//                    | "draft_frontmatter" | "rebuild_plan_review"
//                    | "human_fix_item"
//     prompt:          natural-language question the sub-agent answers
//     inputs:          minimal per-kind inputs (frontmatter blobs, etc.)
//     response_schema: JSON shape the sub-agent must return
//     model_hint:      string, picked from guide/tiered-ai.md matrix
//     effort_hint:     string, picked from guide/tiered-ai.md matrix
//   }
//
// Response shape (JSON):
//   {
//     request_id: string (matches request.request_id)
//     response:   matches request.response_schema
//   }
//
// A batch lives at `<wiki>/.work/tier2/pending-<batch-id>.json`
// and its responses at `<wiki>/.work/tier2/responses-<batch-id>.json`.
// Batches are uniquely tagged by batch-id (op-id + phase + iteration).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const TIER2_EXIT_CODE = 7;

// The default model + effort matrix from guide/tiered-ai.md. Each
// request kind maps to a model hint and an effort hint the wiki-
// runner uses when spawning the sub-agent. These are hints, not
// mandates — the wiki-runner may override per-session.
export const TIER2_DEFAULTS = Object.freeze({
  merge_decision: {
    model_hint: "sonnet",
    effort_hint: "low",
    response_schema: {
      decision: "same|different|undecidable",
      reason: "string",
    },
  },
  nest_decision: {
    model_hint: "sonnet",
    effort_hint: "medium",
    response_schema: {
      decision: "nest|keep_flat|undecidable",
      reason: "string",
    },
  },
  cluster_name: {
    model_hint: "sonnet",
    effort_hint: "low",
    response_schema: {
      slug: "kebab-case-slug",
      purpose: "string",
    },
  },
  // propose_structure — whole-directory structural optimiser. Given
  // N leaves under one parent, ask Tier 2 to propose the optimal
  // nested partition: subcategories (with slug + purpose + member
  // ids) plus the leaves that should remain as siblings. This is
  // the "Tier 2 gets first dibs" escalation and fires BEFORE the
  // math-based cluster detector on every non-already-nested
  // directory. Opus + medium effort because the task is a
  // structural judgment call over many inputs that benefits from
  // the strongest reasoning model.
  propose_structure: {
    model_hint: "opus",
    effort_hint: "medium",
    response_schema: {
      subcategories: "array of { slug, purpose, members[] }",
      siblings: "array of leaf ids",
      notes: "string",
    },
  },
  draft_frontmatter: {
    model_hint: "sonnet",
    effort_hint: "medium",
    response_schema: {
      focus: "string",
      covers: "array of strings",
      tags: "array of strings",
    },
  },
  rebuild_plan_review: {
    model_hint: "opus",
    effort_hint: "high",
    response_schema: {
      approve: "boolean",
      drop: "array of iteration ids",
      notes: "string",
    },
  },
  human_fix_item: {
    model_hint: "sonnet",
    effort_hint: "low",
    response_schema: {
      action: "string",
      rationale: "string",
    },
  },
});

export const TIER2_KINDS = Object.freeze(Object.keys(TIER2_DEFAULTS));

// Pollution keys that would leak onto Object.prototype if we
// blindly merged parsed JSON. We refuse requests/responses that
// contain them at the top level.
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasPollution(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const k of Object.keys(obj)) {
    if (POLLUTION_KEYS.has(k)) return true;
  }
  return false;
}

// ── Paths ────────────────────────────────────────────────────────────

export function tier2Dir(wikiRoot) {
  return join(wikiRoot, ".work", "tier2");
}

export function pendingPath(wikiRoot, batchId) {
  return join(tier2Dir(wikiRoot), `pending-${batchId}.json`);
}

export function responsesPath(wikiRoot, batchId) {
  return join(tier2Dir(wikiRoot), `responses-${batchId}.json`);
}

// List all (batchId, pending path, response path) triples under a
// wiki's tier2 dir. Used during resume to discover what's waiting
// and what's been answered.
export function listBatches(wikiRoot) {
  const dir = tier2Dir(wikiRoot);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const m = /^pending-(.+)\.json$/.exec(name);
    if (!m) continue;
    const batchId = m[1];
    out.push({
      batchId,
      pending: join(dir, name),
      responses: responsesPath(wikiRoot, batchId),
    });
  }
  return out.sort((a, b) => a.batchId.localeCompare(b.batchId));
}

// ── Request builders ────────────────────────────────────────────────
//
// Callers construct a Tier 2 request via `makeRequest(kind, {...})`.
// The builder fills in defaults from TIER2_DEFAULTS and validates
// the shape. `inputs` is kind-specific and kept small (a few
// frontmatter blobs at most) so batches stay under a few KB each.

export function makeRequest(kind, { prompt, inputs, model_hint, effort_hint, request_id } = {}) {
  if (!TIER2_KINDS.includes(kind)) {
    throw new Error(`tier2-protocol: unknown kind "${kind}" (valid: ${TIER2_KINDS.join(", ")})`);
  }
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("tier2-protocol: prompt must be a non-empty string");
  }
  if (inputs === undefined || inputs === null) {
    throw new Error("tier2-protocol: inputs is required");
  }
  if (hasPollution(inputs)) {
    throw new Error("tier2-protocol: inputs contains a forbidden key");
  }
  const defaults = TIER2_DEFAULTS[kind];
  const rid = request_id ?? deriveRequestId(kind, inputs);
  return {
    request_id: rid,
    kind,
    prompt,
    inputs,
    response_schema: defaults.response_schema,
    model_hint: model_hint ?? defaults.model_hint,
    effort_hint: effort_hint ?? defaults.effort_hint,
  };
}

// Deterministic request id: sha256(kind + canonical-JSON(inputs))
// truncated to 16 hex chars. Stable across runs, so the same
// cluster re-asked produces the same request id.
//
// NOTE: JSON.stringify's replacer-array argument is a property-
// name FILTER at every nesting level, not a sorter. Using it
// accidentally erased every nested property and collapsed
// distinct inputs to the same hash. Use a manual canonical
// serializer instead.
function deriveRequestId(kind, inputs) {
  const text = kind + "\0" + canonicalJson(inputs);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Canonical JSON: sort object keys at every level, serialize
// arrays and primitives normally. Produces a byte-identical
// string for any two semantically-equal inputs.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalJson(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

// ── Request validation ─────────────────────────────────────────────

export function validateRequest(req) {
  if (!req || typeof req !== "object") {
    throw new Error("tier2-protocol: request must be an object");
  }
  if (hasPollution(req)) {
    throw new Error("tier2-protocol: request contains a forbidden key");
  }
  if (typeof req.request_id !== "string" || req.request_id.length === 0) {
    throw new Error("tier2-protocol: request.request_id must be a non-empty string");
  }
  if (!TIER2_KINDS.includes(req.kind)) {
    throw new Error(`tier2-protocol: request.kind "${req.kind}" is not recognised`);
  }
  if (typeof req.prompt !== "string" || req.prompt.length === 0) {
    throw new Error("tier2-protocol: request.prompt must be a non-empty string");
  }
  if (req.inputs === undefined || req.inputs === null) {
    throw new Error("tier2-protocol: request.inputs is required");
  }
  return true;
}

// ── Response validation ────────────────────────────────────────────

export function validateResponse(res) {
  if (!res || typeof res !== "object") {
    throw new Error("tier2-protocol: response must be an object");
  }
  if (hasPollution(res)) {
    throw new Error("tier2-protocol: response contains a forbidden key");
  }
  if (typeof res.request_id !== "string" || res.request_id.length === 0) {
    throw new Error("tier2-protocol: response.request_id must be a non-empty string");
  }
  if (res.response === undefined || res.response === null) {
    throw new Error("tier2-protocol: response.response is required");
  }
  if (hasPollution(res.response)) {
    throw new Error("tier2-protocol: response.response contains a forbidden key");
  }
  return true;
}

// ── Batch file I/O ─────────────────────────────────────────────────

export function writePending(wikiRoot, batchId, requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error("tier2-protocol: writePending requires at least one request");
  }
  for (const r of requests) validateRequest(r);
  const path = pendingPath(wikiRoot, batchId);
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(
    {
      batch_id: batchId,
      created_at: new Date().toISOString(),
      requests,
    },
    null,
    2,
  );
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
  return path;
}

export function readPending(wikiRoot, batchId) {
  const path = pendingPath(wikiRoot, batchId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed || !Array.isArray(parsed.requests)) {
    throw new Error(`tier2-protocol: pending file ${path} malformed`);
  }
  for (const r of parsed.requests) validateRequest(r);
  return parsed;
}

export function writeResponses(wikiRoot, batchId, responses) {
  if (!Array.isArray(responses)) {
    throw new Error("tier2-protocol: writeResponses requires an array");
  }
  for (const r of responses) validateResponse(r);
  const path = responsesPath(wikiRoot, batchId);
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify(
    {
      batch_id: batchId,
      completed_at: new Date().toISOString(),
      responses,
    },
    null,
    2,
  );
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
  return path;
}

export function readResponses(wikiRoot, batchId) {
  const path = responsesPath(wikiRoot, batchId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed || !Array.isArray(parsed.responses)) {
    throw new Error(`tier2-protocol: response file ${path} malformed`);
  }
  for (const r of parsed.responses) validateResponse(r);
  return parsed;
}

// Read all responses for a wiki, merging by request_id into a map.
// Used during resume to populate the decision cache.
export function readAllResponses(wikiRoot) {
  const out = new Map();
  const batches = listBatches(wikiRoot);
  for (const b of batches) {
    if (!existsSync(b.responses)) continue;
    const parsed = readResponses(wikiRoot, b.batchId);
    if (!parsed) continue;
    for (const r of parsed.responses) {
      out.set(r.request_id, r.response);
    }
  }
  return out;
}

// ── Fixture support (LLM_WIKI_TIER2_FIXTURE) ───────────────────────
//
// When the env var is set, tests can provide a single JSON file
// containing either an array of {request_id, response} pairs OR a
// map of { request_id → response }. The CLI path uses
// `loadFixture` to resolve Tier 2 requests inline instead of
// exiting with code 7. This is the ONLY way to run Tier 2 paths
// hermetically — the production path always emits exit 7.

export function fixturePath() {
  return process.env.LLM_WIKI_TIER2_FIXTURE || null;
}

export function loadFixture() {
  const path = fixturePath();
  if (!path) return null;
  if (!existsSync(path)) {
    throw new Error(`tier2-protocol: LLM_WIKI_TIER2_FIXTURE points at missing file ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = safeJsonParse(raw);
  const map = new Map();
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (hasPollution(item)) {
        throw new Error("tier2-protocol: fixture item contains a forbidden key");
      }
      if (!item || typeof item.request_id !== "string") {
        throw new Error("tier2-protocol: fixture array item missing request_id");
      }
      map.set(item.request_id, item.response);
    }
    return map;
  }
  if (parsed && typeof parsed === "object") {
    if (hasPollution(parsed)) {
      throw new Error("tier2-protocol: fixture object contains a forbidden key");
    }
    for (const [k, v] of Object.entries(parsed)) {
      map.set(k, v);
    }
    return map;
  }
  throw new Error(`tier2-protocol: fixture at ${path} is neither array nor object`);
}

// Resolve a single request against the fixture map. Returns the
// response value (the inner `response` object) or null if the
// fixture doesn't carry this request id — in which case the caller
// can decide whether to fall through to exit-7 or to a sensible
// default.
//
// Wildcard fallback: a fixture may carry a special key
// `__kind__<kind>` whose value is the default response for any
// request of that kind that is not matched by a specific
// request_id. This exists so tests (and long-running convergence
// runs) can answer propose_structure / nest_decision / cluster_name
// with a uniform default response without pre-computing every
// possible request_id across every iteration.
export function resolveFromFixture(fixtureMap, request) {
  if (!fixtureMap) return null;
  if (!request || typeof request.request_id !== "string") return null;
  const specific = fixtureMap.get(request.request_id);
  if (specific !== undefined) return specific;
  if (typeof request.kind === "string") {
    const wildcard = fixtureMap.get(`__kind__${request.kind}`);
    if (wildcard !== undefined) return wildcard;
  }
  return null;
}

// ── Safe JSON parse (rejects pollution keys) ───────────────────────

function safeJsonParse(raw) {
  const parsed = JSON.parse(raw);
  if (hasPollution(parsed)) {
    throw new Error("tier2-protocol: parsed JSON contains a forbidden top-level key");
  }
  return parsed;
}

// ── Batch id derivation ────────────────────────────────────────────
//
// A batch id is a short deterministic string built from the op-id,
// phase name, and iteration number. Deterministic so rerunning the
// same op produces the same batch id and the wiki-runner can
// correlate pending ↔ responses unambiguously.
export function deriveBatchId(opId, phase, iteration) {
  const text = `${opId}\0${phase}\0${iteration}`;
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
