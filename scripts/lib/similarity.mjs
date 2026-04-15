// similarity.mjs — Tier 0 of the tiered AI ladder (methodology §8.5).
//
// Pure TF-IDF + cosine similarity over entry frontmatters. No external
// dependencies. Deterministic. Cheap enough to run on every pairwise
// check without concern. The ladder escalates to Tier 1 (local
// embeddings) only when Tier 0's confidence is mid-band.
//
// Scope restriction: this module operates on frontmatter fields only
// (focus + covers[] + tags + id). Bodies are never touched — that is
// the whole point of Phase 5's chunk iterator, and Phase 6 honours it
// at the substrate level.
//
// Thresholds are tunable via `<wiki>/.llmwiki/config.yaml` in
// future; Phase 6 ships the defaults as exported constants so tests
// and `tiered.mjs` can reference them without drift.

export const TIER0_DECISIVE_SAME = 0.85;
export const TIER0_DECISIVE_DIFFERENT = 0.30;

// Small embedded English stopword list — intentionally narrow. A
// fuller list tends to over-aggressive filtering and hides real
// content signals in short covers[] strings. The covers field uses
// terse technical phrases; dropping articles and connectives is
// enough.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "has", "have", "he", "her", "his", "i", "in", "is", "it", "its",
  "of", "on", "or", "she", "that", "the", "their", "they", "this",
  "to", "was", "we", "were", "will", "with",
]);

// Tokeniser: lowercase, strip punctuation, split on non-word runs,
// filter stopwords and short tokens. Keeps Unicode letters so
// non-ASCII frontmatters are first-class. Numbers are kept because
// version suffixes like "v1" / "v2" are often meaningful signals.
export function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  // `\p{L}` = any Unicode letter; `\p{N}` = any Unicode number.
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .filter((t) => !STOPWORDS.has(t));
  return tokens;
}

// Build a tf-vector from a token list. Plain term-frequency map.
function tf(tokens) {
  const v = new Map();
  for (const t of tokens) v.set(t, (v.get(t) ?? 0) + 1);
  return v;
}

// Compute idf weights from a corpus of token lists using the
// scikit-learn smoothed form: `log((1 + N) / (1 + df)) + 1`. This
// keeps ubiquitous terms with lower weight than rare terms while
// never going negative and behaving sensibly at small N.
//
// Round-trip values (verified):
//   N=1, df=1 → log(2/2)+1 = 1.000
//   N=2, df=2 → log(3/3)+1 = 1.000
//   N=2, df=1 → log(3/2)+1 ≈ 1.405
//   N=3, df=3 → log(4/4)+1 = 1.000
//   N=3, df=1 → log(4/2)+1 ≈ 1.693
//
// Notice that under this formula terms shared across ALL entries
// get a BASELINE weight of 1.0, while rarer terms get larger
// weights. Cosine then correctly down-weights shared-everything
// terms relative to distinguishing ones — the behaviour the
// "rare terms distinguish better" intuition implies.
export function computeIdf(tokenLists) {
  const df = new Map();
  for (const tokens of tokenLists) {
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const N = tokenLists.length;
  const idf = new Map();
  for (const [t, dfT] of df) {
    idf.set(t, Math.log((1 + N) / (1 + dfT)) + 1);
  }
  return idf;
}

// Precompute a directory-wide IDF model once per comparison pool.
// Callers that iterate N² pairs (detectMerge) reuse the returned
// { idfMap, tokenLists, texts } instead of recomputing IDF for
// every pair — the difference between O(N³) and O(N²) work.
export function buildComparisonModel(entries) {
  const texts = entries.map((e) => entryText(e));
  const tokenLists = texts.map((t) => tokenize(t));
  const idfMap = computeIdf(tokenLists);
  return { texts, tokenLists, idfMap };
}

// Convert a tf map into a tf-idf vector given an idf map. Terms
// absent from idf (i.e., not present in the corpus) contribute 0.
export function tfidfVector(tokens, idfMap) {
  const tfMap = tf(tokens);
  const out = new Map();
  for (const [term, freq] of tfMap) {
    const idf = idfMap.get(term);
    if (idf === undefined) continue;
    out.set(term, freq * idf);
  }
  return out;
}

// Cosine similarity between two sparse tf-idf vectors. Returns a
// value in [0, 1] for non-negative inputs. Handles zero vectors by
// returning 0 (rather than NaN).
export function cosine(a, b) {
  if (!a || !b) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  // Iterate over the smaller map for the dot product; every entry
  // in the larger map contributes to its norm.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [term, weight] of small) {
    const other = large.get(term) ?? 0;
    dot += weight * other;
  }
  for (const w of a.values()) normA += w * w;
  for (const w of b.values()) normB += w * w;
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// Build the text we compare for a single entry. The methodology
// specifies frontmatter fields only: focus + covers[] + tags +
// domains. We join them into a single text for tokenisation, with
// doubled weight on focus (repeat it twice in the concatenation).
export function entryText(data) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  // Focus is the most semantically concentrated field; double it.
  if (typeof data.focus === "string") {
    parts.push(data.focus, data.focus);
  }
  if (Array.isArray(data.covers)) {
    parts.push(data.covers.filter((c) => typeof c === "string").join(" "));
  }
  if (Array.isArray(data.tags)) {
    parts.push(data.tags.filter((t) => typeof t === "string").join(" "));
  }
  if (Array.isArray(data.domains)) {
    parts.push(data.domains.filter((d) => typeof d === "string").join(" "));
  }
  return parts.join(" ").trim();
}

// Compare two entries via Tier 0: returns
//   { tier: 0, similarity, decision, confidence_band, reason }
//
// `decision` is one of "same" / "different" / "escalate" /
// "undecidable". "undecidable" is returned when either entry's
// frontmatter is empty — the caller should NOT escalate this to
// Tier 1/2 because an empty-text pair embeds to whatever the model
// emits for empty input, which collapses to near-1.0 cosine and
// would cause spurious MERGE decisions. Callers must treat
// "undecidable" as a hard stop for this pair.
//
// `corpusContext` is a list of other entry data objects providing
// the IDF statistics. For sibling-comparison use cases the context
// is the full set of siblings. `precomputedModel` is the optional
// result of `buildComparisonModel(corpusContext)` — pass it to
// reuse IDF/tokens across many pairs (O(N²) vs O(N³)).
export function compareEntries(
  a,
  b,
  corpusContext = null,
  {
    sameThreshold = TIER0_DECISIVE_SAME,
    differentThreshold = TIER0_DECISIVE_DIFFERENT,
    precomputedModel = null,
  } = {},
) {
  const textA = entryText(a);
  const textB = entryText(b);
  if (textA === "" || textB === "") {
    return {
      tier: 0,
      similarity: 0,
      decision: "undecidable",
      confidence_band: "insufficient-text",
      reason: "one or both entries had empty frontmatter text",
    };
  }
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  let idfMap;
  if (precomputedModel) {
    idfMap = precomputedModel.idfMap;
  } else {
    const contextList =
      corpusContext && corpusContext.length > 0
        ? corpusContext.map((e) => tokenize(entryText(e)))
        : [tokensA, tokensB];
    idfMap = computeIdf(contextList);
  }
  const vecA = tfidfVector(tokensA, idfMap);
  const vecB = tfidfVector(tokensB, idfMap);
  const sim = cosine(vecA, vecB);
  let decision;
  let band;
  if (sim >= sameThreshold) {
    decision = "same";
    band = "decisive-same";
  } else if (sim <= differentThreshold) {
    decision = "different";
    band = "decisive-different";
  } else {
    decision = "escalate";
    band = "mid-band";
  }
  return {
    tier: 0,
    similarity: sim,
    decision,
    confidence_band: band,
    reason: null,
  };
}
