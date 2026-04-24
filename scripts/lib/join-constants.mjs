// join-constants.mjs — the minimal shared constants between the
// runtime pipeline (`join.mjs`) and the intent layer
// (`intent.mjs`).
//
// Kept in its own file so that importing the policy allow-list
// at intent time does NOT drag in the full join pipeline module
// (ingest + convergence + indices + validation + every transitive
// dependency). CLI paths that never run a join — build, rebuild,
// fix, validate, rollback, init, heal, where — would otherwise
// pay the cold-start cost of loading `join.mjs` and its
// dependency graph on every invocation just to resolve the
// `--id-collision` flag. Keeping this module dependency-light
// (zero imports, plain string constants) keeps every non-join
// CLI startup path fast.

export const VALID_COLLISION_POLICIES = Object.freeze([
  "namespace",
  "merge",
  "ask",
]);

export const DEFAULT_COLLISION_POLICY = "namespace";
