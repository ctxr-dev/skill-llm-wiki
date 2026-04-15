---
id: coexistence
type: primary
depth_role: leaf
focus: "coexistence with the user's own git repository — private git stays isolated"
parents:
  - index.md
covers:
  - "the skill spawns git only from scripts/lib/git.mjs with a fixed isolation env"
  - "wiki-local .gitignore hides .llmwiki/ .work/ .shape/history/*/work/ from ancestor user git"
  - "operations inside a hostile user repo (hooks, signing, custom hooksPath) are unaffected"
  - "user can still commit wiki content (index.md, leaves, prose) into their own project"
  - "tests/e2e/git-isolation.test.mjs is the load-bearing proof"
  - "user's .git HEAD, reflog, and on-disk metadata must be byte-identical after every operation"
tags:
  - coexistence
  - isolation
  - user-repo
activation:
  keyword_matches:
    - my repo
    - user repo
    - gitignore
    - project git
    - already in git
    - my git
    - inside a git repository
  tag_matches:
    - coexistence
    - layout
  escalation_from:
    - build
    - extend
    - rebuild
    - fix
---

# Coexistence with the user's git repository

Users will run this skill against folders that already live inside their own
git repositories. The skill's private git repo at `<wiki>/.llmwiki/git/` must
never leak into the user's repo, and the user's repo must never leak into
ours. Both are invariants enforced at the single `scripts/lib/git.mjs` choke
point.

## The isolation env

Every git subprocess spawns with a fixed environment block that overrides
every possible leak surface:

```text
GIT_DIR              = <wiki>/.llmwiki/git
GIT_WORK_TREE        = <wiki>
GIT_CONFIG_NOSYSTEM  = 1                 (ignore /etc/gitconfig)
GIT_CONFIG_GLOBAL    = /dev/null (or NUL on Windows)
HOME                 = os.tmpdir()       (ignore ~/.gitconfig hooks/keys)
GIT_TERMINAL_PROMPT  = 0                 (never prompt for creds)
GIT_OPTIONAL_LOCKS   = 0                 (don't race background index)
GIT_AUTHOR_NAME      = skill-llm-wiki
GIT_AUTHOR_EMAIL     = noreply@skill-llm-wiki.invalid
GIT_COMMITTER_NAME   = skill-llm-wiki
GIT_COMMITTER_EMAIL  = noreply@skill-llm-wiki.invalid
```

Plus these per-invocation `-c` flags on every command:

```text
commit.gpgsign=false
tag.gpgsign=false
core.hooksPath=/dev/null
core.autocrlf=false
core.fileMode=false
core.longpaths=true
```

These values are set per-subprocess only; `process.env` is never mutated, and
nothing about the user's shell changes.

## The wiki-local `.gitignore`

On the first operation against any wiki, the skill writes `<wiki>/.gitignore`
containing:

```gitignore
# skill-llm-wiki internal metadata — safe to gitignore in your own project
.llmwiki/
.work/
.shape/history/*/work/
```

This file is itself a normal wiki file — the user can commit it to their own
git repository. Its purpose is to make any ancestor git repo treat the
private metadata as ignored without requiring the user to edit their own
`.gitignore`. `ensureWikiGitignore` is idempotent and will only append
missing entries to a pre-existing `.gitignore`, never duplicate.

## What the user can commit to their own repo

- Every plain text file the wiki produces (`index.md`, leaves, prose,
  `.gitignore`). These are normal source files.
- Not: `.llmwiki/`, `.work/`, `.shape/history/*/work/`. The wiki-local
  `.gitignore` hides them by default.

## Hostile user config does not break us

The isolation env block neutralises every form of user-side customisation
we might trip over:

- Pre-commit hooks under `.git/hooks/` or a custom `core.hooksPath` — disabled
  by `core.hooksPath=/dev/null`.
- Required signing (`commit.gpgsign`, `tag.gpgsign`, `user.signingkey`) —
  disabled by our own `-c` flags.
- Hostile `~/.gitconfig` — ignored by `GIT_CONFIG_GLOBAL=/dev/null` plus
  `HOME=tmpdir()`.
- `/etc/gitconfig` — ignored by `GIT_CONFIG_NOSYSTEM=1`.

The load-bearing proof is `tests/e2e/git-isolation.test.mjs`. It runs the
skill inside three synthetic user repos (plain, hostile-hook + required
signing, hostile-`HOME`) and asserts after every operation:

- `.git/` is byte-identical
- `git rev-parse HEAD` is unchanged
- `git reflog` is unchanged
- Any sentinel file the hostile hook would write does not exist

## Asking before writing inside a user repo

When the user invokes `build` on a folder that is inside their own git repo
and has uncommitted changes, the skill refuses (**INT-08**) and asks whether
to `--accept-dirty`, commit/stash first, or abort. Never guess.
