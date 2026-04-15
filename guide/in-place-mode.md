---
id: in-place-mode
type: primary
depth_role: leaf
focus: "converting an existing folder into a wiki in place, lossless and reversible"
parents:
  - index.md
covers:
  - "--layout-mode in-place never runs without explicit user opt-in"
  - "pre-op snapshot captures every byte into the private git repo before mutation"
  - "rollback --to pre-<op-id> restores byte-exact pre-operation state"
  - "the user's own git repository is never touched, even when the wiki is inside it"
  - "wiki-local .gitignore hides our private metadata from any ancestor user repo"
  - "cannot combine with --target — the source IS the target in this mode"
tags:
  - layout
  - in-place
  - conversion
activation:
  keyword_matches:
    - in place
    - in-place
    - overwrite
    - transform my folder
    - convert this directory
    - make my docs into a wiki
  tag_matches:
    - layout
    - conversion
  escalation_from:
    - build
    - fix
---

# In-place mode

Pass `--layout-mode in-place` when the user explicitly says "transform this
folder into a wiki" or "convert my docs in place". The source folder becomes
the wiki. History lives in `<source>/.llmwiki/git/` from the first operation
onward, and every operation tags a rollback anchor before mutating.

## Safety envelope

Phase 1 of every operation (including the first build) runs `preOpSnapshot`:

1. Lazily initialise `<source>/.llmwiki/git/` if missing, commit a `genesis`
   tag of the empty tree.
2. Write `<source>/.gitignore` with the three skill-internal entries so the
   user's ancestor git repository (if any) ignores our private metadata.
3. `git add -A` — stage every file in the working tree.
4. If anything is staged, commit with message `pre-op <op-id>`.
5. Tag the commit as `pre-op/<op-id>` (loud on collision).

The `pre-op/<op-id>` tag is the rollback anchor and lives in a separate
ref namespace from the final `op/<op-id>` tag so git's ref hierarchy
never collides. Even a SIGKILL between steps 2 and 5 leaves the tag from
the previous operation reachable. Rollback is:

```text
skill-llm-wiki rollback <source> --to pre-<op-id>
```

This runs `git reset --hard <tag> && git clean -fd` against the private repo,
returning the working tree to byte-identical pre-operation state. `.work/` and
`.shape/history/*/work/` are preserved through rollback (protected by
`.llmwiki/git/info/exclude`); every other untracked change is wiped.

## When to choose in-place vs sibling

Ask the user if the request is ambiguous. Do not guess. Typical signals:

| User says | Mode |
|-----------|------|
| "build a wiki from my docs" | sibling (default `<source>.wiki/`) |
| "convert my docs to a wiki" | **ask** — could mean either |
| "transform this folder in place" | in-place |
| "overwrite ./docs with a wiki structure" | in-place |
| "I want the wiki files alongside ./docs" | sibling |
| "put it in my memory folder" | hosted with `--target ./memory` |

When ambiguous, Claude should say something like: "I can either build a new
`./docs.wiki/` sibling (default, reversible, leaves `./docs` untouched) or
transform `./docs` itself with `--layout-mode in-place` (reversible via git
rollback). Which do you prefer?"

## Coexistence with a user git repository

If the user's source folder is already tracked by their own git repo, the
first in-place operation writes `.gitignore` with `.llmwiki/`, `.work/`,
`.shape/history/*/work/`. The user's git sees those paths as ignored. Our
private repo's operations never touch the user's `.git/` — see
[guide/coexistence.md](coexistence.md) for the full coexistence story and
proof-of-isolation tests.
