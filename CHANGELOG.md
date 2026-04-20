# Changelog

All notable changes to `skill-llm-wiki` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Cross-depth slug collision guard in `resolveNestSlug`.** The v1.0.0 collision resolver checked only the cluster's immediate parent directory, missing collisions with leaf ids or subdirectory basenames elsewhere in the tree. On real-world multi-branch wikis (first observed during a 596-leaf novel-corpus build in the consumer skill `skill-code-review`), Tier 2's `propose_structure` picked slug `event-patterns` for a cluster under `design-patterns-group/` — colliding with an existing leaf at `arch/event-patterns/index.md` (id: `event-patterns`) in a completely different branch. The parent-dir-only walk missed it; validation caught `DUP-ID` post-apply and forced a rollback. `collectForbiddenIds` now accepts an optional `wikiRoot` argument and, when provided, walks the entire tree to collect every live leaf id and non-hidden directory basename into the forbidden set. Dot-directories are skipped as a blanket rule (matching `scripts/lib/chunk.mjs::collectEntryPaths` discipline), covering both skill-owned internals (`.llmwiki/`, `.work/`) and user dotfiles (`.git/`, `.github/`, etc) without needing an allow-list. Per-file frontmatter is extracted via `readFrontmatterStreaming` from `chunk.mjs` so the collision pass reads bounded (≤ `MAX_FRONTMATTER_BYTES`) per file rather than the full body — important at the ~600-leaf scale. `resolveNestSlug` accepts `wikiRoot` as an optional third argument and passes it through; `operators.mjs::tryClusterNestIteration` now provides it. Legacy callers that don't pass `wikiRoot` continue to get the parent-dir-only behaviour, so the change is backward-compatible. See `tests/unit/nest-applier.test.mjs` for 6 new scenarios (cross-depth leaf id, cross-depth subdir basename, chain fallback, blanket-dot-dir skip, clean-tree no-op, same-depth regression). Fixes issue [#4](https://github.com/ctxr-dev/skill-llm-wiki/issues/4) bug 2.

### Tests

- 6 new scenarios in `tests/unit/nest-applier.test.mjs` for cross-depth collision, subdir-basename collision, `-group-N` chain fallback, `.llmwiki/` and `.work/` skip, clean-tree no-op, and same-depth regression guard. All pre-existing tests pass unchanged.

## [1.0.0] — 2026-04-16

First stable release. The semantic-routing substrate landed in v0.4.0, multi-NEST convergence landed in v0.4.1, and 1.0.0 closes the remaining sharp edge — a DUP-ID collision path discovered during the v0.4.1 deferred novel-corpus validation — plus the Windows CI parity gap. The v0.4.1 "Known remaining gaps" novel-corpus validation item is **resolved**: the combined `skill-code-review/reviewers/` + `overlays/` corpus (45 leaves) now builds end-to-end on the first try, `validate` returns 0 errors / 0 warnings, and multi-NEST applies atomically in a single convergence iteration. Semver commitments are now in effect: the six public operations (Build, Extend, Validate, Rebuild, Fix, Join), the CLI exit-code surface, the layout-mode contract, and the private-git history shape are stable and will not break in 1.x.

### Fixed

- **DUP-ID pre-apply slug collision resolver.** New `resolveNestSlug(slug, proposal)` helper in `scripts/lib/nest-applier.mjs`, wired into `scripts/lib/operators.mjs::tryClusterNestIteration` right before `applyNest`. When a proposed subcategory slug collides with a member leaf's id (the observed case: Tier 2's `propose_structure` picked slug=`security` for a cluster whose members included leaf id=`security`), with a non-member sibling leaf's id, or with an existing sibling subdirectory name, the resolver auto-suffixes deterministically (`<slug>-group`, then `<slug>-group-2`, `-group-3`, …) until the slug is non-colliding. Before this fix, the collision landed at `applyNest`, flowed through to validation, tripped `DUP-ID`, and triggered a full pipeline rollback to `pre-op/<id>` — forcing a manual recovery on any real corpus where Tier 2 naturally picked a category name matching one of its member files. The resolver pre-empts the entire rollback path; no user-visible change on collision-free builds. The rename is audited in `decisions.yaml` as `decision: slug-renamed` with the original slug, the resolved slug, and the reason, and — importantly — the audit entry is only written *after* `applyNest` succeeds and the metric gate accepts the NEST, so the log never records a rename for an op that was subsequently rolled back.
- **Length-overflow short-circuit** in `resolveNestSlug`. When a base slug is 58+ characters long, `${slug}-group` exceeds the 64-character `SLUG_RE` cap and every numeric-suffix candidate fails validation identically. The resolver now short-circuits the loop on the first `validateSlug(primary)` failure and returns the original slug, propagating the collision to `applyNest` for a clean error rather than spinning 98 no-op iterations.
- **Windows CI suite.** Six unit tests in `tests/unit/{git-security,git-env,tier2-protocol,default-sibling-naming,nest-applier}.test.mjs` were asserting against hardcoded POSIX path strings (`/tmp/fake-wiki/...`), which failed on `windows-latest` because Node's `path.join` returns `\tmp\...` on Windows. All such assertions now compose their expected paths via `path.join(os.tmpdir(), ...)` on both sides so the test is platform-independent. Test-only; no runtime behaviour change.

### Added

- **`"slug-renamed"` decision type** in `<wiki>/.llmwiki/decisions.yaml`. Audit-trail only, not a new exit code. Documented in the `decision-log.mjs` header comment and in `guide/substrate/tiered-ai.md`.
- **New unit tests** in `tests/unit/nest-applier.test.mjs` (8 additional): `resolveNestSlug` non-colliding pass-through, member-id collision, non-member sibling-id collision, existing-subdir collision, `-group` double-collision numeric fallback, invalid-slug pass-through (covering `null`/`undefined`/non-string inputs), parent-own-`index.md` skip coverage, length-overflow short-circuit, and an end-to-end `applyNest + resolveNestSlug` round-trip on a member-id collision.

### Changed

- **`scripts/lib/decision-log.mjs`** header comment now enumerates `slug-renamed` and `rejected-stale` alongside `applied`, `rejected-by-metric`, `rejected-by-gate`, `pending-tier2`. The on-disk schema is unchanged — the enum was always `decision: <string>` with no runtime validation — but the comment block was lagging reality.
- **`guide/substrate/tiered-ai.md`** gained a NEST-operator decision-enum subsection and lost the stale "Phase 6 caveat" language that claimed Tier 2 was a stub. Tier 2 has been real since v0.4.0; the caveat was drift.
- **`guide/substrate/operators.md`** gained an "atomic slug resolution" step describing the pre-apply resolver, and dropped a stale reference to `activation_defaults.keyword_matches` on NEST subcategory stubs (aggregation was removed in v0.4.0).
- **`README.md`** Tier 1 embeddings are now documented as a required runtime dependency (correct since v0.4.0); the "optional install" language was drift. The architecture tree also lists `nest-applier.mjs` alongside `operators.mjs`.
- **`scripts/cli.mjs`** now reads the version from `package.json` at runtime via `import.meta.url` resolution instead of duplicating it as a hand-maintained `CLI_VERSION` constant. The previous hardcode had drifted two releases (CLI said `v0.3.0` through v0.4.1); the new pattern can never drift because there is only one source of truth. Falls through to `"unknown"` if `package.json` is unavailable in the installed artifact — a defensive fallback for environments where package manifests are stripped post-install.

### Tests

- Suite size: 470 → 472 (+2 from the new null/undefined, index.md-skip, and length-overflow tests; the initial DUP-ID test landing was already counted in the pre-1.0 tally). 3 skipped (opt-in gates, unchanged from v0.4.1). 0 failing on both `ubuntu-latest` and `windows-latest`.
- Novel-corpus end-to-end validation on `skill-code-review/reviewers/ + overlays/` (45 leaves) passed on the post-fix run: 1 convergence iteration, 13 NESTs applied atomically, `validate` clean, `decisions.yaml` contains the expected `slug-renamed` entry for the `security` → `security-group` rename and zero `rejected-*` entries.

### Known limitations (1.0.0, intentional)

- **Pathological long-slug collisions (base ≥ 58 chars)** return the original colliding slug rather than a truncated variant. `applyNest` surfaces the collision with a clear error; no silent corruption. If future Tier 2 prompts start generating very long slugs, the resolver can grow a truncation fallback without a breaking change.
- **Single-writer-per-wiki** is a documented invariant; there is no OS-level lock file on `<wiki>/.llmwiki/`. Concurrent CLI invocations on the same wiki may race. Planned for 1.1 if a user actually hits this.

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
