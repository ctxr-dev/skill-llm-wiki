---
id: recipe-post-write-heal
type: primary
depth_role: leaf
focus: "The canonical after-every-leaf-write heal invocation"
parents:
  - ../index.md
tags:
  - heal
  - envelope
  - post-write
  - consumers
activation:
  keyword_matches:
    - post write
    - after write
    - heal
    - validate after write
    - next command
  tag_matches:
    - heal
    - post-write

generator: "skill-llm-wiki/v1"
---

# Recipe: post-write heal

## Trigger

Your consumer just wrote a leaf into a hosted wiki. Before moving on, call `heal` to classify the wiki's state and let it name the next command.

## Commands

```bash
skill-llm-wiki heal .development/shared/reports --json
```

That is the entire step. Do not invoke `validate`, `fix`, or `rebuild` directly; `heal` is the router.

## Envelope fields

```json
{
  "schema": "skill-llm-wiki/v1",
  "command": "heal",
  "target": "/abs/.../reports",
  "verdict": "ok" | "fixable" | "needs-rebuild" | "broken" | "ambiguous",
  "exit": 0,
  "diagnostics": [
    { "code": "IDX-01", "severity": "warning", "path": "...", "message": "..." },
    { "code": "NEXT-01", "severity": "info",    "path": "...", "message": "next: skill-llm-wiki fix ... --json" }
  ],
  "timing_ms": 23
}
```

| Verdict | What the consumer does |
|---|---|
| `ok` | Nothing. Move on. |
| `fixable` | Run the `NEXT-01` command (`skill-llm-wiki fix <wiki> --json`). |
| `needs-rebuild` | Run the `NEXT-01` command (`skill-llm-wiki rebuild <wiki> --json`). |
| `broken` | Surface every `severity: "error"` diagnostic to the user. Do not auto-mutate. |
| `ambiguous` | `validate` itself failed; inspect `HEAL-00` diagnostic for the error. |

## Minimum consumer code

```js
import { spawnSync } from "node:child_process";

function healAfterWrite(wikiPath) {
  const r = spawnSync(
    "skill-llm-wiki",
    ["heal", wikiPath, "--json"],
    { encoding: "utf8" },
  );
  const env = JSON.parse(r.stdout);
  switch (env.verdict) {
    case "ok":
      return;
    case "fixable":
    case "needs-rebuild": {
      const next = env.diagnostics.find((d) => d.code === "NEXT-01");
      if (!next) throw new Error("heal returned fixable/needs-rebuild without a NEXT-01 hint");
      // Extract the command from the message and invoke it.
      const cmd = next.message.replace(/^next:\s*/, "").split(/\s+/);
      spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
      return;
    }
    case "broken":
      reportDiagnosticsToUser(env.diagnostics);
      throw new Error(`heal: wiki is broken at ${wikiPath}`);
    default:
      throw new Error(`heal: unexpected verdict ${env.verdict}`);
  }
}
```

## Failure modes

- `verdict: "ambiguous"` with a `HEAL-00` diagnostic: validate threw. The wiki substrate itself may be broken (e.g. missing `.llmwiki/git/`).
- A `fixable` run whose follow-up `fix` invocation fails: re-run `heal`; it should now report `needs-rebuild` or `broken`.
- `heal` on a path that does not exist or is not a wiki returns `verdict: "broken"` with `WIKI-01` in diagnostics.

## Why not `fix` / `rebuild` / `validate` directly?

Consumers that pick one of the three without checking the validate output end up:

- Running `fix` on a structurally-broken wiki that only `rebuild` can resolve.
- Running `rebuild` on a wiki with trivial index drift, triggering unnecessary Tier 2 sub-agent work.
- Running `validate` and then duplicating the action table consumers always get wrong.

`heal` centralises the classification so every consumer uses the same rules.

## Do not

- Call `heal` on hot paths (per-keystroke). It runs full validate; budget for one invocation per logical leaf-write batch.
- Ignore `broken` verdicts silently. The wiki is corrupt and further writes will compound the problem.
