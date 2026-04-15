---
id: remote-sync
type: primary
depth_role: leaf
focus: "remote mirroring — sharing the private wiki git history across machines"
parents:
  - index.md
covers:
  - "remote add registers a URL in the private repo's config — no fetch, no auth"
  - "sync is the only path that exchanges objects with a remote and is always user-invoked"
  - "push refspec defaults to refs/tags/op/* and refs/tags/pre-op/* — history mirror only"
  - "branch heads are never pushed unless --push-branch is passed explicitly"
  - "--skip-fetch and --skip-push narrow the sync to a single direction"
  - "regular operations (build, rebuild, fix, join) never auto-push"
  - "the isolation env block applies to remote subprocess calls too"
tags:
  - remote
  - collaboration
  - sync
activation:
  keyword_matches:
    - remote
    - sync
    - share
    - push history
    - backup
    - mirror
    - across machines
  tag_matches:
    - remote
    - collaboration
  escalation_from:
    - build
    - rebuild
    - diff
---

# Remote mirroring

Phase 7 adds a narrow remote-sharing capability so the private wiki
git history can be mirrored across machines. Two subcommands:

```text
skill-llm-wiki remote <wiki> add <name> <url>
skill-llm-wiki remote <wiki> remove <name>
skill-llm-wiki remote <wiki> list

skill-llm-wiki sync <wiki> [--remote <name>]
                           [--push-branch <ref>]
                           [--skip-fetch] [--skip-push]
```

Both commands run through the same isolation env block as every
other git operation — the user's `~/.gitconfig`, signing keys,
hooks, and push templates are NOT consulted. Authentication must
flow via the URL itself (`https://token@host/...`) or via an
out-of-band credential helper the user configures explicitly.

## Never auto-push

The skill never pushes to a remote on its own. `remote add` only
records the URL in the private repo's config — nothing is fetched,
pushed, or authenticated at registration time. `sync` is the ONLY
path that exchanges objects with a remote, and it is always a
user-invoked action. Regular operations (`build`, `rebuild`,
`fix`, `join`) never trigger a sync.

## Default push is a history mirror

`sync` pushes the refspecs `refs/tags/op/*` and `refs/tags/pre-op/*`
by default. A shared remote becomes a **read-only history mirror**
— every op's pre- and final tags are visible for post-mortem
inspection, but there's no competing `main` branch head that a
second user could push to and diverge.

If the user genuinely wants a branch pushed (e.g., to share the
working tree between machines), they pass `--push-branch <name>`
and the sync adds `refs/heads/<name>` to the refspec list. This is
an explicit opt-in; the skill never advertises it as normal usage.

## Common sessions

```text
# First time: register the remote, then push.
skill-llm-wiki remote ./docs.wiki add origin /srv/wikis/docs.git
skill-llm-wiki sync ./docs.wiki

# Later: pull history from a teammate's push.
skill-llm-wiki sync ./docs.wiki --skip-push

# Fetch-only variant that never modifies the remote.
skill-llm-wiki sync ./docs.wiki --remote teammate --skip-push
```

## What this does NOT do

- Discover remotes automatically. Every remote is registered
  explicitly via `remote add`.
- Prompt for credentials. `GIT_TERMINAL_PROMPT=0` is set at the
  base-isolation layer; any remote that needs credentials must
  supply them via URL or an existing git credential helper.
- Merge divergent histories. `sync` uses tag-only refspecs by
  default; a tag that already exists on the remote with a
  different sha is a push rejection, not a silent overwrite. The
  user fixes it manually.
- Rewrite history. Force-push is not exposed via the CLI. A user
  who needs it invokes `git push --force` directly with the
  explicit `GIT_DIR`/`GIT_WORK_TREE` env vars.
- Auto-sync on a schedule. Every sync is a conscious action.
