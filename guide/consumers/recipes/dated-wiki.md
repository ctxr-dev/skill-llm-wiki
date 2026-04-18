---
id: recipe-dated-wiki
type: primary
depth_role: leaf
focus: "Init a dated topic wiki (reports, sessions, regressions) with one command"
parents:
  - ../index.md
tags:
  - dated
  - init
  - hosted
  - consumers
activation:
  keyword_matches:
    - dated wiki
    - reports wiki
    - sessions wiki
    - regressions wiki
    - yyyy/mm/dd
  tag_matches:
    - dated
    - init

generator: "skill-llm-wiki/v1"
---

# Recipe: dated wiki

## Trigger

Your consumer wants to manage a topic whose entries accrete by date (reports, sessions, regression notes, anything with a timestamp). A flat list of date-prefixed siblings will break past a few dozen entries; a nested `{yyyy}/{mm}/{dd}` structure scales indefinitely.

## Commands

```bash
# Seed the layout contract from a shipped starter template and
# emit the envelope:
skill-llm-wiki init .development/shared/reports \
  --kind dated --template reports --json

# The envelope names the next command to run. Typically:
skill-llm-wiki build .development/shared/reports \
  --layout-mode hosted --target .development/shared/reports --json
```

Available dated templates (from `skill-llm-wiki contract --json` → `layout_tokens`, and `scripts/lib/templates.mjs`):

| Template | Default path template | Best for |
|---|---|---|
| `reports` | `{yyyy}/{mm}/{dd}` | review reports, investigations |
| `sessions` | `{yyyy}/{mm}/{dd}` | daily session logs |
| `regressions` | `{yyyy}/{mm}` | bug triage, post-mortems |
| `plans` | `{yyyy}/{mm}/{dd}` | implementation plans + subject families |

If you omit `--template`, `--kind dated` falls back to `reports`.

## Envelope fields

After `init` succeeds, the envelope is:

```json
{
  "schema": "skill-llm-wiki/v1",
  "command": "init",
  "target": "/abs/path/to/.development/shared/reports",
  "verdict": "initialised",
  "exit": 0,
  "diagnostics": [
    {
      "code": "NEXT-01",
      "severity": "info",
      "path": "/abs/path/to/.development/shared/reports",
      "message": "contract seeded; next step: skill-llm-wiki build ..."
    }
  ],
  "artifacts": {
    "created": ["/abs/.../.llmwiki.layout.yaml"],
    "modified": [],
    "deleted": []
  },
  "timing_ms": 12
}
```

Consumers parse the `NEXT-01` diagnostic to get the exact build command.

## Minimum consumer code

```js
import { spawnSync } from "node:child_process";

function initDated(topicPath, template = "reports") {
  const r = spawnSync(
    "skill-llm-wiki",
    ["init", topicPath, "--kind", "dated", "--template", template, "--json"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`init failed: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  if (env.verdict !== "initialised") throw new Error(env.diagnostics?.[0]?.message ?? "unexpected");
  const nextHint = env.diagnostics.find((d) => d.code === "NEXT-01");
  return { contractPath: env.artifacts.created[0], nextCommand: nextHint?.message };
}
```

## Failure modes

- `verdict: "ambiguous"` with `INIT-02`: you passed neither `--kind` nor `--template`.
- `verdict: "ambiguous"` with `INIT-05`: `--kind` and `--template` disagree (e.g. `--kind dated --template runbooks`).
- `verdict: "ambiguous"` with `INIT-07`: a `.llmwiki.layout.yaml` already exists. Pass `--force` only if you are sure the existing contract is wrong; otherwise `skill-llm-wiki rebuild` against the existing contract instead.
- `verdict: "ambiguous"` with `INIT-08`: the topic path (or the contract path inside it) exists as a symbolic link. `init` refuses to follow symlinks into unknown targets for security. Resolve the symlink explicitly (`realpath <topic>`) and pass the resolved path, or remove the symlink.

## Do not

- Copy the template file by hand. The skill's `init` command reads the same file; there is no reason to duplicate it in your own repo.
- Pick `{yyyy}-{mm}-{dd}` as a filename prefix. Flat date-prefixed siblings are refused by `validate`.
