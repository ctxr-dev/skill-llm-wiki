# Changelog

All notable changes to `skill-llm-wiki` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`--fanout-target=N` and `--max-depth=D` — post-convergence balance enforcement.** A new `balance-enforcement` phase between operator-convergence and index-generation iterates until fixed point applying two deterministic transform classes:
  - **Sub-cluster overfull directories.** Any directory whose *movable* (leaf-only) fan-out exceeds `fanout-target × 1.5` is a candidate; sub-clustering extracts coherent clusters out of leaves, so subdir-heavy dirs with few leaves are un-actionable here and correctly ignored. The math cluster detector carves out the strongest coherent cluster, the Phase X.3 deterministic slug + purpose helpers name it, and `applyNest` applies it. The fanout pass walks the full lex-sorted overfull list until it finds a parent whose leaves yield a live proposal, so one un-actionable candidate never stalls the whole iteration. The "× 1.5" slack (`FANOUT_OVERLOAD_MULTIPLIER`) avoids thrashing on directories that sit one or two children above target. `computeFanoutStats` now returns both `perDir` (combined leaves+subdirs, the Claude-routing-cost view) and `leafCounts` (the movable-fanout view) from a single traversal so `detectFanoutOverload` doesn't re-walk the tree. `buildWikiForbiddenIndex` is built once at `runBalance` entry and mutated (`wikiIndex.add(resolvedSlug)`) after each successful apply, mirroring `operators.mjs::tryClusterNestIteration`'s amortisation pattern — a previous draft rebuilt it per apply, quadratic on the 596-leaf target corpus.
  - **Flatten overdeep single-child passthroughs.** Any branch exceeding `max-depth` whose terminal segment holds exactly one subdir and zero leaves is lifted up one level. Descendants' `parents[]` paths are left unchanged — they are relative to the direct parent's `index.md`, so promoting the whole subtree up one level preserves every relative path by construction. Multi-child subcategories are left alone. `applyBalanceFlatten` preflights the passthrough dir's raw `readdirSync` entries against the allowed set `{child-basename, "index.md"}` BEFORE any mutation — catches stray non-`.md` content (assets, orphan `README.txt`, subdirs lacking `index.md`) that `listChildren` doesn't enumerate, refusing the flatten rather than silently deleting unexpected data. Dot-prefixed entries (`.DS_Store`, editor backups, `.shape/` internals) are treated as noise — not grounds for refusal, but cleaned before the rename so the final `rmdirSync` succeeds. This matches the blanket dot-skip rule the rest of the pipeline already uses (`listChildren`, `buildWikiForbiddenIndex`, `collectEntryPaths`). Final `rmdirSync` refuses non-empty dirs natively as a second safety layer (e.g., against mid-flight writes between preflight and remove).
  - Phase runs only when at least one flag is set; otherwise it is a strict no-op. Deterministic in the inputs — lex-sorted dir iteration, lex-sorted cluster-member iteration, Phase X.3 deterministic naming. Two runs on the same tree produce identical output.
  - **Hard-fail on non-convergence.** The orchestrator's Phase 4.3 hook now throws when `runBalance` reports `converged: false` (iteration cap hit without reaching a fixed point). The pre-op snapshot restores and the user sees a clear error instead of a silently half-balanced tree — an enforcement phase owes the caller a guarantee, not an advisory best-effort.
  - New module `scripts/lib/balance.mjs` exports `runBalance`, `computeDepthMap`, `getMaxDepth`, `computeFanoutStats`, `detectFanoutOverload`, `detectDepthOverage`, `applyBalanceFlatten`, and `FANOUT_OVERLOAD_MULTIPLIER`.
  - New intent errors: `INT-14` (invalid `--fanout-target`, must be a positive integer in [`FANOUT_TARGET_MIN`, `FANOUT_TARGET_MAX`] = [2, 100]) and `INT-15` (invalid `--max-depth`, must be a positive integer in [`MAX_DEPTH_MIN`, `MAX_DEPTH_MAX`] = [1, 10]). Both surface before the orchestrator runs, so a typo never triggers a pre-op snapshot.
  - `contract.mjs::SUBCOMMANDS.build` and `.rebuild` now list the two new flags so consumers gating on the contract know they're available. `extend` is intentionally NOT in that list — the operation is a stub that throws "not yet implemented", so advertising the flags on it would be a contract lie.
- **`--quality-mode deterministic`** — a new quality mode that produces byte-reproducible wiki builds with zero LLM/sub-agent calls in the structural decision path. Complements `tiered-fast` / `claude-first` / `tier0-only`:
  - **Pairwise decisions** (`scripts/lib/tiered.mjs::decide`): Tier 0 decisive paths fire as-is; Tier 0 mid-band escalates to Tier 1 (MiniLM embeddings, already deterministic); Tier 1 mid-band is resolved by a static threshold (`TIER1_DETERMINISTIC_THRESHOLD`, derived from the midpoint of the Tier 1 decisive bounds) instead of escalating to Tier 2. No Tier-2 escalation and no mid-band "undecidable" outcome — Tier 1 always produces a concrete same/different, and `tier2Handler` is never invoked. (Tier 0's "insufficient-text" undecidable on empty-frontmatter pairs is a separate path that predates this mode and is unchanged by design: an empty text pair can't be discriminated by any tier, regardless of quality mode.)
  - **Cluster NEST** (`scripts/lib/operators.mjs::tryClusterNestIteration`): the `propose_structure` Tier 2 request is skipped entirely; math-only candidates bypass the `nest_decision` gate (auto-approved — the partition-shape score + metric regression gate already provide an algorithmic equivalent); math-only candidates also bypass the `cluster_name` request and receive a deterministic slug from `generateDeterministicSlug()` + a deterministic purpose from `deterministicPurpose()`.
  - **Deterministic slug algorithm** (`scripts/lib/cluster-detect.mjs::generateDeterministicSlug`): TF-IDF over member frontmatters with the siblings' corpus as the IDF context, ranked `(weight desc, term asc)` for lex tie-breaking, top 1–2 valid tokens joined with `-`. Falls back to `cluster-<7-hex-fnv1a>` when no token survives the slug regex — still deterministic, still member-derived. Byte-stable across member shuffles.
  - **Use case**: the mode to pair with an upcoming `--fanout-target` / `--max-depth` balance pass and soft-parent synthesis for large hand-authored corpora where reproducible builds matter more than the extra nuance an LLM adds at Tier 2.

### Fixed

- **Cross-depth slug collision guard in `resolveNestSlug`.** The v1.0.0 collision resolver checked only the cluster's immediate parent directory, missing collisions with leaf ids or subdirectory basenames elsewhere in the tree. On real-world multi-branch wikis (first observed during a 596-leaf novel-corpus build in the consumer skill `skill-code-review`), Tier 2's `propose_structure` picked slug `event-patterns` for a cluster under `design-patterns-group/` — colliding with an existing leaf at `arch/event-patterns/index.md` (id: `event-patterns`) in a completely different branch. The parent-dir-only walk missed it; validation caught `DUP-ID` post-apply and forced a rollback. The resolver's API now: `resolveNestSlug(slug, proposal, wikiRoot, opts)` gains an optional `wikiRoot` third argument and an `opts.wikiIndex` escape hatch. When `wikiRoot` is supplied, the internal `collectForbiddenIdsPredicate` returns a predicate backed by a local parent-dir set PLUS either the caller's precomputed index (via `opts.wikiIndex`) or a fresh full-tree walk (via the new private `walkWikiIds`). A new exported helper `buildWikiForbiddenIndex(wikiRoot)` materialises the wiki-wide id + directory-basename set once per convergence iteration — `operators.mjs::tryClusterNestIteration` precomputes it when at least one proposal is picked, mutates it by `wikiIndex.add(resolvedSlug)` after each successful apply, and passes it through `opts.wikiIndex` so each slug-resolve call runs in O(parent-dir) instead of O(full-tree). Total cost across a multi-NEST iteration: O(#files + #applies) instead of O(#applies × #files). Dot-prefixed entries (directories AND files — `.llmwiki/`, `.work/`, `.git/`, `.github/`, stray `.DS_Store` / `.foo.md`) are skipped under a blanket rule matching `scripts/lib/chunk.mjs::collectEntryPaths` discipline. Per-file frontmatter is read via `readFrontmatterStreaming` for bounded reads at the ~600-leaf scale. Legacy callers that don't pass `wikiRoot` continue to get the parent-dir-only behaviour, so the change is backward-compatible. Fixes issue [#4](https://github.com/ctxr-dev/skill-llm-wiki/issues/4) bug 2.
- **Pre-apply alias collision guard in MERGE.** `applyMerge` in `scripts/lib/operators.mjs` now walks the full wiki (skipping every dot-directory) to collect every live entry id (every `.md` file's frontmatter `id:`, including `index.md` entries) before it writes the keeper's new `aliases[]`. If any of the new aliases (absorbed's id or any of absorbed's own aliases) would collide with a live id elsewhere in the tree, the merge is refused pre-apply with a clear error — nothing is written, nothing is deleted, the convergence iteration can continue with the next proposal. Before this fix, such collisions were caught downstream at validation as `ALIAS-COLLIDES-ID`, forcing a full pipeline rollback. The guard is defensive and targets the multi-operator-per-iteration reach-state that produced the collisions during the consumer-skill `skill-code-review` 596-leaf novel-corpus build (3 MERGE pairs hit this during Bundle A2: `pattern-eip-messaging↔pattern-eip-endpoint`, `smell-data-class↔antipattern-anemic-domain-model`, `smell-duplicate-code↔antipattern-copy-paste`). The new helper `collectLiveIds(wikiRoot, excludePaths)` is exported so future operators (e.g. the real `join` implementation) can reuse it. Fixes issue [#4](https://github.com/ctxr-dev/skill-llm-wiki/issues/4) bug 3.

### Changed

- **`VALID_QUALITY_MODES`** (`scripts/lib/intent.mjs`) and **`QUALITY_MODES`** (`scripts/lib/tiered.mjs`) now include `"deterministic"`. The `intent-resolve` and `QUALITY_MODES` canonical-allow-list tests follow.
- **NEST audit-trail semantics for deterministic mode.** `appendNestDecision` in `scripts/lib/decision-log.mjs` previously hard-coded `tier_used: 2` for every NEST entry — correct before deterministic mode existed, since every NEST touched Tier 2 via `propose_structure` or `nest_decision`. Under `--quality-mode deterministic` no sub-agent is ever consulted for math candidates, so entries from that path now record `tier_used: 0` and a new `confidence_band: "deterministic-math"` distinguishes them from `"math-gated"` (which still means "math candidate that passed a Tier 2 gate" under the other quality modes). Tooling and tests that filter `decisions.yaml` by `tier_used` to reason about sub-agent costs now see accurate zeros on the deterministic path. Call sites that don't supply `tier_used` still default to 2, so every existing non-deterministic entry is byte-identical.

### Tests

- `tests/unit/balance.test.mjs` — 17 new scenarios: depth-map (plus non-wiki-node dirs skipped under the `index.md`-only discipline), max-depth, fanout-stats (including `leafCounts` return), overload detection (with and without `nestedParents` exclusion, plus a leaf-metric regression guard against flagging dirs overfull only via subdir count), depth-overage detection (only single-child passthroughs), flatten happy path + refuse on multi-child, flatten refuses when passthrough holds stray non-`.md` content (defensive emptiness check), flatten tolerates + cleans dot-prefixed noise (`.DS_Store`) under the blanket dot-skip rule, `runBalance` no-op when flags absent, fanout-only pass, depth-only pass, fanout pass skips un-actionable `overfull[0]` and acts on a later candidate, multiplier constant pin.
- `tests/unit/intent-resolve.test.mjs` — 4 new scenarios covering INT-14 and INT-15 accept/reject boundaries.
- New scenarios in `tests/unit/nest-applier.test.mjs` for cross-depth collision, subdir-basename collision, `-group-N` chain fallback, dot-prefixed skip, clean-tree no-op, same-depth regression guard, `buildWikiForbiddenIndex` snapshot shape, `opts.wikiIndex` short-circuit semantics, caller-mutation round-trip, and wiki-root `index.md` id capture (in both the legacy walk and the precomputed-index path). All pre-existing tests pass unchanged.
- 4 new scenarios in `tests/unit/operators.test.mjs` covering the guard-trips-on-collision path, the guard-permits-clean-merge regression, and two `collectLiveIds` helper tests (skips `.llmwiki/`/`.work/`, honours `excludePaths`).
- New deterministic-mode coverage across three files:
  - `tests/unit/tiered.test.mjs` — `QUALITY_MODES` canonical allow-list including `"deterministic"`, a constant-derivation pin for `TIER1_DETERMINISTIC_THRESHOLD` (midpoint of the Tier 1 decisive bounds), a joint Tier 0 + Tier 1 mid-band sweep that exercises the `confidence_band === "deterministic-mid-band"` branch empirically, byte-stability across runs, non-escalation to Tier 2, and Tier 0 decisive-path preservation under the new mode.
  - `tests/unit/cluster-detect.test.mjs` — `generateDeterministicSlug` (distinguishing-token selection, order invariance, multi-run stability, hash fallback determinism, precomputed-IDF equivalence) and `deterministicPurpose` (most-shared cover, lex tie-break, focus fallback, plain-frontmatter input equivalence).
  - `tests/e2e/determinism.test.mjs` — new full-build test: two independent `build --quality-mode deterministic` runs on a 6-leaf two-theme corpus must produce byte-identical tree SHAs; the cluster-nest path is in-frame (not skipped); audit-trail check hard-asserts ≥1 NEST entry carrying `tier_used: 0` + `confidence_band: "deterministic-math"`.
- `tests/unit/intent-resolve.test.mjs` — extended the `--quality-mode` acceptance test to cover `"deterministic"` alongside the existing three modes.
- 3 skipped (unchanged from prior baseline; all opt-in gates). 0 failing on `ubuntu-latest` / `windows-latest` (CI) and locally.

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
