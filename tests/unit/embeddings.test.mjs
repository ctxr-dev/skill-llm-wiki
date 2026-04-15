// embeddings.test.mjs — Tier 1 mock-mode unit tests.
//
// Tier 1 is now a REQUIRED dependency. The legacy "optional install
// prompt" paths (runInstaller, tier1ConfigPath, user-declined marker,
// skipInstall) were deleted as part of the optimization overhaul —
// see the overhaul notes in scripts/lib/embeddings.mjs. This file
// exercises the remaining contract:
//
//   - Deterministic mock vectors (for hermetic CI)
//   - Cache round-trip
//   - Cosine edge cases
//   - ensureTier1 return shape
//   - Namespace separation between mock and real caches
//
// Real-model tests live in tests/unit/embeddings-real.test.mjs and
// are gated on LLM_WIKI_TIER1_REAL=1.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EMBEDDING_DIMS,
  _resetTier1LoadState,
  embed,
  embeddingCachePath,
  embeddingCosine,
  ensureTier1,
  isAvailable,
  isMockMode,
} from "../../scripts/lib/embeddings.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-emb-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

// Every test runs in mock mode. Set the env var once at module load.
process.env.LLM_WIKI_MOCK_TIER1 = "1";

test("isMockMode reflects env var", () => {
  assert.equal(isMockMode(), true);
});

test("isAvailable returns true in mock mode", async () => {
  _resetTier1LoadState();
  assert.equal(await isAvailable(), true);
});

test("ensureTier1 in mock mode returns reason=mock", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("mock-ready");
  try {
    const r = await ensureTier1(wiki, { interactive: false });
    assert.equal(r.available, true);
    assert.equal(r.reason, "mock");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embed produces a Float32Array of EMBEDDING_DIMS length", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("embed-shape");
  try {
    const vec = await embed(wiki, "prisma database migrations");
    assert.ok(vec instanceof Float32Array);
    assert.equal(vec.length, EMBEDDING_DIMS);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embed is deterministic: same input → same vector", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("determinism");
  try {
    const a = await embed(wiki, "react hooks");
    rmSync(join(wiki, ".llmwiki"), { recursive: true, force: true });
    const b = await embed(wiki, "react hooks");
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i], b[i]);
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embed caches: second call reads from disk", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("cache");
  try {
    const text = "prisma schema migrations";
    const v1 = await embed(wiki, text);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(text).digest("hex");
    assert.ok(existsSync(embeddingCachePath(wiki, hash)));
    const v2 = await embed(wiki, text);
    for (let i = 0; i < v1.length; i++) {
      assert.equal(v1[i], v2[i]);
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embeddingCosine: identical vectors → 1 (within ε)", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("cosine-self");
  try {
    const v = await embed(wiki, "stateful streams");
    const s = embeddingCosine(v, v);
    assert.ok(Math.abs(s - 1) < 1e-5, `expected ~1, got ${s}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embeddingCosine: zero vectors → 0 (not NaN)", () => {
  const zero = new Float32Array(EMBEDDING_DIMS);
  assert.equal(embeddingCosine(zero, zero), 0);
});

test("embeddingCosine: mismatched-length inputs → 0", () => {
  const a = new Float32Array(384);
  const b = new Float32Array(256);
  assert.equal(embeddingCosine(a, b), 0);
});

test("embeddingCosine: different texts score lower than identical", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("cosine-diff");
  try {
    const self = await embed(wiki, "cache invalidation");
    const diff = await embed(wiki, "quaternion rotation math");
    const selfSim = embeddingCosine(self, self);
    const diffSim = embeddingCosine(self, diff);
    assert.ok(selfSim > diffSim, `self ${selfSim} must exceed cross ${diffSim}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embed handles the empty string (returns a valid vector)", async () => {
  _resetTier1LoadState();
  const wiki = tmpWiki("empty");
  try {
    const vec = await embed(wiki, "");
    assert.equal(vec.length, EMBEDDING_DIMS);
    assert.ok(vec instanceof Float32Array);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embeddingCachePath: mock and real modes use separate namespaces", async () => {
  const wiki = tmpWiki("ns");
  try {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    const mockPath = embeddingCachePath(wiki, "deadbeef");
    delete process.env.LLM_WIKI_MOCK_TIER1;
    const realPath = embeddingCachePath(wiki, "deadbeef");
    assert.notEqual(mockPath, realPath);
    assert.match(mockPath, /mock/);
    assert.match(realPath, /model-minilm/);
  } finally {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embed caches under the mock namespace when in mock mode", async () => {
  const wiki = tmpWiki("ns-mock");
  try {
    _resetTier1LoadState();
    await embed(wiki, "namespace test");
    const mockDir = join(wiki, ".llmwiki", "embedding-cache", "mock");
    assert.ok(existsSync(mockDir));
    const realDir = join(wiki, ".llmwiki", "embedding-cache", "model-minilm");
    assert.ok(!existsSync(realDir));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// Regression: `tryLoadTier1` used to flip a boolean flag synchronously
// BEFORE awaiting the dynamic import. Concurrent callers (e.g., the 17+
// parallel `embed()` calls cluster-detect fires via Promise.all) would
// see "loaded=true" but read the module reference before the import
// settled, and throw "Tier 1 failed to load" even though the import
// was in flight and would have succeeded. The fix is to cache the
// in-flight promise instead of a bare boolean, so every concurrent
// caller awaits the same resolution. This test guarantees the race is
// gone by kicking off N parallel embed calls immediately after a
// reset and asserting they all return valid vectors.
test("concurrent embed() calls after reset all resolve (no TOCTOU race)", async () => {
  const wiki = tmpWiki("concurrent-load");
  try {
    _resetTier1LoadState();
    const texts = Array.from({ length: 20 }, (_, i) => `concurrent text ${i}`);
    const vectors = await Promise.all(texts.map((t) => embed(wiki, t)));
    assert.equal(vectors.length, 20);
    for (const v of vectors) {
      assert.ok(v instanceof Float32Array);
      assert.equal(v.length, EMBEDDING_DIMS);
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
