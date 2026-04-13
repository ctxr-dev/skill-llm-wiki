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
