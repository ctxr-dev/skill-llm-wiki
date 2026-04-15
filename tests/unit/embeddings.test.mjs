// embeddings.test.mjs — Tier 1 mock-mode tests.
//
// Real-model tests are gated on LLM_WIKI_REAL_TIER1=1 in a separate
// file so CI never fetches model weights. Here we exercise the
// contract in deterministic mock mode.
//
// Edge cases:
//   - Mock mode produces deterministic vectors
//   - Identical text → cosine 1 (within float ε)
//   - Different text → cosine < 1
//   - Empty string handled
//   - Cache is a deterministic function of text hash
//   - Cache survives process boundary (read back after write)
//   - Float32Array serialisation round-trip
//   - ensureTier1 in mock mode returns { available: true, reason: "mock" }
//   - ensureTier1 user-declined is persistent
//   - ensureTier1 non-interactive → silent fallthrough when absent
//   - ensureTier1 forceInstall bypasses the prompt

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  runInstaller,
  tier1ConfigPath,
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
    // Clear cache to force re-compute.
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
    // Verify a cache file exists.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(text).digest("hex");
    assert.ok(existsSync(embeddingCachePath(wiki, hash)));
    // Second call returns the same vector.
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

test("ensureTier1: persistent decline is honoured across calls", async () => {
  _resetTier1LoadState();
  // Force the normal (non-mock) path via a temporary env override so
  // the prompt logic is exercised. We then set the marker manually.
  const wiki = tmpWiki("decline");
  try {
    // Pre-plant the decline marker.
    mkdirSync(join(wiki, ".llmwiki"), { recursive: true });
    writeFileSync(
      tier1ConfigPath(wiki),
      "declined: true\nasked_at: 2026-04-15T00:00:00Z\n",
    );
    // Disable mock temporarily so the real import branch runs.
    delete process.env.LLM_WIKI_MOCK_TIER1;
    _resetTier1LoadState();
    try {
      const r = await ensureTier1(wiki, { interactive: true, noPrompt: false });
      // Since we're not mocking and @xenova/transformers isn't
      // installed, and the decline marker is present, the result
      // must be user-declined.
      assert.equal(r.available, false);
      assert.equal(r.reason, "user-declined");
    } finally {
      process.env.LLM_WIKI_MOCK_TIER1 = "1";
      _resetTier1LoadState();
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("ensureTier1: non-interactive + absent dep → silent non-interactive", async () => {
  const wiki = tmpWiki("noninteractive");
  try {
    delete process.env.LLM_WIKI_MOCK_TIER1;
    _resetTier1LoadState();
    try {
      const r = await ensureTier1(wiki, { interactive: false, noPrompt: true });
      // Without the dependency installed this resolves to non-interactive.
      assert.equal(r.available, false);
      assert.equal(r.reason, "non-interactive");
    } finally {
      process.env.LLM_WIKI_MOCK_TIER1 = "1";
      _resetTier1LoadState();
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("embeddingCachePath: mock and real modes use separate namespaces", async () => {
  // Regression for the cache namespace collision. A mock-mode cache
  // entry and a real-mode cache entry for the SAME text hash must
  // resolve to DIFFERENT paths. If they share a path, a CI run
  // under mock mode would silently poison a later real-model build.
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

test("runInstaller: reports ENOENT (npm not on PATH) via spawn error", async () => {
  // Exercise the `r.error` branch — spawnSync returns a result with
  // `.error` set when the binary can't be found. We stub the
  // spawner to simulate ENOENT without actually missing npm.
  delete process.env.LLM_WIKI_MOCK_TIER1;
  try {
    const r = await runInstaller({
      spawnFn: () => ({
        error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
        status: null,
      }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /npm could not start.*ENOENT/);
  } finally {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    _resetTier1LoadState();
  }
});

test("runInstaller: reports signal kill via r.signal", async () => {
  delete process.env.LLM_WIKI_MOCK_TIER1;
  try {
    const r = await runInstaller({
      spawnFn: () => ({ status: null, signal: "SIGKILL" }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /killed by signal SIGKILL/);
  } finally {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    _resetTier1LoadState();
  }
});

test("runInstaller: reports non-zero exit with stderr", async () => {
  delete process.env.LLM_WIKI_MOCK_TIER1;
  try {
    const r = await runInstaller({
      spawnFn: () => ({
        status: 1,
        stderr: "npm ERR! Could not resolve dependency\n",
      }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not resolve dependency/);
  } finally {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    _resetTier1LoadState();
  }
});

test("runInstaller: reports success on status 0", async () => {
  delete process.env.LLM_WIKI_MOCK_TIER1;
  try {
    const r = await runInstaller({
      spawnFn: () => ({ status: 0 }),
    });
    assert.equal(r.ok, true);
  } finally {
    process.env.LLM_WIKI_MOCK_TIER1 = "1";
    _resetTier1LoadState();
  }
});

test("runInstaller: mock mode short-circuits without spawning", async () => {
  process.env.LLM_WIKI_MOCK_TIER1 = "1";
  let spawnCalled = false;
  const r = await runInstaller({
    spawnFn: () => {
      spawnCalled = true;
      return { status: 1 };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(spawnCalled, false);
});

test("ensureTier1: skipInstall + absent dep → non-interactive", async () => {
  const wiki = tmpWiki("skip");
  try {
    delete process.env.LLM_WIKI_MOCK_TIER1;
    _resetTier1LoadState();
    try {
      const r = await ensureTier1(wiki, {
        interactive: true,
        skipInstall: true,
      });
      assert.equal(r.available, false);
      assert.equal(r.reason, "non-interactive");
    } finally {
      process.env.LLM_WIKI_MOCK_TIER1 = "1";
      _resetTier1LoadState();
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
