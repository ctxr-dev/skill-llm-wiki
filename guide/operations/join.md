---
id: join
type: primary
depth_role: leaf
focus: "Join operation — merge N ≥ 2 existing wikis into a single unified wiki"
parents:
  - index.md
covers:
  - "11-phase pipeline: preflight, ingest-all, source-validate, plan-union, resolve-id-collisions, merge-categories, rewire-references, apply-operators, generate-indices, validation, golden-path-union, commit"
  - "id collision policies: merge, namespace (default), ask"
  - "category merging via category-level MERGE when focus matches"
  - "reference rewiring across sources via id → alias → rename map"
  - "source immutability: inputs are read-only and byte-identical after Join"
  - "hosted wikis require compatible contracts or a merged contract at the join target"
tags:
  - operations
  - join
  - merge
activation:
  keyword_matches:
    - join
    - merge wikis
    - combine wikis
    - unify
  tag_matches:
    - operation
    - building
    - mutation
---

# Join

**Purpose:** merge N ≥ 2 existing wikis into one.

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay if it fails.
1. **ingest-all** — read every source wiki's tree into memory.
2. **source-validate** — `node scripts/cli.mjs validate` on each source. Any hard failure halts with "fix this source first."
3. **plan-union** — build an in-memory union of categories, entries, overlays, relationships.
4. **resolve-id-collisions** — policy:
   - `--id-collision=merge`: if frontmatter compatible, apply MERGE (see `guide/operators.md`); merged entry inherits both ids in `aliases[]` and both source wikis in `source_wikis[]`.
   - `--id-collision=namespace` (default): rename each colliding entry `<source-prefix>.<original-id>`. Record the rename.
   - `--id-collision=ask`: halt, write to HUMAN decisions file.
5. **merge-categories** — for top-level categories with matching focus, category-level MERGE.
6. **rewire-references** — walk every `links[].id`, `overlay_targets`, `parents[]`; resolve via id → alias → rename map.
7. **apply-operators** — full operator-convergence on the unified tree.
8. **generate-indices** — `node scripts/cli.mjs index-rebuild` on the joined tree.
9. **validation** — hard invariants on the joined tree.
10. **golden-path-union** — each source's fixtures must still pass. Regressions halt for user decision.
11. **commit** — atomic move into target versioned directory. In hosted mode, both contracts must be compatible (same top-level paths and compatible rules) or a merged contract must be supplied at the join target.

## Source immutability

Every source wiki is read-only during the operation and byte-identical afterward. Join never mutates the inputs; it only produces a new unified output.

## Notes

- If the user is joining hosted wikis with different contracts, ask them to provide or confirm a merged contract at the target before starting.
- Always run Validate against each source before Join. Joining a broken source produces a broken joined wiki.
- The default id-collision policy (`namespace`) is the safest — it never loses any entry, just renames conflicts. `merge` should only be used when the user explicitly confirms the entries are semantically identical.
