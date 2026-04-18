---
id: recipe-subject-wiki
type: primary
depth_role: leaf
focus: "Init a subject topic wiki (runbooks, adrs) with nested categories"
parents:
  - ../index.md
tags:
  - subject
  - init
  - hosted
  - consumers
activation:
  keyword_matches:
    - subject wiki
    - runbooks wiki
    - adr wiki
    - nested categories
  tag_matches:
    - subject
    - init

generator: "skill-llm-wiki/v1"
---

# Recipe: subject wiki

## Trigger

Your consumer wants to manage a topic whose entries group by subject (runbooks, architecture decisions, playbooks). The wiki grows by adding subcategories, not dates.

## Commands

```bash
skill-llm-wiki init .development/shared/runbooks \
  --kind subject --template runbooks --json

# After init, build (one-time):
skill-llm-wiki build .development/shared/runbooks \
  --layout-mode hosted --target .development/shared/runbooks --json
```

Available subject templates:

| Template | Best for |
|---|---|
| `runbooks` | operational runbooks, playbooks, incident response |
| `adrs` | architecture decision records (zero-padded sequential prefix) |

If you omit `--template`, `--kind subject` falls back to `runbooks`.

## Category promotion rule

Both shipped templates encode the same invariant in their `global_invariants`: create a subject subfolder on the first write, and grow the hierarchy whenever two or more leaves share a defensible grouping. Never pile leaves at the topic root after a threshold — do it on write.

Your consumer should:

1. Pick the subject subfolder before writing the leaf.
2. Write the leaf at the deepest valid category path.
3. Run `heal` (see [post-write-heal.md](post-write-heal.md)) so `validate` catches drift from the invariant.

## Envelope fields

Same `init` envelope as the dated recipe:

```json
{
  "schema": "skill-llm-wiki/v1",
  "command": "init",
  "verdict": "initialised",
  "target": "/abs/.../runbooks",
  "artifacts": { "created": ["/abs/.../.llmwiki.layout.yaml"] },
  "diagnostics": [{ "code": "NEXT-01", "severity": "info", "message": "..." }]
}
```

## Minimum consumer code

```js
import { spawnSync } from "node:child_process";

function initSubject(topicPath, template = "runbooks") {
  const r = spawnSync(
    "skill-llm-wiki",
    ["init", topicPath, "--kind", "subject", "--template", template, "--json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
```

## Failure modes

- `verdict: "ambiguous"` with `INIT-05`: `--kind subject` does not match a dated template (`reports`, `sessions`, `regressions`, `plans`).
- `verdict: "ambiguous"` with `INIT-07`: contract already exists; use `--force` or `rebuild`.

## Do not

- Put runbooks in a flat list at the topic root. After three siblings, every new leaf should land under a named subcategory.
- Use a date prefix or date subfolder. Subject wikis are explicitly not dated; that is why they use this template.
