// similarity-cache.mjs — pairwise memoisation of tiered similarity
// decisions. Keyed by the sorted pair of content hashes so (a,b) and
// (b,a) resolve to the same entry. Invalidated implicitly when either
// entry's hash changes — the key simply doesn't match anymore.
//
// Cache entries are JSON files under
// `<wiki>/.llmwiki/similarity-cache/<shard>/<rest>.json`, where
// `<shard>` is the first 2 hex chars of the cache key and `<rest>`
// is the remaining 30 chars. 256 shards keep each shard dir's
// inode count ~cacheSize/256, so a 178k-pair corpus has ~700
// entries per shard instead of 178k in a single flat directory.
// APFS/ext4/ZFS directory lookups degrade with entry count once
// the VFS dirent cache overflows (~10k on typical kernels), so
// sharding turns the per-lookup cost from O(log N)-with-large-N
// back into O(log N)-with-small-N. Same pattern as `.git/objects`.
//
// The payload carries the tier, similarity, decision, and the tier
// at which the decision was resolved — tests read it back to verify
// caching prevented redundant work.
//
// Pre-sharding caches: the old flat layout (`<cacheDir>/<key>.json`)
// is NOT auto-migrated. This is a pure perf cache — if a user
// upgrades and the cache invalidates, the next build recomputes
// everything once and fills the sharded layout. No user data at
// stake; nothing to preserve.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function cacheDir(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "similarity-cache");
}

// Deterministic filename stem for a hash pair. Hash prefixes are
// sorted so the lookup is symmetric regardless of argument order.
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

// Number of hex chars taken from the start of the cache key as the
// shard directory name. 2 → 256 shards, which keeps every shard dir
// below 1k entries for workloads up to ~256k pairs. Changing this
// constant invalidates the cache layout for existing wikis, but
// since similarity-cache is purely an optimisation the next build
// simply rebuilds the populated shards.
export const CACHE_SHARD_PREFIX_LEN = 2;

export function cacheEntryPath(wikiRoot, hashA, hashB) {
  const key = cacheKey(hashA, hashB);
  const shard = key.slice(0, CACHE_SHARD_PREFIX_LEN);
  const rest = key.slice(CACHE_SHARD_PREFIX_LEN);
  return join(cacheDir(wikiRoot), shard, rest + ".json");
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
// The shard subdirectory is created on demand, so callers don't
// need to pre-create it. `mkdirSync({ recursive: true })` is
// idempotent and cheap on hot shards (kernel caches the parent's
// dentry).
export function writeCached(wikiRoot, hashA, hashB, decision) {
  if (!decision || typeof decision !== "object") {
    throw new Error("similarity-cache: decision must be an object");
  }
  const path = cacheEntryPath(wikiRoot, hashA, hashB);
  // `dirname(path)` would also work, but cacheEntryPath already
  // encodes the shard structure, so synthesising the shard dir
  // from the same slice avoids parsing the path back out.
  const key = cacheKey(hashA, hashB);
  const shard = key.slice(0, CACHE_SHARD_PREFIX_LEN);
  mkdirSync(join(cacheDir(wikiRoot), shard), { recursive: true });
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
// when the cache dir doesn't exist. Walks every shard directory
// plus the top-level (tolerates pre-sharding flat caches from
// before the layout change — they get cleared on first clear-call).
export function clearCache(wikiRoot) {
  const dir = cacheDir(wikiRoot);
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const name of readdirSync(dir)) {
    const entryPath = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      // Shard subdirectory — clear every .json beneath it, then
      // the directory itself. Best-effort; a shard that's locked
      // or mid-write doesn't abort the whole clear.
      try {
        for (const entry of readdirSync(entryPath)) {
          if (!entry.endsWith(".json")) continue;
          try {
            rmSync(join(entryPath, entry), { force: true });
            count++;
          } catch {
            /* best-effort */
          }
        }
        rmSync(entryPath, { force: true, recursive: true });
      } catch {
        /* best-effort */
      }
    } else if (name.endsWith(".json")) {
      // Pre-sharding flat entry — clear in place.
      try {
        rmSync(entryPath, { force: true });
        count++;
      } catch {
        /* best-effort */
      }
    }
  }
  return count;
}

// Count cached entries — convenience for tests and metrics. Walks
// every shard directory; also counts any pre-sharding flat entries
// if they exist (so a pre-upgrade cache still reports meaningful
// size until the user runs a build that regenerates).
export function cacheSize(wikiRoot) {
  const dir = cacheDir(wikiRoot);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const entryPath = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      try {
        for (const entry of readdirSync(entryPath)) {
          if (entry.endsWith(".json")) n++;
        }
      } catch {
        /* best-effort */
      }
    } else if (name.endsWith(".json")) {
      n++; // pre-sharding flat entry
    }
  }
  return n;
}
