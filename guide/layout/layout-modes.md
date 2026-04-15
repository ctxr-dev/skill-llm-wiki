---
id: layout-modes
type: primary
depth_role: leaf
focus: "choosing between sibling (default), in-place, and hosted layout modes"
parents:
  - index.md
covers:
  - "sibling mode writes to <source>.wiki/ by default; no version-numbered folders"
  - "in-place mode transforms the user's source folder itself; requires explicit opt-in"
  - hosted mode writes under a pre-declared .llmwiki.layout.yaml contract at --target
  - "private git repo at <wiki>/.llmwiki/git/ carries history and rollback anchors across all modes"
  - "sibling default collision handling refuses on INT-01 / INT-03 rather than guessing"
  - "legacy <source>.llmwiki.v<N>/ is detected via INT-04 and requires explicit migrate"
tags:
  - layout
  - operation
activation:
  keyword_matches:
    - layout
    - mode
    - sibling
    - in-place
    - in place
    - hosted
    - .wiki
    - target folder
    - default
  tag_matches:
    - layout
    - any-op
  escalation_from:
    - build
    - extend
    - rebuild
    - fix
source:
  origin: file
  path: layout-modes.md
  hash: "sha256:5514b435d94710045b2669167f617ed641bd8697ce3300420078c39f2f27f02e"
---

# Layout modes

Every top-level operation (build / extend / rebuild / fix / join) accepts
`--layout-mode <sibling|in-place|hosted>`. The default is **sibling**. Pick the
mode that matches the user's stated intent — never guess.

## Sibling (default)

Writes to a sibling directory named `<source>.wiki/` next to the source.

- `build ./docs` → creates `./docs.wiki/`
- History lives in `./docs.wiki/.llmwiki/git/`, not in separate versioned folders
- No `<source>.llmwiki.v1/`, `.v2/`, etc. anywhere
- Safe to re-run: second `build ./docs` exits with **INT-03** and prompts for
  `rebuild` / `extend` / `fix` instead of silently overwriting

Use when: the user says "build a wiki from my docs folder" without specifying
a target. This is the default because it is the cheapest reversible outcome
— the source is untouched and the wiki is visibly separate.

## In-place

Transforms the source folder itself into a wiki. The private git repo lives
at `<source>/.llmwiki/git/`, the pre-op snapshot captures every byte, and
`rollback --to pre-<op-id>` restores byte-exact state.

- Must be opted into with `--layout-mode in-place`
- Cannot be combined with `--target` (triggers **INT-09a**)
- First run creates `<source>/.gitignore` so an ancestor user git repo ignores
  the private metadata

Use when: the user explicitly says "convert my docs folder in place", "transform
this directory", or "I want the wiki files where my docs are". If the user
says merely "convert", **ask** whether they mean sibling or in-place before
running.

## Hosted

Writes under a pre-existing `.llmwiki.layout.yaml` contract at `--target <path>`.
The contract defines where entries live, what naming conventions apply, and
any site-specific rules. Use this when the wiki has a fixed home (like
`./memory/knowledge/`) and the user wants the skill to respect that layout.

- Requires both `--layout-mode hosted` and `--target <path>`. Missing
  `--target` triggers **INT-09b**; a non-empty target without a layout
  contract triggers **INT-01b** (override with `--accept-foreign-target`
  only after confirming with the user).
- The target must carry a `.llmwiki.layout.yaml` contract **or** be a fresh
  directory the first operation will initialise

## Collision handling

The CLI refuses to guess when the layout is ambiguous:

| Code | Situation | Resolving flag |
|------|-----------|----------------|
| INT-01 | Default sibling target exists as a foreign directory | `--target <other>` or `--layout-mode in-place` |
| INT-01b | Explicit `--target` is a non-empty foreign directory | `--target <other>` or `--accept-foreign-target` |
| INT-02 | Source is already a managed wiki | pick `extend` / `rebuild` / `fix`, or `build --layout-mode in-place` |
| INT-03 | Default sibling target is already a managed wiki | pick `extend` / `rebuild` / `fix` |
| INT-04 | Source is a legacy `<name>.llmwiki.v<N>` folder | `skill-llm-wiki migrate <legacy>` |

For each code the CLI prints numbered options; Claude surfaces those to the
user verbatim so the human makes the call.

## Legacy migration

Pre–Phase 2 wikis used the naming convention `<source>.llmwiki.v1/`, `.v2/`, ...
The skill no longer uses that pattern. When the skill detects a legacy folder
it refuses every operation (INT-04) and prompts for `skill-llm-wiki migrate`,
which copies the latest version's content into the new `<source>.wiki/`
sibling, initialises the private git repo, and records the migration lineage
in `.llmwiki/op-log.yaml`. The legacy folder is left byte-identical on disk.
