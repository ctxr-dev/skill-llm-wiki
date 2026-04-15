// similarity-cache.mjs — pairwise memoisation of tiered similarity
// decisions. Keyed by the sorted pair of content hashes so (a,b) and
// (b,a) resolve to the same entry. Invalidated implicitly when either
// entry's hash changes — the key simply doesn't match anymore.
//
// Cache entries are JSON files under `<wiki>/.llmwiki/similarity-cache/`.
// One file per pair. The filename is derived from the sorted hashes
// with sha256 collapsing to keep the name short and filesystem-safe.
// The payload carries the tier, similarity, decision, and the tier
// at which the decision was resolved — tests read it back to verify
// caching prevented redundant work.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function cacheDir(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "similarity-cache");
}

// Deterministic filename for a hash pair. Hash prefixes are sorted
// so the lookup is symmetric regardless of argument order.
export function cacheKey(hashA, hashB) {
  if (!hashA || !hashB) {
    throw new Error("similarity-cache: both hashes must be non-empty strings");
  }
  const [first, second] = hashA <= hashB ? [hashA, hashB] : [hashB, hashA];
  // sha256 the concatenation so the resulting key is a bounded-
  // length filesystem-safe string. Truncate to 32 hex chars for
  // readability — 128 bits of discriminant is more than enough.
  return createHash("sha256")
    .update(first + "\0" + second)
    .digest("hex")
    .slice(0, 32);
}

export function cacheEntryPath(wikiRoot, hashA, hashB) {
  return join(cacheDir(wikiRoot), cacheKey(hashA, hashB) + ".json");
}

// Read a cached decision. Returns null on miss or malformed file.
// Does NOT throw on parse errors — a corrupt cache entry is treated
// as a miss, so the caller re-computes and overwrites it.
export function readCached(wikiRoot, hashA, hashB) {
  const path = cacheEntryPath(wikiRoot, hashA, hashB);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    // Minimal sanity check: must have tier, similarity, decision.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.tier !== "number" ||
      typeof parsed.similarity !== "number" ||
      typeof parsed.decision !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Write a decision to the cache atomically (temp-file + rename).
export function writeCached(wikiRoot, hashA, hashB, decision) {
  if (!decision || typeof decision !== "object") {
    throw new Error("similarity-cache: decision must be an object");
  }
  const dir = cacheDir(wikiRoot);
  mkdirSync(dir, { recursive: true });
  const path = cacheEntryPath(wikiRoot, hashA, hashB);
  const payload = JSON.stringify(
    {
      tier: decision.tier,
      similarity: decision.similarity,
      decision: decision.decision,
      confidence_band: decision.confidence_band ?? null,
      cached_at: new Date().toISOString(),
    },
    null,
    0,
  );
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, path);
}

// Remove every cache file. Used by tests and by `startCorpus` via
// the orchestrator when the corpus changes materially. Safe to call
// when the cache dir doesn't exist.
export function clearCache(wikiRoot) {
  const dir = cacheDir(wikiRoot);
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      rmSync(join(dir, name), { force: true });
      count++;
    } catch {
      /* best-effort */
    }
  }
  return count;
}

// Count cached entries — convenience for tests and metrics.
export function cacheSize(wikiRoot) {
  const dir = cacheDir(wikiRoot);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json")) n++;
  }
  return n;
}
