# Validate

**Purpose:** read-only correctness check against a wiki.

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay if it fails.
1. **run validator** — `node scripts/cli.mjs validate <wiki>`.
2. **interpret findings** — parse the stdout report; each finding has a code (e.g. `PARENTS-REQUIRED`, `ID-MISMATCH-FILE`, `DUP-ID`), a severity tag, and the affected path.
3. **report to user** — surface every finding verbatim with its code and path. In hosted mode, note contract invariants separately so the user sees which layer is failing.

## Notes

- Do not auto-fix anything. If the user wants repairs, they explicitly invoke Fix — see `guide/operations/fix.md`.
- The validator exits 0 on clean, 2 on errors. Warnings are printed but don't affect exit code.
- Validate is the lowest-risk operation you can run against any existing wiki — always run it before structural changes.
