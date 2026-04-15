// embeddings.mjs — Tier 1 of the tiered AI ladder.
//
// Backed by `@xenova/transformers` (MiniLM-L6-v2, 384 dims) loaded
// lazily via dynamic import. The dependency is OPTIONAL: if it is
// not installed, Tier 1 is unavailable and `tiered.mjs` falls
// through to Tier 2 (Claude) or skips depending on quality mode.
//
// Interactive install is handled by `ensureTier1({ interactive })`:
//   - In interactive mode the user is prompted once per wiki.
//   - In non-interactive mode absence is silent (CI, hooks,
//     --no-prompt, LLM_WIKI_NO_PROMPT, quality-mode=tier0-only).
//   - A persistent decline is recorded in <wiki>/.llmwiki/tier1.yaml
//     so subsequent runs skip the prompt until the marker is
//     cleared manually or `--install-tier1` is passed.
//
// Phase 6's implementation stubs the real install path behind a
// `LLM_WIKI_MOCK_TIER1` env var: when set, the "model" is a
// deterministic hash-based vector and no network access is made.
// This is the mode the automated test suite uses. A one-off opt-in
// e2e test with `LLM_WIKI_REAL_TIER1=1` exercises the real install
// path.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { confirm, isInteractive, NonInteractiveError } from "./interactive.mjs";

// Public thresholds mirror methodology §8.5. `tiered.mjs` reads
// them via import.
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

export function tier1ConfigPath(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "tier1.yaml");
}

// ── Availability detection ───────────────────────────────────────────
//
// `@xenova/transformers` may not be installed. We attempt a dynamic
// import once and cache the result. Tests can force the mock via the
// LLM_WIKI_MOCK_TIER1 env var.

let _tier1Module = null;
let _tier1Loaded = false;
let _tier1LoadError = null;

// Reset hook for tests so fresh scenarios get a clean load state.
// Resets EVERY piece of module state the embeddings module owns so
// tests that switch wikis, mock modes, or installer outcomes start
// from a clean slate — including the lazily-constructed model
// extractor cached by `realEmbed`.
export function _resetTier1LoadState() {
  _tier1Module = null;
  _tier1Loaded = false;
  _tier1LoadError = null;
  _extractor = null;
}

export function isMockMode() {
  return (
    process.env.LLM_WIKI_MOCK_TIER1 === "1" ||
    process.env.LLM_WIKI_MOCK_TIER1 === "true"
  );
}

async function tryLoadTier1() {
  if (_tier1Loaded) {
    return { module: _tier1Module, error: _tier1LoadError };
  }
  _tier1Loaded = true;
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
}

// Is Tier 1 usable right now? Cheap check — does not run the model.
export async function isAvailable() {
  const r = await tryLoadTier1();
  return r.module !== null;
}

// Read the persistent tier1 marker (declined / installed / asked).
function readTier1Marker(wikiRoot) {
  const path = tier1ConfigPath(wikiRoot);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^(\w+):\s*(\S.*)?$/.exec(line);
      if (!m) continue;
      out[m[1]] = (m[2] ?? "").trim();
    }
    return out;
  } catch {
    return {};
  }
}

function writeTier1Marker(wikiRoot, marker) {
  const path = tier1ConfigPath(wikiRoot);
  mkdirSync(dirname(path), { recursive: true });
  const lines = ["# skill-llm-wiki Tier 1 local-embeddings marker"];
  for (const [k, v] of Object.entries(marker)) {
    lines.push(`${k}: ${v}`);
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

// ── The install prompt contract ──────────────────────────────────────
//
// `ensureTier1(wikiRoot, { interactive })` is the single entry point
// the tiered orchestrator uses. Return shape:
//   { available, reason, model? }
//
// where reason is one of:
//   "ready"              Tier 1 is loaded and ready to embed.
//   "mock"               Mock mode — deterministic fake embeddings.
//   "user-declined"      Persistent decline recorded in tier1.yaml.
//   "non-interactive"    Not installed + non-interactive mode.
//   "install-failed"     User accepted install but npm failed.
//   "module-load-failed" Installed but dynamic import still errors.

export async function ensureTier1(wikiRoot, opts = {}) {
  const {
    interactive = isInteractive(opts),
    forceInstall = false,
    skipInstall = false,
  } = opts;

  // If the user passed --no-install-tier1, never install regardless
  // of interactive mode.
  if (skipInstall) {
    const r = await tryLoadTier1();
    if (r.module) return { available: true, reason: isMockMode() ? "mock" : "ready", model: r.module };
    return { available: false, reason: "non-interactive" };
  }

  // Fast path: already loaded (mock or real).
  const initial = await tryLoadTier1();
  if (initial.module) {
    return { available: true, reason: isMockMode() ? "mock" : "ready", model: initial.module };
  }

  // Not loaded. Check the persistent marker unless forced.
  if (!forceInstall) {
    const marker = readTier1Marker(wikiRoot);
    if (marker.declined === "true") {
      return { available: false, reason: "user-declined" };
    }
  }

  // Not interactive → silent fallthrough.
  if (!interactive && !forceInstall) {
    return { available: false, reason: "non-interactive" };
  }

  // Interactive or forced: ask the user (force bypasses the prompt).
  if (!forceInstall) {
    let accepted;
    try {
      accepted = await confirm(
        "Install local embeddings (~23 MB one-time download) to speed up " +
          "similarity and save Claude tokens on large corpora?",
        { default: true, forceInteractive: opts.forceInteractive === true },
      );
    } catch (err) {
      if (err instanceof NonInteractiveError) {
        return { available: false, reason: "non-interactive" };
      }
      throw err;
    }
    if (!accepted) {
      writeTier1Marker(wikiRoot, { declined: "true", asked_at: new Date().toISOString() });
      return { available: false, reason: "user-declined" };
    }
  }

  // User said yes OR forceInstall is set — run the installer. We
  // stub this path under LLM_WIKI_MOCK_TIER1 so the test suite never
  // actually spawns npm.
  const installResult = await runInstaller();
  if (!installResult.ok) {
    return { available: false, reason: "install-failed", error: installResult.error };
  }
  writeTier1Marker(wikiRoot, { installed: "true", installed_at: new Date().toISOString() });

  // Try loading again after install.
  _resetTier1LoadState();
  const after = await tryLoadTier1();
  if (after.module) {
    return { available: true, reason: isMockMode() ? "mock" : "ready", model: after.module };
  }
  return { available: false, reason: "module-load-failed", error: after.error };
}

// The installer is a stub under mock mode and a real `npm install`
// under normal mode. `spawnFn` is an injection seam so tests can
// substitute a mock spawner and exercise every failure branch
// (spawn error, signal kill, non-zero exit, success). Exported so
// the test file can import it directly.
export async function runInstaller({ spawnFn = null } = {}) {
  if (isMockMode()) {
    return { ok: true };
  }
  // Real install path: spawn `npm install --save-optional
  // @xenova/transformers` in the skill's own directory (NOT cwd).
  // Resolving the skill directory from this module's import.meta
  // URL keeps the install local to the skill.
  const { spawnSync: realSpawn } = await import("node:child_process");
  const spawn = spawnFn ?? realSpawn;
  const { fileURLToPath } = await import("node:url");
  const thisFile = fileURLToPath(import.meta.url);
  const skillDir = join(thisFile, "..", "..", "..");
  const r = spawn(
    "npm",
    ["install", "--save-optional", "@xenova/transformers"],
    { cwd: skillDir, encoding: "utf8", stdio: "inherit" },
  );
  // Distinguish the three failure modes:
  //   1. Spawn error (npm not on PATH, ENOENT) — r.error is set.
  //   2. Killed by signal — r.signal is set.
  //   3. Non-zero exit — r.status !== 0.
  if (r.error) {
    return {
      ok: false,
      error: `npm could not start: ${r.error.message || String(r.error)}`,
    };
  }
  if (r.signal) {
    return { ok: false, error: `npm killed by signal ${r.signal}` };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      error: r.stderr?.trim() || `npm exited with status ${r.status}`,
    };
  }
  return { ok: true };
}

// ── Embedding generation ─────────────────────────────────────────────
//
// Given a text, returns a Float32Array embedding. Results are
// cached on disk at <wiki>/.llmwiki/embedding-cache/<sha>.f32.
// The cache key is the sha256 of the input text — identical texts
// across entries share a cache entry.
//
// In mock mode the "embedding" is a deterministic hash-derived
// vector: the first N bytes of sha256(text) mapped onto a unit
// vector. This gives stable pairwise distances in tests without
// requiring a real model.

export async function embed(wikiRoot, text, opts = {}) {
  const { moduleHint = null } = opts;
  const hash = createHash("sha256").update(text).digest("hex");
  const cachePath = embeddingCachePath(wikiRoot, hash);
  if (existsSync(cachePath)) {
    return readCachedEmbedding(cachePath);
  }
  let vec;
  if (isMockMode()) {
    vec = mockEmbed(text);
  } else {
    const mod = moduleHint ?? (await tryLoadTier1()).module;
    if (!mod) {
      throw new Error("embeddings: Tier 1 not available at embed() time");
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
