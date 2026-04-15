// similarity.test.mjs — Tier 0 TF-IDF + cosine + compareEntries.
//
// Edge cases covered:
//   - Empty / whitespace-only text
//   - Unicode letters / CJK tokens (non-ASCII path)
//   - Stopword filtering
//   - Short tokens filtered
//   - Zero vectors
//   - Identical vectors
//   - Orthogonal vectors
//   - High-overlap pair → SAME
//   - Low-overlap pair → DIFFERENT
//   - Mid-band pair → ESCALATE
//   - Doubled-focus weighting
//   - Corpus-context isolation (small vs global)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIER0_DECISIVE_DIFFERENT,
  TIER0_DECISIVE_SAME,
  buildComparisonModel,
  compareEntries,
  computeIdf,
  cosine,
  entryText,
  tfidfVector,
  tokenize,
} from "../../scripts/lib/similarity.mjs";

// ── tokenize ────────────────────────────────────────────────────────

test("tokenize: empty and non-string inputs return []", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
  assert.deepEqual(tokenize(42), []);
});

test("tokenize: lowercases and splits on non-word characters", () => {
  assert.deepEqual(
    tokenize("React hooks: useEffect and useMemo"),
    ["react", "hooks", "useeffect", "usememo"],
  );
});

test("tokenize: drops stopwords", () => {
  assert.deepEqual(
    tokenize("the cat is on the mat"),
    ["cat", "mat"],
  );
});

test("tokenize: drops 1-character tokens", () => {
  assert.deepEqual(tokenize("a b cd e fg"), ["cd", "fg"]);
});

test("tokenize: keeps Unicode letters (CJK, accented)", () => {
  const tokens = tokenize("日本語 Prisma migräne café");
  // `日本語` is one Unicode letter run; the accented words are kept.
  assert.ok(tokens.includes("日本語"));
  assert.ok(tokens.includes("prisma"));
  assert.ok(tokens.includes("migräne"));
  assert.ok(tokens.includes("café"));
});

test("tokenize: keeps numeric suffixes (v1, v2)", () => {
  assert.deepEqual(tokenize("api v1 and v2 endpoints"), [
    "api", "v1", "v2", "endpoints",
  ]);
});

// ── computeIdf ──────────────────────────────────────────────────────

test("computeIdf: N=1, df=1 → idf = 1.0 (scikit-learn smoothed form)", () => {
  const idf = computeIdf([["solo", "entry"]]);
  // log((1+1)/(1+1)) + 1 = log(1) + 1 = 1
  for (const v of idf.values()) {
    assert.ok(Math.abs(v - 1) < 1e-12, `expected ~1, got ${v}`);
  }
});

test("computeIdf: N=2, df=2 → shared term idf = 1.0", () => {
  // Critical case for MERGE on a sibling pair: both leaves share
  // the common vocabulary. log((1+2)/(1+2)) + 1 = 1.0 baseline.
  const idf = computeIdf([
    ["shared", "a-only"],
    ["shared", "b-only"],
  ]);
  assert.ok(Math.abs(idf.get("shared") - 1) < 1e-12);
  // Singleton terms: log((1+2)/(1+1)) + 1 = log(1.5) + 1 ≈ 1.405
  assert.ok(idf.get("a-only") > idf.get("shared"));
  assert.ok(idf.get("b-only") > idf.get("shared"));
});

test("computeIdf: ubiquitous term has lower idf than rare term (N=3)", () => {
  const idf = computeIdf([
    ["ubiq", "r1"],
    ["ubiq", "r2"],
    ["ubiq", "r3"],
  ]);
  // log((1+3)/(1+3)) + 1 = 1.0 for ubiquitous
  // log((1+3)/(1+1)) + 1 = log(2) + 1 ≈ 1.693 for rare
  assert.ok(Math.abs(idf.get("ubiq") - 1) < 1e-12);
  assert.ok(idf.get("r1") > idf.get("ubiq"));
});

test("computeIdf: term in every document has lowest idf", () => {
  const docs = [
    ["react", "hooks"],
    ["react", "components"],
    ["react", "context"],
  ];
  const idf = computeIdf(docs);
  // Under scikit-learn smoothing:
  //   N=3, df(react)=3 → log((1+3)/(1+3))+1 = 1.0
  //   df(hooks)=1    → log((1+3)/(1+1))+1 = log(2)+1 ≈ 1.693
  const reactIdf = idf.get("react");
  const hooksIdf = idf.get("hooks");
  assert.ok(reactIdf < hooksIdf, "ubiquitous terms must have lower idf");
});

test("computeIdf: empty corpus returns empty map", () => {
  const idf = computeIdf([]);
  assert.equal(idf.size, 0);
});

// ── tfidfVector ─────────────────────────────────────────────────────

test("tfidfVector: ignores terms not in the idf map", () => {
  const idf = new Map([["react", 1.0]]);
  const vec = tfidfVector(["react", "vue"], idf);
  assert.equal(vec.size, 1);
  assert.equal(vec.get("react"), 1.0);
});

test("tfidfVector: multiplies tf by idf", () => {
  const idf = new Map([["hooks", 2.0]]);
  const vec = tfidfVector(["hooks", "hooks", "hooks"], idf);
  assert.equal(vec.get("hooks"), 6.0);
});

// ── cosine ──────────────────────────────────────────────────────────

test("cosine: identical vectors → 1 (within float epsilon)", () => {
  const v = new Map([["a", 2], ["b", 3]]);
  const result = cosine(v, v);
  assert.ok(Math.abs(result - 1) < 1e-9, `expected ~1, got ${result}`);
});

test("cosine: orthogonal vectors → 0", () => {
  const a = new Map([["x", 1]]);
  const b = new Map([["y", 1]]);
  assert.equal(cosine(a, b), 0);
});

test("cosine: zero vectors → 0 (not NaN)", () => {
  assert.equal(cosine(new Map(), new Map()), 0);
  assert.equal(cosine(new Map([["a", 1]]), new Map()), 0);
});

test("cosine: handles null / missing inputs gracefully", () => {
  assert.equal(cosine(null, null), 0);
  assert.equal(cosine(null, new Map([["a", 1]])), 0);
});

test("cosine: symmetric", () => {
  const a = new Map([["a", 1], ["b", 2]]);
  const b = new Map([["a", 2], ["b", 1]]);
  const ab = cosine(a, b);
  const ba = cosine(b, a);
  assert.equal(ab, ba);
});

test("cosine: high-overlap pair produces similarity ≥ 0.9", () => {
  const a = new Map([["react", 2], ["hooks", 3], ["state", 1]]);
  const b = new Map([["react", 2], ["hooks", 3], ["state", 1]]);
  assert.ok(cosine(a, b) >= 0.9);
});

// ── entryText ───────────────────────────────────────────────────────

test("entryText: returns empty string for missing data", () => {
  assert.equal(entryText(null), "");
  assert.equal(entryText(undefined), "");
  assert.equal(entryText({}), "");
});

test("entryText: focus is doubled for weighting", () => {
  const text = entryText({
    focus: "react hooks correctness",
    covers: ["useEffect rules"],
  });
  // Focus appears twice in the joined text.
  const occurrences = text.match(/react hooks correctness/g) ?? [];
  assert.equal(occurrences.length, 2);
});

test("entryText: concatenates covers, tags, and domains", () => {
  const text = entryText({
    focus: "focus-string",
    covers: ["cover-a", "cover-b"],
    tags: ["tag-x"],
    domains: ["domain-1"],
  });
  assert.ok(text.includes("focus-string"));
  assert.ok(text.includes("cover-a"));
  assert.ok(text.includes("cover-b"));
  assert.ok(text.includes("tag-x"));
  assert.ok(text.includes("domain-1"));
});

test("entryText: ignores non-string array elements", () => {
  const text = entryText({
    focus: "good",
    covers: ["valid", 42, null, { not: "a string" }],
  });
  assert.ok(text.includes("good"));
  assert.ok(text.includes("valid"));
  assert.ok(!text.includes("42"));
});

// ── compareEntries ──────────────────────────────────────────────────

const clonePrismaA = () => ({
  id: "prisma-migrations",
  focus: "prisma database schema migrations and seed workflows",
  covers: [
    "migrate dev",
    "migrate deploy",
    "seed commands",
    "schema.prisma file structure",
  ],
  tags: ["orm", "database", "prisma"],
});

const clonePrismaB = () => ({
  id: "prisma-schema",
  focus: "prisma database schema migrations and seed workflows",
  covers: [
    "migrate dev",
    "migrate deploy",
    "seed commands",
    "schema.prisma conventions",
  ],
  tags: ["orm", "database", "prisma"],
});

test("compareEntries: near-identical pair → decisive SAME", () => {
  const a = clonePrismaA();
  const b = clonePrismaB();
  const r = compareEntries(a, b, [a, b]);
  assert.equal(r.tier, 0);
  assert.equal(r.decision, "same");
  assert.equal(r.confidence_band, "decisive-same");
  assert.ok(r.similarity >= TIER0_DECISIVE_SAME);
});

test("compareEntries: completely unrelated pair → decisive DIFFERENT", () => {
  const a = {
    id: "prisma-migrations",
    focus: "prisma database schema migrations",
    covers: ["migrate dev", "migrate deploy"],
    tags: ["orm", "database"],
  };
  const b = {
    id: "react-hooks",
    focus: "react hook correctness rules",
    covers: ["useEffect dependency array", "useState immutability"],
    tags: ["react", "frontend"],
  };
  const r = compareEntries(a, b, [a, b]);
  assert.equal(r.tier, 0);
  assert.equal(r.decision, "different");
  assert.equal(r.confidence_band, "decisive-different");
  assert.ok(r.similarity <= TIER0_DECISIVE_DIFFERENT);
});

test("compareEntries: mid-band pair → escalate", () => {
  // Two entries that share some technical vocabulary but differ
  // in focus. Crafted to land in the 0.3-0.85 range when compared
  // against a larger corpus context so the idf doesn't give them
  // false similarity.
  const a = {
    id: "redis-caching",
    focus: "caching strategies with redis",
    covers: ["lru eviction", "cache stampede", "key prefixing"],
    tags: ["redis", "cache", "performance"],
  };
  const b = {
    id: "memcached-caching",
    focus: "caching strategies with memcached",
    covers: ["slab allocation", "cache stampede", "key prefixing"],
    tags: ["memcached", "cache", "performance"],
  };
  const context = [
    a,
    b,
    {
      id: "zebra",
      focus: "zebra stripes patterns in ecology",
      covers: ["melanin", "camouflage", "social signalling"],
      tags: ["biology", "zoology"],
    },
  ];
  const r = compareEntries(a, b, context);
  // Not asserting the exact value; the point is it should land in
  // the escalate band given the mixed overlap.
  assert.equal(r.tier, 0);
  assert.ok(
    r.similarity > TIER0_DECISIVE_DIFFERENT &&
      r.similarity < TIER0_DECISIVE_SAME,
    `mid-band similarity expected, got ${r.similarity}`,
  );
  assert.equal(r.decision, "escalate");
  assert.equal(r.confidence_band, "mid-band");
});

test("compareEntries: empty frontmatter text → undecidable (not escalate)", () => {
  // Empty-text pairs must return `undecidable`, not `escalate` —
  // a Tier 1 embedder would map both empty inputs to the same
  // zero-ish vector and produce a spurious near-1.0 similarity,
  // which would cause MERGE to fire on entries that share no
  // metadata. Instead we stop at Tier 0.
  const a = { id: "empty-a" };
  const b = { id: "empty-b" };
  const r = compareEntries(a, b, [a, b]);
  assert.equal(r.decision, "undecidable");
  assert.equal(r.confidence_band, "insufficient-text");
  assert.ok(r.reason);
});

test("compareEntries: custom thresholds are honoured", () => {
  const a = clonePrismaA();
  const b = clonePrismaB();
  // With a super-strict sameThreshold of 0.99, even the near-
  // identical pair should escalate.
  const strict = compareEntries(a, b, [a, b], { sameThreshold: 0.99 });
  assert.equal(strict.decision, "escalate");
});

test("compareEntries: symmetric for pair (a, b) and (b, a)", () => {
  const a = clonePrismaA();
  const b = clonePrismaB();
  const ab = compareEntries(a, b, [a, b]);
  const ba = compareEntries(b, a, [a, b]);
  assert.equal(ab.similarity, ba.similarity);
});

test("buildComparisonModel + precomputedModel shortcut match independent compare", () => {
  // Proves the O(N²) optimisation yields identical scores to the
  // naive per-pair path (which recomputes IDF every call).
  const a = clonePrismaA();
  const b = clonePrismaB();
  const c = {
    id: "react",
    focus: "react hooks correctness",
    covers: ["useEffect rules"],
    tags: ["react"],
  };
  const corpus = [a, b, c];
  const model = buildComparisonModel(corpus);
  const naive = compareEntries(a, b, corpus);
  const fast = compareEntries(a, b, null, { precomputedModel: model });
  assert.ok(Math.abs(naive.similarity - fast.similarity) < 1e-12);
  assert.equal(naive.decision, fast.decision);
});

test("compareEntries: CJK frontmatter does not collapse to 0", () => {
  const a = {
    id: "jp-a",
    focus: "日本語のタイトル キャッシング",
    covers: ["キャッシング 戦略"],
    tags: ["cache"],
  };
  const b = {
    id: "jp-b",
    focus: "日本語のタイトル キャッシング",
    covers: ["キャッシング 戦略"],
    tags: ["cache"],
  };
  const r = compareEntries(a, b, [a, b]);
  assert.equal(r.decision, "same");
});
