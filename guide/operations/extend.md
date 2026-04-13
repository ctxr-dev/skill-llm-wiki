---
id: extend
type: primary
depth_role: leaf
focus: "Extend operation — add new sources to an existing wiki without reprocessing existing entries"
parents:
  - index.md
covers:
  - "9-phase pipeline: preflight, resolve-current, check-mode, ingest-new, classify-new, draft-frontmatter-new, copy-on-write or in-place, index-rebuild-affected, validation, commit"
  - "free mode: copy-on-write produces a new vN+1 sibling; hosted in-place writes directly into existing directories"
  - "classify new entries against existing categories; hosted mode cannot invent new top-level directories"
  - "Extend never applies rewrite operators; shape warnings accumulate for the next Rebuild"
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
---

# Extend

**Purpose:** add new sources to an existing wiki without reprocessing existing entries.

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay if it fails.
1. **resolve-current** — `node scripts/cli.mjs resolve-wiki <source>` (free mode) or treat the target directly (hosted mode).
2. **check-mode** — hosted vs free.
3. **ingest-new** — walk only the new source(s) with `node scripts/cli.mjs ingest`.
4. **classify-new** — classify each new entry against existing categories. In hosted mode, against the contract's `layout[]`. If nothing fits, create a new top-level category (free mode) or escalate to HUMAN (hosted mode — you may not invent new contract directories).
5. **draft-frontmatter-new** — same as Build's draft-frontmatter phase, for new entries only.
6. **copy-on-write** (free mode) — compute next version tag, create `<wiki-next>/`, copy the current version over, apply new entries into the affected branches. Hosted mode in-place: write new entries directly into the existing directories.
7. **index-rebuild-affected** — `node scripts/cli.mjs index-rebuild <wiki>`.
8. **validation** — full hard-invariant check.
9. **commit** — flip current-pointer (free mode) or atomic write-in-place (hosted mode). Archive `<wiki>/.work/` to `.shape/history/extend-<timestamp>/`.

## Notes

- Extend does **not** apply rewrite operators. Accumulated shape warnings are surfaced via `shape-check` and addressed by an explicit next Rebuild.
- Extend never touches entries that already exist — it only writes new ones into affected branches.
- In hosted mode, Extend cannot invent new top-level directories. If a new entry doesn't fit anywhere, escalate to HUMAN and stop.
