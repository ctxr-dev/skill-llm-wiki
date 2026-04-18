---
id: recipe-ci-gate
type: primary
depth_role: leaf
focus: "Gate CI on skill-llm-wiki validate --json"
parents:
  - ../index.md
tags:
  - ci
  - validate
  - gate
  - consumers
activation:
  keyword_matches:
    - ci gate
    - ci validation
    - github actions
    - gitlab pipeline
    - pre-commit wiki
  tag_matches:
    - ci
    - gate

generator: "skill-llm-wiki/v1"
---

# Recipe: CI gate

## Trigger

Your consumer wants CI to reject PRs that break wikis shipped in the repository.

## Commands

```bash
skill-llm-wiki validate .development/shared/reports --json
```

Exit code `0` → clean. Exit code `2` → errors found; CI should fail.

## Envelope fields

```json
{
  "schema": "skill-llm-wiki/v1",
  "command": "validate",
  "target": "/abs/.../reports",
  "verdict": "ok" | "broken",
  "exit": 0 | 2,
  "diagnostics": [
    { "code": "IDX-01", "severity": "warning", "path": "...", "message": "..." },
    { "code": "PARSE",  "severity": "error",   "path": "...", "message": "..." }
  ],
  "timing_ms": 412
}
```

CI should fail when `exit !== 0` AND any diagnostic with `severity: "error"` is present. A warning-only run exits 0.

## GitHub Actions example

```yaml
# .github/workflows/wiki-validate.yml
name: wiki-validate
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm i -g @ctxr/skill-llm-wiki
      - name: contract gate
        run: |
          FV=$(skill-llm-wiki contract --json | jq -r '.format_version')
          if [ "$FV" -lt 1 ]; then
            echo "skill-llm-wiki format_version=$FV is below required 1" >&2
            exit 1
          fi
      - name: validate reports
        run: skill-llm-wiki validate .development/shared/reports --json | tee validate.json
      - name: fail on error diagnostics
        run: |
          errs=$(jq '[.diagnostics[] | select(.severity == "error")] | length' validate.json)
          if [ "$errs" -gt 0 ]; then
            jq '.diagnostics[] | select(.severity == "error")' validate.json
            exit 1
          fi
```

## Pre-commit / husky example

```json
// package.json
"scripts": {
  "wiki:validate": "skill-llm-wiki validate .development/shared/reports --json | node scripts/wiki-validate-check.mjs"
}
```

```js
// scripts/wiki-validate-check.mjs
import { readFileSync } from "node:fs";
const env = JSON.parse(readFileSync(0, "utf8"));
const errors = env.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  for (const e of errors) console.error(`[${e.code}] ${e.path}: ${e.message}`);
  process.exit(1);
}
```

## Failure modes

- Validate exits `6`: the wiki substrate is corrupt (missing `.llmwiki/git/`, divergent refs). CI must fail; fix in a separate PR.
- Validate exits `7`: impossible for `validate` alone; only reachable from build/extend/rebuild.
- Validate exits `8`: runtime deps missing on CI runner. Install `@ctxr/skill-llm-wiki` in the CI image.

## Do not

- Parse `stderr` for errors. The envelope on stdout is the contract; stderr is free-form logging.
- Silence errors with `|| true`. Validate failures are real; a broken wiki in `main` propagates to every downstream consumer.
- Rerun validate in a loop until it passes. If it fails once, it fails deterministically.
