---
id: extend
type: primary
depth_role: leaf
focus: Extend operation — add new sources to an existing wiki without reprocessing existing entries
parents:
  - index.md
covers:
  - "phase pipeline: preflight, intent-check, pre-op snapshot, ingest-new, draft-frontmatter-new, place-new, index-rebuild, validation, commit-finalize"
  - "extend operates on the same stable `<source>.wiki/` sibling (or in-place / hosted target), producing new per-phase commits under a new `op/<id>` tag"
  - new entries are classified against existing categories; hosted mode cannot invent new top-level directories
  - extend never applies rewrite operators; shape warnings accumulate for the next Rebuild
tags:
  - operations
  - extend
activation:
  keyword_matches:
    - extend
    - add source
    - add to wiki
    - new source
    - append
  tag_matches:
    - operation
    - building
source:
  origin: file
  path: "operations/extend.md"
  hash: "sha256:2a8465183bc32543b35e1b0c61ecadf1070ad3f569c321ae5ca6c335a4961b15"
---

# Extend

**Purpose:** add new sources to an existing wiki without reprocessing existing entries.

## Invocation

```bash
node scripts/cli.mjs extend <wiki> <source>
```

The wiki keeps its original layout mode; extend appends commits to the same stable sibling directory (or in-place target, or hosted target) and tags a new `op/<id>` on completion. Rollback to `pre-op/<id>` restores the pre-extend state exactly.

## Phases

0. **preflight** — Node.js, git, and wiki-fsck checks (see SKILL.md and `guide/preflight.md`). Exit codes 4 / 5 / 6 on failure.
1. **intent-check** — `intent.mjs` resolves the target; legacy `.llmwiki.v<N>/` targets trigger the `INT-04` migration prompt; a dirty enclosing user git repo raises `INT-08` unless `--accept-dirty` is passed.
2. **pre-op snapshot** — `git add -A && git commit -m "pre-op <op-id>"`, tag `pre-op/<op-id>`.
3. **ingest-new** — walks only the new source(s), computes hashes. *(Provenance is currently build-only; extend does not append to `provenance.yaml`.)*
4. **draft-frontmatter-new** — per-entry heuristic draft with Tier-2 fallback for prose-heavy sources.
5. **place-new** — classify each new entry against existing categories. Hosted mode: against the contract's `layout[]`. If nothing fits: sibling mode creates a new top-level category; hosted mode escalates to HUMAN (you may not invent new contract directories).
6. **index-rebuild** — regenerates affected `index.md` files.
7. **validation** — full hard-invariant check.
8. **commit-finalize** — tags `op/<op-id>`, appends to the op-log.

## Notes

- Extend does **not** apply rewrite operators. Accumulated shape warnings are surfaced via `shape-check` and addressed by an explicit next Rebuild.
- Extend never touches entries that already exist — it only writes new ones into affected branches.
- In hosted mode, Extend cannot invent new top-level directories. If a new entry doesn't fit anywhere, escalate to HUMAN and stop.
- Extend is currently a **minimal forward-port** of the build pipeline scoped to new sources; a richer incremental-update path (per-entry diff, selective re-classification) is scoped as future work.
