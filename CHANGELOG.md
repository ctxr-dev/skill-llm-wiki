# Changelog

All notable changes to `skill-llm-wiki` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
