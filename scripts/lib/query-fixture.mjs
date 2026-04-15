// query-fixture.mjs — a fixed, representative query distribution
// the convergence loop uses to measure routing cost. Stored in the
// skill (NOT in user wikis) so the metric is corpus-agnostic and
// the same metric can be used to compare structural alternatives.
//
// Each query is a bag of activation keywords + tags the router
// would see in the real skill. The metric simulates one lookup
// pass at the wiki root: compute the activated set of entries[],
// follow the activated subcategory index.md files one level down,
// and sum the bytes of every file traversed (indices + leaves).
// Lower total bytes across all queries = better structure.
//
// The 10 queries below exercise different operation tags commonly
// seen in the skill's documentation: rebuild, build, extend,
// layout-mode reasoning, history/audit, validation, join, and a
// couple of "general how do I" questions. They deliberately span
// the tags the guide emits so both a flat-root wiki and a nested
// wiki will find matches.

export const REPRESENTATIVE_QUERIES = Object.freeze([
  {
    id: "q-rebuild-basic",
    activation_keywords: ["rebuild", "optimize", "structure"],
    tags: ["rebuild", "operation"],
  },
  {
    id: "q-build-from-source",
    activation_keywords: ["build", "source", "ingest"],
    tags: ["build", "operation"],
  },
  {
    id: "q-extend-new-entries",
    activation_keywords: ["extend", "add", "new", "entries"],
    tags: ["extend", "operation"],
  },
  {
    id: "q-layout-mode-reasoning",
    activation_keywords: ["layout", "sibling", "in-place", "hosted", "mode"],
    tags: ["layout"],
  },
  {
    id: "q-history-audit",
    activation_keywords: ["history", "log", "commit", "audit", "blame"],
    tags: ["history", "git"],
  },
  {
    id: "q-validate-fix",
    activation_keywords: ["validate", "fix", "invariant", "broken"],
    tags: ["validation", "fix"],
  },
  {
    id: "q-join-wikis",
    activation_keywords: ["join", "merge", "wikis"],
    tags: ["join"],
  },
  {
    id: "q-rollback-to",
    activation_keywords: ["rollback", "restore", "previous"],
    tags: ["rollback"],
  },
  {
    id: "q-tiered-ai",
    activation_keywords: ["tiered", "similarity", "embeddings", "claude"],
    tags: ["tiered", "ai"],
  },
  {
    id: "q-scale-large",
    activation_keywords: ["scale", "large", "corpus", "ten", "thousand"],
    tags: ["scale", "performance"],
  },
]);
