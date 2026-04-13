---
id: fix
type: primary
depth_role: leaf
focus: "Fix operation — repair methodology divergences in an existing wiki"
parents:
  - index.md
covers:
  - "three repair classes: AUTO (deterministic), AI-ASSIST (script detects, Claude generates content), HUMAN (user must decide)"
  - "modes: --dry-run, --batch, --interactive, --hard-only, --with-soft"
  - "10-phase pipeline: preflight, validate-input, scan-divergences, plan-fixes, apply-auto, apply-ai-assist, prompt-human, regenerate-indices, validate-again, golden-path, commit"
  - "Fix enforces contract invariants on top of methodology invariants in hosted mode"
  - "always report repairs back to the user; never run silently"
tags:
  - operations
  - fix
  - repair
activation:
  keyword_matches:
    - fix
    - repair
    - divergence
    - reconcile
  tag_matches:
    - operation
    - fixing
    - mutation
---

# Fix

**Purpose:** repair methodology divergences. Uses the same safety envelope, produces a new version (or in-place updated tree in hosted mode).

## Repair classes

Every invariant from `guide/invariants.md` is tagged with one of:

- **AUTO** — script-deterministic repairs: missing `id` that matches filename, stale indices, derivable `parents[]`, broken `links[].id` with alias resolution, parent-file contract violations (extract leaked content to a new leaf), out-of-sync counts, `depth_role` mismatches, missing `aliases[]` after rename cascades.
- **AI-ASSIST** — script detects, you generate the repair content: missing `focus`, missing `covers[]`, `focus` failing the narrowing chain, DECOMPOSE needing semantic partition, source-hash drift needing fresh frontmatter from updated content.
- **HUMAN** — user must decide: cycles in `parents[]`, colliding ids that are not semantically identical, canonical-parent inconsistencies, orphaned overlay targets, contract violations with no clear repair.

## Modes

- `--dry-run` — plan only, no mutation.
- `--batch` — apply AUTO and AI-ASSIST, write HUMAN items to decisions file, exit.
- `--interactive` — apply each class in sequence, stop for HUMAN decisions inline.
- `--hard-only` — repair hard-invariant violations only.
- `--with-soft` — also address soft signals via operator primitives (see `guide/operators.md`).

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay if it fails.
1. **validate-input** — find all divergences via `node scripts/cli.mjs validate <wiki>`.
2. **scan-divergences** — categorise each finding into AUTO / AI-ASSIST / HUMAN.
3. **plan-fixes** — write `<wiki>/.work/fix-plan.yaml`. Stop if `--dry-run`.
4. **apply-auto** — execute deterministic repairs using `Edit`, `Write`, and `node scripts/cli.mjs index-rebuild-one`.
5. **apply-ai-assist** — for each AI-ASSIST item, read the relevant source/entry, generate the repair content, write it back with `Write`.
6. **prompt-human** — for HUMAN items, either halt and ask the user inline (`--interactive`) or write a decisions file and exit (`--batch`).
7. **regenerate-indices** — `node scripts/cli.mjs index-rebuild <wiki>`.
8. **validate-again** — re-run the validator to confirm repairs took effect.
9. **golden-path** — re-route fixtures if present to catch regressions.
10. **commit** — flip current-pointer (free) or finalize in-place after backup (hosted).

## Notes

- Fix is the primary repair path. Always prefer Fix over direct hand-editing of frontmatter.
- In hosted mode, Fix enforces both methodology invariants and the contract's `global_invariants` + per-directory `content_rules`.
- Never run Fix silently — always report every repair you made (and every HUMAN item you couldn't auto-resolve) back to the user.
