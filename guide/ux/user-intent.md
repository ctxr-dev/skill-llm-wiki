---
id: user-intent
type: primary
depth_role: leaf
focus: "ask, don't guess — how to resolve ambiguous user requests before running the skill"
parents:
  - index.md
covers:
  - the CLI refuses every ambiguous invocation with a structured INT-NN code
  - Claude MUST ask the user before running the skill when intent is unclear
  - ambiguity scenarios each have a fixed resolving flag the user can pick
  - "--json (canonical) or --json-errors (legacy alias) makes the ambiguity body machine-parseable for Claude to read"
  - "--no-prompt / LLM_WIKI_NO_PROMPT=1 disables interactive fallback; failures become hard errors"
  - never silently default — the cost of a wrong guess is always higher than a clarifying question
tags:
  - ux
  - intent
  - prompting
activation:
  keyword_matches:
    - unclear
    - ambiguous
    - convert
    - migrate
    - update
    - fix my wiki
    - what should I do
  tag_matches:
    - ux
  escalation_from:
    - build
    - extend
    - rebuild
    - fix
    - join
    - rollback
source:
  origin: file
  path: user-intent.md
  hash: "sha256:3face4263518177ffaf27c0faf82bfa02651743bd62bd0a42a61c10c6fa23656"
---

# Ask, don't guess

The single most important UX rule of this skill: when the user's request is
ambiguous, **ask them before running the skill**. Never silently pick a
default. Never interpret "convert" or "update" or "fix" without confirmation.
The cost of a wrong guess (a rewritten folder, a destroyed history, a commit
in the wrong place) is always higher than a one-sentence clarifying question.

## Two enforcement layers

1. **The CLI refuses ambiguous invocations.** `scripts/lib/intent.mjs`
   walks every CLI call and, if any of the Part 6 scenarios apply, exits
   with code 2 and a structured error. Each error carries a stable
   `INT-NN` code, a human message, a list of numbered options, and the
   disambiguating flag that would resolve the ambiguity.

2. **Claude asks the user.** When Claude receives an ambiguous request
   — "convert my docs", "fix that thing", "update the wiki" — Claude
   **stops and asks** before running the skill. Claude does not guess
   intent based on prior context, does not pick a default, and does not
   proceed with "I'll assume you meant X" framing.

## The ambiguity table

| Code | Trigger | Resolving flag |
|------|---------|----------------|
| INT-01 | Default sibling target exists as a foreign directory | `--target <other>` or `--layout-mode in-place` |
| INT-01b | Explicit `--target` points at a non-empty foreign directory | `--target <other>` or `--accept-foreign-target` |
| INT-02 | Source is already a managed wiki (implicit in-place) | pick `extend`/`rebuild`/`fix`, or `build --layout-mode in-place` |
| INT-03 | Default sibling target is already a managed wiki | pick `extend`/`rebuild`/`fix` |
| INT-04 | Source is a legacy `<name>.llmwiki.v<N>` folder | `skill-llm-wiki migrate <legacy>` |
| INT-05 | `rollback` without `--to` | `--to pre-<op-id>` / `<op-id>` / `genesis` |
| INT-06 | Missing positional, or positional is a file | provide a directory path |
| INT-07 | Multi-source build/extend without ordering | `--canonical <path>` |
| INT-08 | Source inside a dirty user git repo | commit/stash first, or `--accept-dirty` |
| INT-09a | `--layout-mode in-place` combined with `--target` | drop one of the two flags |
| INT-09b | `--layout-mode hosted` invoked without `--target` | add `--target <path>` |
| INT-10 | Unknown `--layout-mode` value | use `sibling` / `in-place` / `hosted` |
| INT-11 | Unknown flag / malformed flag value | correct the flag |
| INT-12 | Prompt required in non-interactive mode | supply the flag the prompt was asking for, or re-run in a TTY |
| INT-13 | Unknown `--quality-mode` value | use `tiered-fast` / `claude-first` / `tier0-only` |

## `--json` for programmatic consumption

When the skill is called from a script or from another Claude session, pass
`--json` (canonical) on every invocation; `--json-errors` is the legacy alias
and continues to work. The ambiguity body becomes a single JSON object on
stderr:

```json
{
  "error": {
    "code": "INT-03",
    "message": "./docs.wiki is already a managed wiki; choose an operation",
    "options": [
      { "description": "add new entries from the source", "flag": "extend ./docs" },
      { "description": "optimise structure in place", "flag": "rebuild ./docs" },
      { "description": "repair methodology divergences", "flag": "fix ./docs" }
    ],
    "resolving_flag": "pick extend / rebuild / fix"
  }
}
```

Parse the JSON, surface the question to the user, then re-invoke with the
disambiguating flag the user selected.

## Non-interactive mode

Set `LLM_WIKI_NO_PROMPT=1` (or pass `--no-prompt`) in CI, hooks, and any
pipeline where stdin is not a TTY. In non-interactive mode, every prompt
helper throws `NonInteractiveError` that the caller is expected to surface as
a hard CLI error. There is no "I'll pick a default because nobody is
listening" code path anywhere in the skill.

## Claude's phrasing template

When the user's request is ambiguous, reply with a short, numbered
disambiguation question. Example:

> You said "convert my docs folder to a wiki". I can do this two ways:
>
> 1. **Sibling (default, reversible)** — create `./docs.wiki/` next to
>    `./docs`. Your original folder stays untouched. Run:
>    `skill-llm-wiki build ./docs`
>
> 2. **In-place (reversible via git rollback)** — transform `./docs`
>    itself. Private git tracks the before-state so rollback is exact.
>    Run: `skill-llm-wiki build ./docs --layout-mode in-place`
>
> Which do you prefer?

Then wait for the user to pick. Do not run the skill until the intent is
explicit.
