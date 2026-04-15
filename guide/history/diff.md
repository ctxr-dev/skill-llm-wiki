---
id: diff
type: primary
depth_role: leaf
focus: the diff subcommand — git-style file-level changes for any operation
parents:
  - index.md
covers:
  - "skill-llm-wiki diff <wiki> runs git diff --find-renames --find-copies under the isolation env"
  - "--op <id> expands to pre-op/<id>..op/<id> so you can see exactly what an operation changed"
  - without --op, shows unstaged working-tree changes since the last commit
  - "all remaining args pass through to git diff unchanged (--stat, --name-status, -M, --patch, etc.)"
  - "tag namespace: pre-op/<id> is the pre-op anchor, op/<id> is the finalised commit"
  - rename detection is on by default — no need to pass -M explicitly
tags:
  - history
  - diff
activation:
  keyword_matches:
    - diff
    - changes
    - what changed
    - renamed
    - moved
    - review
    - "--stat"
    - "--name-status"
  tag_matches:
    - history
  escalation_from:
    - log
    - show
    - rebuild
    - rollback
source:
  origin: file
  path: diff.md
  hash: "sha256:48b6d8002c7dc53ec81a57505d8efa15599d19c7010c7e67841a62a0406f4a82"
---

# `skill-llm-wiki diff`

A thin wrapper around `git diff` in the wiki's private repo. The
wrapper adds two things:

1. **Rename detection is on by default.** Every invocation passes
   `--find-renames --find-copies`, so operator moves (NEST / LIFT /
   MERGE) show up as rename edges in `--stat` and `--name-status`.
2. **`--op <id>` expands to a commit range.** If you pass
   `--op build-20260414-abc123`, the wrapper resolves that to
   `pre-op/build-20260414-abc123..op/build-20260414-abc123` — exactly
   the range that covers what the operation did. If the operation did
   not complete (validation failure rolled back), the range is
   `pre-op/<id>..HEAD` instead.

## Common invocations

```text
# What did the last operation do, file-by-file?
skill-llm-wiki diff <wiki> --op <last-op-id> --stat

# Name-status view with rename letters (R100 = 100% rename, M = modified):
skill-llm-wiki diff <wiki> --op <last-op-id> --name-status

# Full patch of a specific entry across an operation:
skill-llm-wiki diff <wiki> --op <last-op-id> -- <path/to/entry.md>

# Compare two operations directly:
skill-llm-wiki diff <wiki> op/<first-op-id>..op/<second-op-id> --stat

# What's dirty in the working tree right now?
skill-llm-wiki diff <wiki>
```

## Rename detection in practice

When a NEST operator extracts an H2 section into its own leaf, the
original file is rewritten and a new file appears. Git's rename
detector (`-M`, `-C`) will report this as a pair with similarity
percentage:

```text
R087  old/entry.md  →  new/extracted-section.md
M     old/entry.md
```

A percentage ≥ 50 on `R` is git's default threshold for "this is a
rename". If the operator reshaped the content heavily, the percentage
drops and git shows it as `add` + `delete` instead — still informative,
just less condensed.

## Scale note

On a multi-megabyte wiki, `diff --op <id>` remains cheap because git
diffs are computed at the object layer, not the working-tree layer.
Even when the operation touches thousands of files, `--stat` runs in
tens of milliseconds. For `--patch` output on a huge op, pipe through
a pager or narrow with a path argument.

## What this does NOT do

- Run against the user's own git repo. `<wiki>` is always the skill's
  private repo rooted at `<wiki>/.llmwiki/git/`.
- Show logical diffs (e.g. "this entry's covers[] grew by 3 items").
  For that, parse the frontmatter yourself via `scripts/lib/frontmatter.mjs`
  or walk the index.md tables via `scripts/lib/indices.mjs`.
- Replace `log` or `history`. Use `log` to see the commit sequence,
  `history <entry-id>` to trace one entry's lineage across op-log
  entries, and `diff` to see file-level changes within one op or
  between two ops.
