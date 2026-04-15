# Changelog

All notable changes to `skill-llm-wiki` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-04-15

Engine refinements closing three v0.4.0 loose ends. No substrate change; the output shape of `build` / `rebuild` is byte-identical to v0.4.0. The observable difference is cycle count (fewer exit-7 round trips), Tier 1 load count (lazy on all cycles when the similarity cache is warm), and — importantly — a **bug fix** for partial multi-cluster application in the convergence loop.

### Fixed

- **Multi-NEST per iteration** in `scripts/lib/operators.mjs::tryClusterNestIteration`. Previously the convergence loop applied at most one NEST per iteration and returned, forcing N iterations for N NEST applications. This caused the `web-frameworks/{backend,frontend}` orphan bug observed in the v0.4.0 novel-corpus validation: the skill proposed both subcategories in one `propose_structure` response, but only `backend/` applied before the next iteration re-asked on the re-shaped state where the 2-leaf `frontend/` was now orphaned. The fix greedily selects non-conflicting candidates (disjoint member sets) and applies them all in the same iteration with per-pick rollback + metric gating. Same-parent picks are safe because `snapshotForRollback` captures the current parent index content at apply time, so NEST #2's rollback preserves NEST #1's effects. Synthetic `nest-convergence-e2e` test now completes in 1 iteration instead of 2 on its 2-cluster corpus.
- **Tier 1 lazy load now covers all cycles**, not just terminal ones. `scripts/lib/tiered.mjs::decide()` previously called `ensureTier1(wikiRoot)` eagerly before the similarity cache check in the Tier 0 → Tier 1 escalation branch. The call was pure overhead on cache hits because `embed()`'s `existsSync(cachePath)` short-circuit already handles cache hits without touching the loader. The eager call has been removed. Warm-cache resume cycles now skip the dynamic `import("@xenova/transformers")` entirely, shaving ~1-2 seconds per cycle (and ~30s on a cold HuggingFace cache first-ever build).
- **Stale-candidate audit log** hook wiring is now reachable via the multi-NEST path. The v0.4.0 helper `dropStaleMathCandidate` had unit test coverage but was never called in live builds because single-NEST-per-iteration made every math candidate trivially fresh. With multi-NEST per iteration, applying one picked candidate can invalidate a later candidate's member set within the same iteration; the re-freshness check at the top of the apply loop now routes stale drops through `dropStaleMathCandidate` + `appendNestDecision`, producing observable `decision: rejected-stale, confidence_band: math-gated` entries in `decisions.yaml`.

### Added

- `scripts/lib/embeddings.mjs::_isTier1LoaderTouched` — test-only seam exposing whether the module-level `_tier1LoadPromise` has been initialized, enabling precise assertions that `tryLoadTier1` was not called.
- Two regression unit tests in `tests/unit/tiered.test.mjs`: `decide: similarity cache hit leaves the Tier 1 loader dormant` and `decide: decisive Tier 0 leaves the Tier 1 loader dormant`. Both assert the loader slot is untouched after calling `tiered.decide()` with a pre-populated cache.
- Multi-NEST iteration assertion in `tests/e2e/nest-convergence-e2e.test.mjs` — parses `decisions.yaml`'s metric trajectory, collects the iteration number of every applied NEST, and asserts they all share a single iteration number. Pre-v0.4.1 this would fail (iter-1 and iter-2); post-v0.4.1 it passes (all at iter-1).

### Changed

- `scripts/lib/operators.mjs::tryClusterNestIteration` apply loop rewritten. Sort proposals by source rank + affinity (unchanged), greedily pick non-conflicting ones (disjoint member sets), re-check `mathCandidateIsFresh` before each apply (for `source === "math"` picks), apply in sequence with per-pick rollback + metric gating, return `"applied"` iff any pick landed. One git commit per applied NEST (unchanged commit topology). Approximately +40 lines net.
- `scripts/lib/tiered.mjs` no longer imports `ensureTier1`. The Tier 1 escalation branch goes directly from the Tier 0 mid-band decision to `Promise.all([embed(a), embed(b)])`, relying on `embed()`'s cache-hit short-circuit and its own cache-miss error handling for the "Tier 1 can't load" case.

### Tests

- Suite grew from 458 to 460+ passing (+2 from the new loader-dormancy tests, +1 assertion on the existing nest-convergence-e2e test). 3 skipped (opt-in gates unchanged from v0.4.0). 0 fail.

### Performance (incremental v0.4.0 → v0.4.1)

- `guide/` rebuild: same tree, same byte count. Cycle count unchanged for the fully-converged `guide/` case because it's already at fixed point. For a from-scratch rebuild simulating the v0.4.0 workflow, multi-NEST per iteration would cut the 9-NEST → 9-iteration cadence to ~4-5 iterations (observable on fresh corpora, e.g., the novel-corpus test).
- `nest-convergence-e2e` synthetic corpus: iteration count dropped from 2 to 1 NEST iterations (both applied NESTs now land together).
- Tier 1 model loads per build (warm-cache resume path): all cycles skip, not just terminal ones. Incremental ~3-5s wall-clock saving per build vs v0.4.0.

### Known remaining gaps (unchanged from v0.4.0)

- Stale-candidate audit log path is still rare in practice because the greedy disjoint-members selection usually prevents stale candidates from forming. It IS observable when a specific partial-overlap scenario occurs (a Tier 2 proposal's member set overlaps with a math proposal's member set in a way the greedy rule doesn't catch). Not a new issue — just a honest note.
- Novel-corpus validation of the multi-NEST fix on the actual `skill-code-review/reviewers/` + `overlays/` corpus (where v0.4.0 observed the `frontend/` orphan bug) is deferred. The synthetic nest-convergence-e2e test confirms multi-NEST works; live novel-corpus verification is the main session's call.

## [0.4.0] — 2026-04-15

Major substrate change: the routing procedure is now **semantic**, parent indices no longer aggregate `activation_defaults`, Tier 1 embeddings and Tier 2 sub-agent dispatch are required and real, and the cluster detector drives an applying NEST operator with a quality-metric gate. Ships with a runtime dependency preflight so fresh installs surface missing deps gracefully instead of crashing on an `ERR_MODULE_NOT_FOUND`.

### Added

- **Semantic routing procedure** in `SKILL.md`. Claude routes into `guide/` by reading each entry's `focus` string and making a relevance decision semantically, not by keyword/tag intersection. No AND-filter on subcategory descent. Leaf-level `activation` blocks are kept as optional hint data, not routing gates.
- **Required Tier 1 embeddings** via `@xenova/transformers` (MiniLM-L6-v2). Previously optional. Model is downloaded to HuggingFace cache on first use; subsequent builds hit the disk cache.
- **Real Tier 2 sub-agent dispatch** via the `exit-7` handshake. The CLI writes pending request files to `<wiki>/.work/tier2/pending-<batch-id>.json` and exits with code 7 (`NEEDS_TIER2`). The wiki-runner (Claude at session time) services each request either inline (batches ≤ 50) or by fanning out to per-decision sub-agents, writes responses to `<wiki>/.work/tier2/responses-<batch-id>.json`, and re-invokes the CLI. The CLI resumes from the last committed iteration.
- **`propose_structure` Tier 2 kind** for whole-directory structural planning. Fires at each directory level during operator-convergence.
- **Applying NEST operator** with cluster detector. Detects candidate clusters via a multi-signal affinity matrix (TF-IDF + MiniLM embeddings + tag Jaccard + activation-keyword Jaccard), picks the best threshold adaptively, proposes subcategories via Tier 2, applies via the applying NEST operator, and gates each application on a `routing_cost` quality metric. Rolls back applications that regress the metric beyond a 5% tolerance band for Tier 2-proposed clusters.
- **Dependency preflight** (`scripts/lib/preflight.mjs::preflightDependencies`). First CLI invocation verifies `gray-matter` and `@xenova/transformers` are resolvable. Missing + interactive → prompt + offer `npm install`. Missing + non-interactive → auto-install. Failed install → exit 8 (`DEPS_MISSING`) with a user-facing Case E message in `guide/ux/preflight.md`.
- **Exit code 8** (`DEPS_MISSING`) added to the CLI exit code summary in `guide/cli.md`.
- **Agent delegation contract** in `SKILL.md` — every wiki operation runs in a dedicated wiki-runner sub-agent, not inline in the main session. Documents inline-servicing vs fan-out policy for Tier 2 handling.
- **Skip-`propose_structure`-on-≤-2-member optimization** in the convergence loop. Subcategories with 2 or fewer members can't be further subdivided (below `MIN_TIER2_CLUSTER_SIZE`), so the "keep-flat sanity check" round-trip is skipped.
- **Stale-candidate invalidation**: math-proposed NEST candidates whose members have moved in a prior iteration are filtered before emission, avoiding wasted Tier 2 round-trips.
- **`LLM_WIKI_TIER1_DEBUG=1`** diagnostic environment variable. Prints breadcrumbs to stderr when the Tier 1 model loads or when a fresh embedding is computed. Permanent debug seam for triaging slow builds.
- **`gray-matter`** as a runtime dependency for parsing authored frontmatter in source files.
- **Skill build process tested on novel corpus** (`skill-code-review/reviewers/` + `overlays/`, 46 files). Validated that the clustering + convergence loop generalizes beyond `guide/`.

### Changed

- **Parent indices no longer aggregate `activation_defaults`**. `scripts/lib/indices.mjs::rebuildIndex` now writes only `id/file/type/focus/tags` per entry record. The `activation` field on leaves is preserved but treated as hint data, not routing rules. This change shrinks the root index by ~60% on the `guide/` corpus.
- **Skill's own operational reference was migrated from flat to nested**. The previously hand-authored flat `guide/` folder was rebuilt via the skill itself into an 8-subcategory nested structure (basics, correctness, history, isolation, layout, operations, substrate, ux), with the skill's CLI as a root sibling. This is both a compression win (~24% smaller on-disk) and a dogfooding artifact — the skill produces the same shape for its own reference that it produces for user corpora.
- **methodology.md rewritten** to describe the semantic routing substrate, removing all references to `activation_defaults` aggregation, AND-filter narrowing, and literal keyword-based routing.
- **`scripts/cli.mjs` restructured** to use dynamic `import()` for skill-internal modules inside `main()`. This was necessary because the dependency preflight must run before any skill module that depends on `gray-matter` is statically imported; ESM hoists static imports past top-level code. The pre-import block uses only Node built-ins.
- **`SKILL.md` description field** is now generic (references `guide/`, not a version-specific path).
- **Convergence loop** batches `propose_structure` requests across all directories per iteration instead of short-circuiting on the first parked request.
- **Tier 1 lazy load**: terminal convergence cycles (after cluster-detect has converged) skip the model load entirely because all needed embeddings are cache-hits.

### Removed

- **`activation_defaults` aggregation**. Parent indices no longer carry synthesized union fields. The `activation_defaults` frontmatter field is still accepted on authored source indices for backward compatibility but is not synthesized on output.
- **Tier 1 "optional install" flow**. `@xenova/transformers` is required; there's no install prompt. Missing-dependency handling is routed through the new `preflightDependencies` path.
- **The AND-filter gate** on subcategory descent in the routing procedure. Claude decides descent semantically based on the subcategory's `focus`, not a tag intersection.

### Fixed

- Deterministic commit SHA reproducibility preserved across all engine changes.
- Leaves inherit authored `activation`, `covers`, `tags`, `focus`, and `shared_covers` via `gray-matter` parsing of source frontmatter.
- Build resume support for operations with Tier 2 exit-7 handshake (idempotent ingest via hash comparison + INT-03 relaxation for incomplete-build targets).
- Filename convention for leaves under subcategories (no more `<parent>-<leaf>.md` prefix).

### Session statistics

The session produced these cumulative gains, measured across six iterations on the `guide/` corpus (23 leaves) and one iteration on a novel corpus (`skill-code-review/reviewers/` + `overlays/`, 46 leaves):

| Metric | v0.3.x baseline | v0.4.0 |
|---|---:|---:|
| Routing read cost (strict) | 52,337 B | 43,602 B (−17%) |
| On-disk wiki size (`guide/`) | ~125 KB | ~95 KB (−24%) |
| Tier 2 cycles per build | 10 | 8 (−20%) |
| Tier 2 requests per build | ~20 | 16-17 (−15%) |
| Tier 1 model loads | per-cycle | lazy (terminal cycles skip) |
| Test suite | 374 pass | 458 pass |

## [0.3.1] — Pre-session baseline

See git log for changes up to commit `d406628`. This changelog starts with the v0.4.0 semantic-routing substrate work.
