---
id: invariants
type: primary
depth_role: leaf
focus: "hard validation invariants and soft shape signals for LLM wikis"
parents:
  - index.md
covers:
  - "21 hard invariants checked by `cli.mjs validate` — including id/filename match, narrowing chain, DAG acyclicity, canonical-parent consistency, parent-file contract, size caps, and generator marker"
  - "soft shape signals reported by `cli.mjs shape-check` (DECOMPOSE, NEST, MERGE, LIFT, DESCEND candidates, coverage holes, golden-path regressions)"
  - "hosted-mode layering: contract global_invariants add to the methodology defaults"
  - "how to read the validate report (TAG, CODE, path, severity)"
  - "exit codes: 0 clean, 2 errors, warnings do not change exit"
tags:
  - validation
  - invariants
  - shape-check
activation:
  keyword_matches:
    - invariant
    - validate
    - validation
    - errors
    - check
    - verify
  tag_matches:
    - validating
    - fixing
  escalation_from:
    - build
    - extend
    - validate
    - rebuild
    - fix
    - join
---

# Validation invariants

## Hard invariants (checked by `node scripts/cli.mjs validate`)

All of these are hard errors and block commit:

1. Every entry has required frontmatter fields for its `type`.
2. `id` matches filename (leaves) or directory name (indices).
3. `depth_role` matches actual tree depth.
4. Strict narrowing chain along canonical `parents[0]` up to the root.
5. Every `entries[]` reference in an index resolves to an on-disk file.
6. Every `overlay_targets` resolves to an existing primary id or alias.
7. Every `links[].id` resolves to an existing id or alias.
8. Non-root entries have non-empty `parents[]`.
9. DAG acyclicity — `parents[]` never forms a cycle.
10. Canonical-parent consistency — entry lives inside `parents[0]`'s directory.
11. No duplicate ids; aliases don't collide with live ids.
12. Size caps: primaries ≤ 500 lines, overlays ≤ 200 lines.
13. Parent file contract — index body authored zone ≤ 2 KB, no leaf-content signatures.
14. Every directory containing entries has a valid `index.md`.
15. No entry at depth > 0 outside an indexed directory.
16. Every relative markdown link in bodies resolves.
17. Counts in human-facing summaries match actual entry counts.
18. Stale-index detection — no leaf mtime newer than its containing index's mtime.
19. Source integrity — if `source.hash` is set, current upstream hash must match.
20. Cross-reference coherence — every soft-parent cross-reference resolves to a real canonical entry.
21. Root index carries `generator: skill-llm-wiki/v1`.

In hosted mode, add the contract's `global_invariants` to this list. See `guide/layout-contract.md`.

## Soft shape signals (reported by `node scripts/cli.mjs shape-check`)

Non-blocking suggestions that feed the next Rebuild:

- **DECOMPOSE candidate**: `covers[]` clusters into disjoint groups, or exceeds 12 items.
- **NEST candidate**: ≥3 H2 sections each a strict narrowing, or `nests_into[]` is set.
- **MERGE candidate**: sibling pair with high focus similarity and >70% covers overlap.
- **LIFT candidate**: folder contains exactly one non-index entry.
- **DESCEND candidate**: index body authored zone exceeds budget or contains leaf signatures.
- **Coverage hole**: `shared_covers[]` empty or no overlap with children.
- **Golden-path regression**: a fixture's load set grew vs. the previous version.

## Reading the validate report

The `validate` CLI prints one `[TAG] CODE path` line per finding, then a summary `N error(s), M warning(s)`. Exit 0 = clean, exit 2 = errors. Relay every finding to the user with the code and the affected path so they can locate the problem.
