// similarity-cache.test.mjs — pairwise cache behaviour.
//
// Covers:
//   - Key symmetry: (a,b) and (b,a) hit the same entry
//   - Cache miss returns null
//   - Round-trip: write then read
//   - Corrupt file → treated as miss, not thrown
//   - Atomic write leaves only the final file
//   - clearCache wipes every entry
//   - cacheSize counts correctly
//   - Empty hash rejected

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheDir,
  cacheEntryPath,
  cacheKey,
  cacheSize,
  clearCache,
  readCached,
  writeCached,
} from "../../scripts/lib/similarity-cache.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-simcache-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("cacheKey: symmetric for (a, b) and (b, a)", () => {
  const k1 = cacheKey("sha256:abc", "sha256:def");
  const k2 = cacheKey("sha256:def", "sha256:abc");
  assert.equal(k1, k2);
});

test("cacheKey: different pairs produce different keys", () => {
  const k1 = cacheKey("sha256:abc", "sha256:def");
  const k2 = cacheKey("sha256:abc", "sha256:ghi");
  assert.notEqual(k1, k2);
});

test("cacheKey: empty hash throws", () => {
  assert.throws(() => cacheKey("", "sha256:def"));
  assert.throws(() => cacheKey("sha256:abc", ""));
  assert.throws(() => cacheKey(null, null));
});

test("cacheKey: filename-safe (no slashes or special chars)", () => {
  const k = cacheKey("sha256:a/b\\c:d", "sha256:e f g");
  assert.match(k, /^[a-f0-9]{32}$/);
});

test("readCached: miss on a fresh wiki returns null", () => {
  const wiki = tmpWiki("miss");
  try {
    assert.equal(readCached(wiki, "sha256:a", "sha256:b"), null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeCached + readCached: round-trip preserves fields", () => {
  const wiki = tmpWiki("roundtrip");
  try {
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 1,
      similarity: 0.72,
      decision: "same",
      confidence_band: "mid-band",
    });
    const got = readCached(wiki, "sha256:a", "sha256:b");
    assert.ok(got);
    assert.equal(got.tier, 1);
    assert.equal(got.similarity, 0.72);
    assert.equal(got.decision, "same");
    assert.equal(got.confidence_band, "mid-band");
    assert.ok(typeof got.cached_at === "string");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readCached: symmetric lookup after asymmetric write", () => {
  const wiki = tmpWiki("symmetric");
  try {
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 0,
      similarity: 0.9,
      decision: "same",
    });
    // Lookup with reversed argument order returns the same entry.
    const got = readCached(wiki, "sha256:b", "sha256:a");
    assert.ok(got);
    assert.equal(got.decision, "same");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readCached: corrupt JSON is treated as miss, not an exception", () => {
  const wiki = tmpWiki("corrupt");
  try {
    const dir = cacheDir(wiki);
    mkdirSync(dir, { recursive: true });
    const path = cacheEntryPath(wiki, "sha256:x", "sha256:y");
    writeFileSync(path, "{not valid json");
    const got = readCached(wiki, "sha256:x", "sha256:y");
    assert.equal(got, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readCached: file missing required fields is treated as miss", () => {
  const wiki = tmpWiki("missing-fields");
  try {
    const dir = cacheDir(wiki);
    mkdirSync(dir, { recursive: true });
    const path = cacheEntryPath(wiki, "sha256:x", "sha256:y");
    writeFileSync(path, JSON.stringify({ tier: 0 })); // missing similarity + decision
    const got = readCached(wiki, "sha256:x", "sha256:y");
    assert.equal(got, null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeCached: atomic — no leftover temp files after success", () => {
  const wiki = tmpWiki("atomic");
  try {
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 0,
      similarity: 1,
      decision: "same",
    });
    const files = readdirSync(cacheDir(wiki));
    // Exactly one .json file, no .tmp.* residue.
    const jsons = files.filter((f) => f.endsWith(".json"));
    const tmps = files.filter((f) => f.includes(".tmp."));
    assert.equal(jsons.length, 1);
    assert.equal(tmps.length, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("clearCache: removes every .json, returns count", () => {
  const wiki = tmpWiki("clear");
  try {
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 0,
      similarity: 1,
      decision: "same",
    });
    writeCached(wiki, "sha256:c", "sha256:d", {
      tier: 0,
      similarity: 0.1,
      decision: "different",
    });
    assert.equal(cacheSize(wiki), 2);
    const removed = clearCache(wiki);
    assert.equal(removed, 2);
    assert.equal(cacheSize(wiki), 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("clearCache: no-op on missing directory", () => {
  const wiki = tmpWiki("no-cache");
  try {
    // Never called writeCached so the cache dir doesn't exist.
    const removed = clearCache(wiki);
    assert.equal(removed, 0);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeCached: later write overwrites earlier entry for same pair", () => {
  const wiki = tmpWiki("overwrite");
  try {
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 0,
      similarity: 0.1,
      decision: "different",
    });
    writeCached(wiki, "sha256:a", "sha256:b", {
      tier: 1,
      similarity: 0.95,
      decision: "same",
    });
    assert.equal(cacheSize(wiki), 1);
    const got = readCached(wiki, "sha256:a", "sha256:b");
    assert.equal(got.tier, 1);
    assert.equal(got.decision, "same");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
