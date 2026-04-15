---
id: hidden-git
type: primary
depth_role: leaf
focus: "how Claude leverages the wiki's private git repo for history, blame, diff, and rollback"
parents:
  - index.md
covers:
  - "every wiki has a private git repo at <wiki>/.llmwiki/git/ with the full isolation env"
  - "per-phase commits give granular history (snapshot, ingest, draft-frontmatter, ..., commit-finalize)"
  - "tags: op/<id> marks the finalised operation, pre-op/<id> marks the rollback anchor"
  - "skill-llm-wiki log/show/diff/blame/reflog/history all pass through to git safely"
  - "diff --op <id> expands to pre-op/<id>..op/<id> with --find-renames --find-copies"
  - "history <entry-id> walks op-log.yaml plus git log --follow for a single entry"
  - "use these tools to answer 'why was this split?', 'when did this break?', 'what changed in op X?'"
tags:
  - history
  - git
activation:
  keyword_matches:
    - history
    - what changed
    - previous state
    - why was this split
    - diff
    - log
    - blame
    - bisect
    - reflog
    - prior op
    - show
  tag_matches:
    - history
  escalation_from:
    - build
    - rebuild
    - fix
    - diff
source:
  origin: file
  path: hidden-git.md
  hash: "sha256:5e1bfab79abdff4dd883cb5ec5107367061feb426774e8b288069e146750666d"
---

# The hidden git repo is a first-class tool

<!--
  NOTE on the `bisect` activation keyword: the skill does NOT ship a
  `skill-llm-wiki bisect` subcommand. The keyword is retained so that
  a user asking "can I bisect my wiki history?" routes into this leaf,
  where Claude can explain how to use `log` / `diff` / `history` to
  achieve the same result, or (if the user is comfortable) how to
  drive `git bisect` directly against the isolated `<wiki>/.llmwiki/git/`
  repo with the skill's isolation env exported. Removing the keyword
  would route such questions nowhere.
-->

Every skill-managed wiki owns a private git repository at
`<wiki>/.llmwiki/git/`. It is NOT the user's project git repo — it is
strictly ours, hosted inside the wiki, reachable only through the
`scripts/lib/git.mjs` isolation env. Claude should treat it as a
first-class reasoning tool, not an implementation detail.

## Tag layout

Two namespaces, intentionally split to avoid git ref hierarchy
collisions:

- `refs/tags/pre-op/<op-id>` — the snapshot taken immediately before
  the operation started. Rollback anchor. Guaranteed to exist for every
  op the orchestrator ever ran, including interrupted and failed ones.
- `refs/tags/op/<op-id>` — the final commit of a successful operation.
  Absent when the operation failed mid-flight (use the reflog instead).
- `op/genesis` — the empty initial tree, created on first `gitInit`.

## The subcommands

Every subcommand takes `<wiki>` as its first positional and passes the
rest through to git under the isolation env.

| Subcommand | Default behaviour | Typical use |
|------------|-------------------|-------------|
| `log <wiki>` | `git log --oneline --decorate --all` | "Show me the operation history" |
| `show <wiki> <ref>` | `git show <ref>` | "What did op X look like?" |
| `diff <wiki>` | `git diff --find-renames --find-copies` | "What changed since the last commit?" |
| `diff <wiki> --op <id>` | Expands to `pre-op/<id>..op/<id>` | "What did operation X do?" |
| `blame <wiki> <path>` | `git blame <path>` | "Who introduced this line?" |
| `reflog <wiki>` | `git reflog` | "What happened during that crashed build?" |
| `history <wiki> <entry-id>` | op-log + `git log --follow` | "When was this entry last changed, and why?" |

## Example: answering "why was this entry merged?"

1. `history <wiki> entry-a` — see which ops touched it.
2. `log <wiki> --follow -- <path/to/entry-a.md>` — see the git commits.
3. `show <wiki> <commit>` — read the diff of the specific commit.
4. If the decision came from an operator application (Phase 6 lands
   this), `<wiki>/.llmwiki/decisions.yaml` records tier/confidence.

## Example: answering "what did the last rebuild do?"

```
skill-llm-wiki log <wiki> --oneline | head
skill-llm-wiki diff <wiki> --op <rebuild-op-id> --stat
```

The first shows the commit graph; the second shows the file-level
changes with rename detection.

## Rollback

Rollback is a separate subcommand (`skill-llm-wiki rollback <wiki>
--to <ref>`) that runs `git reset --hard` + `git clean -fd` in the
private repo. It accepts:

- `genesis` — the original empty tree
- `<op-id>` — the state right after op X finished
- `pre-<op-id>` — the state right before op X started
- `HEAD`, `HEAD~N` — direct git refs

Validation failure already triggers automatic rollback to
`pre-op/<failed-op-id>`, so manual rollback is for the "I changed my
mind" case, not the crash-recovery case.

## What the skill never does

- Touch the user's own `.git/`
- Run any git command outside the isolation env in `scripts/lib/git.mjs`
- Push, fetch, or otherwise talk to a remote (Phase 7 adds optional
  remote mirroring under explicit user control)
- Run hooks — `core.hooksPath=/dev/null` disables every hook source
