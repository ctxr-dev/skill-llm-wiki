---
id: fix
type: primary
depth_role: leaf
focus: Fix operation — repair methodology divergences in an existing wiki
parents:
  - index.md
covers:
  - "three repair classes: AUTO (deterministic), AI-ASSIST (script detects, Claude generates content), HUMAN (user must decide via structured prompt)"
  - "phase pipeline: preflight, intent-check, pre-op snapshot, validate-input, scan, apply-auto, apply-ai-assist, prompt-human, index-rebuild, validation, commit-finalize"
  - Fix enforces contract invariants on top of methodology invariants in hosted mode
  - always report repairs back to the user; never run silently
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
source:
  origin: file
  path: "operations/fix.md"
  hash: "sha256:187ceb962a8fb6f29ab23d3010189bfadf0827e7bc951098a1a4d907bc6fd1e4"
---

# Fix

**Purpose:** repair methodology divergences. Uses the same safety envelope as Build: pre-op snapshot, phase commits, per-op `op/<id>` tag, and the standard validation gate.

> **Scope note.** The Fix pipeline in the current orchestrator is a **minimal forward-port**: it runs the phase sequence below and writes AUTO-class repairs, but the rich mode surface described in earlier methodology drafts (`--dry-run`, `--batch`, `--interactive`, `--hard-only`, `--with-soft`, a planned `fix-plan.yaml` artefact) is scoped as **future work** and is not wired through the CLI today. Fix currently accepts only the layout-mode and UX flags documented in `guide/cli.md`; any other flag trips `INT-11`. HUMAN-class divergences currently surface as plain validation errors — a dedicated structured-prompt `INT` code is scoped for the full fix pipeline.

## Repair classes

Every invariant from `guide/invariants.md` is tagged with one of:

- **AUTO** — script-deterministic repairs: missing `id` that matches filename, stale indices, derivable `parents[]`, broken `links[].id` with alias resolution, parent-file contract violations (extract leaked content to a new leaf), out-of-sync counts, `depth_role` mismatches, missing `aliases[]` after rename cascades.
- **AI-ASSIST** — script detects, Claude generates the repair content at session time: missing `focus`, missing `covers[]`, `focus` failing the narrowing chain, DECOMPOSE needing semantic partition, source-hash drift needing fresh frontmatter from updated content.
- **HUMAN** — user must decide: cycles in `parents[]`, colliding ids that are not semantically identical, canonical-parent inconsistencies, orphaned overlay targets, contract violations with no clear repair. These currently surface as plain validation errors; a dedicated structured-prompt `INT` code is scoped for the full fix pipeline.

## Phases

0. **preflight** — Node, git, and wiki-fsck checks.
1. **intent-check** — `intent.mjs` resolves the target and surfaces any ambiguity as `INT-NN`.
2. **pre-op snapshot** — `git add -A && git commit -m "pre-op <op-id>"`, tag `pre-op/<op-id>`.
3. **validate-input** — run the validator and collect all divergences.
4. **scan** — categorise each finding into AUTO / AI-ASSIST / HUMAN.
5. **apply-auto** — execute deterministic repairs via direct file writes under `mutate()`.
6. **apply-ai-assist** — for each AI-ASSIST item, emit a structured request that Claude-at-session-time fulfils with the repair content.
7. **prompt-human** — for HUMAN items, surface the finding as a plain validation error (a dedicated structured-prompt `INT` code is future work). The user resolves the upstream cause and re-invokes `fix`, or opts to `rollback` to `pre-op/<op-id>`.
8. **index-rebuild** — regenerate affected `index.md` files.
9. **validation** — re-run the validator to confirm repairs took effect. Failure triggers rollback to `pre-op/<id>`.
10. **commit-finalize** — tag the final commit `op/<op-id>`, append to the op-log.

## Notes

- Fix is the primary repair path. Always prefer Fix over direct hand-editing of frontmatter.
- In hosted mode, Fix enforces both methodology invariants and the contract's `global_invariants` + per-directory `content_rules`.
- Never run Fix silently — always report every repair you made (and every HUMAN item you couldn't auto-resolve) back to the user.
- A "golden-path" regression check and a `.shape/history/<op-id>/` audit archive are scoped as future work; they are not part of the current phase pipeline.
