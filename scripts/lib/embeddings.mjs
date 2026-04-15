// embeddings.mjs — Tier 1 of the tiered AI ladder.
//
// Backed by `@xenova/transformers` (MiniLM-L6-v2, 384 dims) loaded
// lazily via dynamic import. The dependency is REQUIRED — it is
// listed in `dependencies` (not devDependencies, not optional) and
// Tier 1 is the default decision layer after Tier 0 for every
// mid-band pair.
//
// Rationale for "required": Tier 0 TF-IDF on terse technical
// frontmatter produces mostly decisive-different results (150/151
// pairs < 0.30 on the skill's own guide/), which leaves Tier 2
// (sub-agent) as the only remaining decision layer. With no Tier 1
// at all, every non-trivially-same pair escalates to Tier 2, which
// is expensive. A real 23 MB sentence-embedding model bridges the
// gap: it's cheap, local, and shapes the decision space so Tier 2
// only sees genuinely ambiguous pairs.
//
// The `LLM_WIKI_MOCK_TIER1=1` env var is the test escape hatch.
// When set, `embed()` returns a deterministic hash-based vector
// instead of loading the real model. This is what the CI test
// suite uses; no network, no model download, no real model weights
// involved. The mock is NOT a production fallback — if Tier 1
// loading fails outside of mock mode, `embed()` throws loudly.
//
// Model download behaviour: `@xenova/transformers` downloads the
// ~23 MB MiniLM model to its HuggingFace cache the first time the
// extractor is constructed. Preflight warns if the model is not
// yet cached so the user knows the first run will pay this cost;
// the download itself is transparent and happens inside the
// pipeline constructor.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Public thresholds mirror methodology §8.5. `tiered.mjs` reads
// them via import. These are the Tier 1 (embedding cosine)
// thresholds, NOT the Tier 0 (TF-IDF) thresholds. They have been
// left unchanged from the Phase 6 stub values because they were
// justified from first principles (above 0.80 is functionally
// paraphrase-level, below 0.45 is topic-level different) and are
// corpus-independent.
export const TIER1_DECISIVE_SAME = 0.80;
export const TIER1_DECISIVE_DIFFERENT = 0.45;

// Model id + dims. Pinned here so a future model bump is one edit.
export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

// Path helpers.
//
// The cache is namespaced by mode: mock-mode vectors live under a
// separate `mock/` subdirectory from real-model vectors. Without
// this namespace a `LLM_WIKI_MOCK_TIER1=1` test run would pollute
// the real-model cache with deterministic-hash vectors that a
// subsequent real build would blindly consume as free "hits",
// producing silently-wrong similarity scores. The namespace is
// absolute: switching modes is equivalent to a fresh cache.
export function embeddingCachePath(wikiRoot, textHash) {
  const ns = isMockMode() ? "mock" : "model-minilm";
  return join(wikiRoot, ".llmwiki", "embedding-cache", ns, textHash + ".f32");
}

// ── Availability detection ───────────────────────────────────────────
//
// In mock mode we short-circuit the dynamic import entirely. In
// non-mock mode Tier 1 is required: if the dynamic import fails we
// surface the error to the caller rather than silently degrading.

let _tier1Module = null;
let _tier1LoadError = null;
// In-flight load promise. Caching the PROMISE (not a boolean) is
// essential because `tryLoadTier1` is invoked concurrently from
// multiple call sites — `cluster-detect::computeAffinityMatrix`
// launches 17+ parallel `embed()` calls via `Promise.all`, and
// `tiered.mjs` does the same for mid-band pair batches. A boolean
// flag creates a TOCTOU race: the first caller sets it to `true`,
// awaits the dynamic import, and every concurrent caller sees
// "loaded" but reads the module reference BEFORE it lands — then
// throws "Tier 1 failed to load" even though the import is in
// flight and will succeed. Caching the promise collapses every
// concurrent caller onto the same async resolution.
let _tier1LoadPromise = null;

// Reset hook for tests so fresh scenarios get a clean load state.
// Resets EVERY piece of module state the embeddings module owns so
// tests that switch wikis, mock modes, or installer outcomes start
// from a clean slate — including the lazily-constructed model
// extractor cached by `realEmbed`.
export function _resetTier1LoadState() {
  _tier1Module = null;
  _tier1LoadError = null;
  _tier1LoadPromise = null;
  _extractor = null;
}

export function isMockMode() {
  return (
    process.env.LLM_WIKI_MOCK_TIER1 === "1" ||
    process.env.LLM_WIKI_MOCK_TIER1 === "true"
  );
}

function tryLoadTier1() {
  if (_tier1LoadPromise) return _tier1LoadPromise;
  _tier1LoadPromise = (async () => {
    // Diagnostic hook: LLM_WIKI_TIER1_DEBUG=1 prints a single line to
    // stderr when the module actually starts loading. This is a
    // permanent debug seam (not a test-only var) because it lets
    // anyone triaging a slow build confirm whether the MiniLM model
    // reloaded on a resume cycle. The line is emitted BEFORE the
    // dynamic import so a failing import still produces the breadcrumb
    // that proves the attempt happened.
    if (process.env.LLM_WIKI_TIER1_DEBUG === "1") {
      process.stderr.write(
        `[tier1-debug] loading Tier 1 model ${
          isMockMode() ? "(mock)" : `(${MODEL_ID})`
        }\n`,
      );
    }
    if (isMockMode()) {
      _tier1Module = { __mock: true };
      return { module: _tier1Module, error: null };
    }
    try {
      _tier1Module = await import("@xenova/transformers");
      return { module: _tier1Module, error: null };
    } catch (err) {
      _tier1LoadError = err;
      return { module: null, error: err };
    }
  })();
  return _tier1LoadPromise;
}

// Is Tier 1 usable right now? Cheap check — does not run the model.
// In production mode this reflects whether the @xenova/transformers
// package is importable, which should always be true since it's a
// required dependency.
export async function isAvailable() {
  const r = await tryLoadTier1();
  return r.module !== null;
}

// ── The ensure-ready contract ────────────────────────────────────────
//
// `ensureTier1(wikiRoot, opts)` is the single entry point tiered.mjs
// uses. Return shape:
//   { available, reason, model? }
//
// where reason is one of:
//   "ready"              Tier 1 is loaded and ready to embed.
//   "mock"               Mock mode — deterministic fake embeddings.
//   "module-load-failed" Dynamic import of @xenova/transformers failed.
//
// Tier 1 is a REQUIRED dependency. `ensureTier1` never installs,
// never prompts, never writes a persistent decline marker. If the
// module cannot be loaded we return `available: false` with a
// descriptive reason so the caller can decide whether to raise or
// degrade (in production the caller should raise).
export async function ensureTier1(wikiRoot, opts = {}) {
  void wikiRoot;
  void opts;
  const r = await tryLoadTier1();
  if (r.module) {
    return {
      available: true,
      reason: isMockMode() ? "mock" : "ready",
      model: r.module,
    };
  }
  return {
    available: false,
    reason: "module-load-failed",
    error: r.error,
  };
}

// ── Embedding generation ─────────────────────────────────────────────
//
// Given a text, returns a Float32Array embedding. Results are
// cached on disk at <wiki>/.llmwiki/embedding-cache/<ns>/<sha>.f32.
// The cache key is the sha256 of the input text — identical texts
// across entries share a cache entry.
//
// In mock mode the "embedding" is a deterministic hash-derived
// vector: a token-bag blended with a hash vector, normalized to
// unit length. This gives stable pairwise distances in tests
// without requiring a real model.
//
// In production mode `realEmbed` spins up the MiniLM extractor on
// first call (downloading the model if not already cached) and
// reuses it for all subsequent embeddings in this process.

export async function embed(wikiRoot, text, opts = {}) {
  const { moduleHint = null } = opts;
  const hash = createHash("sha256").update(text).digest("hex");
  const cachePath = embeddingCachePath(wikiRoot, hash);
  if (existsSync(cachePath)) {
    return readCachedEmbedding(cachePath);
  }
  // Cache miss — we are about to compute a fresh embedding. In
  // production (non-mock) mode this is the point that triggers a
  // dynamic import of @xenova/transformers via `tryLoadTier1` below.
  // In mock mode the `mockEmbed` branch does the hashing inline.
  // The `LLM_WIKI_TIER1_DEBUG=1` hook surfaces BOTH paths here —
  // the breadcrumb tells an operator that the embedding cache was
  // cold and the skill had to compute a new vector. A warmed
  // resume cycle must NOT print this line for any leaf.
  if (process.env.LLM_WIKI_TIER1_DEBUG === "1") {
    process.stderr.write(
      `[tier1-debug] computing fresh embedding ${
        isMockMode() ? "(mock)" : "(model)"
      } for hash=${hash.slice(0, 12)}\n`,
    );
  }
  let vec;
  if (isMockMode()) {
    vec = mockEmbed(text);
  } else {
    let mod = moduleHint;
    if (!mod) {
      const loadResult = await tryLoadTier1();
      mod = loadResult.module;
      if (!mod) {
        const underlying = loadResult.error
          ? ` Underlying error: ${loadResult.error.message ?? String(loadResult.error)}`
          : "";
        throw new Error(
          "embeddings: Tier 1 (@xenova/transformers) failed to load — " +
            "required dependency is missing or broken. Run `npm install` " +
            "in the skill directory to restore it. Set LLM_WIKI_MOCK_TIER1=1 " +
            "only for hermetic test runs, never in production." +
            underlying,
        );
      }
    }
    vec = await realEmbed(mod, text);
  }
  writeCachedEmbedding(cachePath, vec);
  return vec;
}

// Cosine similarity between two Float32Array embeddings.
export function embeddingCosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function writeCachedEmbedding(path, vec) {
  mkdirSync(dirname(path), { recursive: true });
  // Float32Array → Buffer for direct write. Atomic via temp+rename.
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
}

function readCachedEmbedding(path) {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Deterministic mock embedding: hash the text, then map hash bytes
// into a unit vector. Identical texts produce identical vectors;
// similar texts produce moderately similar vectors because sha256
// avalanches and neighbouring inputs produce unrelated outputs.
//
// For the mock tests we need texts that SHOULD be similar to look
// similar, so we blend the hash vector with a simple token-bag
// signature. This gives us enough structure to drive tiered
// decision tests without bringing in a real model.
function mockEmbed(text) {
  const vec = new Float32Array(EMBEDDING_DIMS);
  // Primary signal: hash bytes
  const hash = createHash("sha256").update(text).digest();
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    const byte = hash[i % hash.length];
    vec[i] = (byte - 128) / 128; // in [-1, 1]
  }
  // Secondary signal: token occurrence bag. Lowercase + strip non-
  // word chars, then for each token hash it into a dim and
  // accumulate. This means texts with overlapping tokens have
  // embeddings that correlate along those dimensions.
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
  for (const token of tokens) {
    const tHash = createHash("sha256").update(token).digest();
    for (let i = 0; i < EMBEDDING_DIMS; i++) {
      vec[i] += ((tHash[i % tHash.length] - 128) / 128) * 0.3;
    }
  }
  // Normalise to unit length so cosine is well-defined.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMS; i++) vec[i] /= norm;
  }
  return vec;
}

// Real embed via @xenova/transformers. The API is:
//   const extractor = await pipeline('feature-extraction', MODEL_ID)
//   const output = await extractor(text, { pooling: 'mean', normalize: true })
//   output.data is a Float32Array
// We lazily construct the extractor and cache it in module state.
let _extractor = null;
async function realEmbed(mod, text) {
  if (!_extractor) {
    _extractor = await mod.pipeline("feature-extraction", MODEL_ID);
  }
  const output = await _extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data);
}

// Preflight warning helper: inspect the HuggingFace cache directory
// the transformers library uses and return a string when the model
// has not yet been downloaded. Intended for preflight.mjs to surface
// to the user so they understand the first run will pay the ~23 MB
// download latency. Returns null when the cache is already warm, or
// when running in mock mode (no model needed), or when the cache
// directory is unknown on this platform.
export function modelDownloadStatus() {
  if (isMockMode()) return null;
  // The library resolves its cache to:
  //   process.env.TRANSFORMERS_CACHE
  //   || <node_modules>/@xenova/transformers/.cache
  // We can't reliably introspect the latter from here without
  // importing the library, but we CAN check the former; if unset
  // we return null (optimistic) so preflight stays quiet.
  const cacheRoot = process.env.TRANSFORMERS_CACHE;
  if (!cacheRoot) return null;
  const modelDir = join(cacheRoot, MODEL_ID);
  if (existsSync(modelDir)) return null;
  return (
    `Tier 1 embedding model ${MODEL_ID} has not been downloaded yet. ` +
    `First run will pay the one-time ~23 MB download cost.`
  );
}
