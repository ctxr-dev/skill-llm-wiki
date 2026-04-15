---
id: validate
type: primary
depth_role: leaf
focus: Validate operation — read-only correctness check against a wiki
parents:
  - index.md
covers:
  - "invokes `node scripts/cli.mjs validate <wiki>` and reports every finding verbatim"
  - "exit codes: 0 clean, 2 errors; warnings do not change exit code"
  - does not auto-fix; if repairs are wanted the user must explicitly invoke Fix
  - lowest-risk operation, always run before structural changes
tags:
  - operations
  - validate
  - read-only
activation:
  keyword_matches:
    - validate
    - check wiki
    - verify wiki
    - correctness
  tag_matches:
    - operation
    - validating
source:
  origin: file
  path: "operations/validate.md"
  hash: "sha256:8b710cbe390c57c46a4bcc5fea6d3df886b9d9ba6352f365fd05dacdb1e094b1"
---


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
