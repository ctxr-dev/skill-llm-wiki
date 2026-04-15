---
id: build
type: primary
depth_role: leaf
focus: "Build operation — create a new wiki from source(s) via the full phase pipeline"
parents:
  - index.md
covers:
  - "phase pipeline: preflight, intent-check, pre-op snapshot, ingest, draft-frontmatter, operator-convergence, (optional) review, index-generation, validation, commit-finalize"
  - "sibling mode produces `<source>.wiki/` with its full history in the private git; in-place mode transforms the source itself; hosted mode writes under a user-chosen target with a .llmwiki.layout.yaml contract"
  - "classify is currently a pre-draft categoriser (draft-category) plus per-entry placement; Claude handles unplaceable candidates"
  - draft-frontmatter uses script-first heuristic + Claude fallback for prose-heavy sources
  - operator-convergence is contract-gated in hosted mode
  - "determinism: LLM_WIKI_FIXED_TIMESTAMP pins commit SHAs for reproducible builds"
tags:
  - operations
  - build
activation:
  keyword_matches:
    - build
    - create wiki
    - new wiki
    - from source
    - build wiki
  tag_matches:
    - operation
    - building
source:
  origin: file
  path: "operations/build.md"
  hash: "sha256:37b89f4bc9b693720465dc7cc57b32d18f627f9e5ce520d0ed0cfb4f950c90c7"
---

# Build

**Purpose:** create a new wiki from source(s).

## Invocation

```bash
node scripts/cli.mjs build <source> [--layout-mode sibling|in-place|hosted] [--target <path>]
```

The default mode is `sibling`, which writes to `<source>.wiki/`. Pass `--layout-mode in-place` to transform `<source>/` itself, or `--layout-mode hosted --target <path>` for a user-chosen target that carries a `.llmwiki.layout.yaml` contract. Ambiguous invocations refuse with an `INT-NN` structured error — see `guide/user-intent.md`.

## Phases (executed by the CLI, not by hand)

The `build` subcommand runs the full phase pipeline end-to-end under the orchestrator. Claude does not materialise entries by hand; the CLI is the source of truth. The sequence is:

0. **preflight** — Node.js ≥18, git ≥2.25, and (if the target already exists) `git fsck` on the private repo. Preflight failures exit with codes 4 (Node), 5 (git), or 6 (wiki-corrupt).
1. **intent-check** — `intent.mjs` resolves the layout mode and target; any ambiguity short-circuits with `INT-NN` and exit 2.
2. **pre-op snapshot** — `git add -A && git commit -m "pre-op <op-id>"`, tag `pre-op/<op-id>`. Rollback anchor for the entire operation. Also writes/merges `<wiki>/.gitignore` with the wiki-local ignore entries.
3. **ingest** — walks the source, computes content hashes and byte sizes, records per-target provenance to `<wiki>/.llmwiki/provenance.yaml` so `LOSS-01` can verify nothing was silently dropped.
4. **draft-frontmatter** — per-entry heuristic draft; Claude-in-Tier-2 fallback for prose-heavy sources (via the tiered ladder — see `guide/tiered-ai.md`). Commits as `phase draft-frontmatter: wrote N leaves`.
5. **operator-convergence** — applies DESCEND > LIFT > MERGE > NEST > DECOMPOSE in priority order until no operator reports a change. One git commit per iteration so `git log pre-op/<id>..HEAD` shows per-iteration progress. Operator decisions at Tier 2 go through the decision log at `<wiki>/.llmwiki/decisions.yaml`.
6. **review (optional)** — only if invoked with `rebuild --review`. Not part of the default `build` flow.
7. **index-generation** — regenerates every `index.md`. Commit: `phase index-generation: rebuilt N index.md files`.
8. **validation** — runs all hard invariants from `guide/invariants.md`, including `GIT-01` and `LOSS-01`. Failure triggers `git reset --hard pre-op/<id>` + `git clean -fd`; the operation exits 2 and nothing is persisted under `op/<op-id>`.
9. **commit-finalize** — tags `op/<op-id>`, appends to `<wiki>/.llmwiki/op-log.yaml`, deletes the live `.work/` scratch.

## What Claude does at session time

Claude does not run the phase pipeline by hand. Claude's job during a build is:

1. **Understand the user's ask.** Which source, which layout mode, any constraints. Prompt on ambiguity — see `guide/user-intent.md`.
2. **Invoke `build` with the right flags.** Relay the CLI's output to the user.
3. **If the CLI exits with `INT-NN`**, read the structured error and ask the user the disambiguating question. Do not invent a flag the user didn't confirm.
4. **If the CLI fails at validation**, read the structured findings and either (a) propose a Fix invocation to repair them, or (b) tell the user what went wrong. Never hand-edit frontmatter in a wiki that failed validation — the working tree is already back at `pre-op/<op-id>`.
5. **If a Tier 2 AI call was needed during draft-frontmatter**, the orchestrator will prompt Claude-at-session-time via a structured request. Read the source, draft the `focus` and `covers[]`, return them.

## Notes

- **Determinism.** Setting `LLM_WIKI_FIXED_TIMESTAMP=<epoch>` pins commit/tag timestamps so same-input builds produce byte-identical commit SHAs across runs and machines.
- **Hosted mode.** The contract file must already exist at the target root before the build runs — if it doesn't, the build refuses with `INT-09b` or (if the target is foreign) `INT-01b`.
- **In-place mode.** The `pre-op/<op-id>` snapshot captures the source content byte-for-byte before the build starts, so rollback restores the original directory exactly.
