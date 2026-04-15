---
id: rebuild
type: primary
depth_role: leaf
focus: "Rebuild operation — optimise structure via rewrite operators, produce a rewrite plan then apply"
parents:
  - index.md
covers:
  - "10-phase pipeline including validate-input, check-mode, collect-candidates, dry-run-apply, iterate, golden-path-check, emit-plan, backup (hosted), apply, commit"
  - "always emit the plan first; require user review before `--apply`"
  - "operator-convergence is contract-gated in hosted mode"
  - "failed apply leaves the previous state intact (pointer unchanged or backup restored)"
tags:
  - operations
  - rebuild
  - operators
activation:
  keyword_matches:
    - rebuild
    - optimize
    - optimise
    - restructure
    - rewrite plan
  tag_matches:
    - operation
    - structural-change
    - mutation
---

# Rebuild

**Purpose:** optimise structure via rewrite operators, produce a new version (or in-place updated tree in hosted mode).

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay if it fails.
1. **validate-input** — the input wiki must pass hard invariants. If not, tell the user to run Fix first.
2. **check-mode** — free vs hosted; load the contract from `guide/layout-contract.md` if present.
3. **collect-candidates** — run `node scripts/cli.mjs shape-check <wiki>` and read `<wiki>/.shape/suggestions.md`. Score each candidate against fitness (density + weighted-content).
4. **dry-run-apply** — apply operators (see `guide/operators.md`) in priority order on an in-memory projected tree state. In hosted mode, contract-gate every proposed move. After each application, recompute fitness. Accept only if fitness strictly improves or a hard invariant is newly satisfied.
5. **iterate** — until no accepted moves.
6. **golden-path-check** — if fixtures exist, route each through the projected tree. Roll back any move that causes a regression.
7. **emit-plan** — write `<wiki>/.shape/rewrite-plan-<timestamp>.yaml`. Stop here if the user invoked `--plan` (or didn't authorise an apply yet).
8. **backup** (hosted + in-place only) — snapshot target to `<backup_dir>/<timestamp>/`.
9. **apply** — execute the plan: copy current version to a new version directory (free mode) or apply changes in place (hosted + in-place), rewrite file locations, rebuild indices, re-validate.
10. **commit** — flip current-pointer (free) or finalize in-place (hosted). Archive work.

## Notes

- Always write the plan first and let the user review before applying. Rebuild is the most structurally-invasive operation — the user should see what's about to move before it moves.
- Rebuild never silently skips contract rules in hosted mode. If a proposed move violates the contract, it's rejected and the remaining operators still run until convergence within the contract's boundaries.
- A failed apply leaves the previous state intact (free: previous version still pointed to by current-pointer; hosted: backup restored).

## `--review` — interactive per-iteration review (Phase 7)

Pass `--review` on any `rebuild` invocation to pause after operator-
convergence and walk through the pending operator commits one by
one. After the convergence phase produces its per-iteration commits
(and before validation + commit-finalize run), the review flow:

1. Prints `git diff --stat pre-op/<id>..HEAD` so you see the file-
   level summary of what moved.
2. Lists every pending iteration commit with its subject line.
3. Prompts you to pick one of: **approve**, **abort**, or **drop
   &lt;iteration&gt;**.

- **approve** — proceed to validation + commit-finalize as normal.
- **abort**   — `git reset --hard pre-op/<id>` + `git clean -fd`,
  roll the working tree back to its pre-op state, and exit with
  code 2. Nothing lands in the wiki.
- **drop &lt;N&gt;** — revert the commit for iteration N via
  `git revert --no-edit`, producing an inverse commit. Iteration
  N's move is undone but the other iterations survive. Re-prompts
  so you can drop more iterations one at a time.

In non-interactive mode (CI, hooks, `--no-prompt`, or stdin not a
TTY), `--review` is a silent pass-through — the orchestrator
proceeds as if the flag hadn't been passed.

`--review` only pauses when convergence actually produced at
least one commit. An op that triggered zero operators auto-
approves without prompting.
