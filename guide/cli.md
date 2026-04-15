---
id: cli
type: primary
depth_role: leaf
focus: "complete CLI subcommand reference for scripts/cli.mjs"
parents:
  - index.md
covers:
  - "top-level operations: build, extend, validate, rebuild (+ --review), fix, join"
  - "rollback and migrate: reversible history, legacy .llmwiki.vN auto-migration"
  - "hidden-git plumbing: log (+ --op), show, diff (+ --op), blame, reflog, history"
  - "remote mirroring: remote add/list/remove, sync with tag-only default refspec"
  - "layout mode flags (--layout-mode sibling|in-place|hosted, --target)"
  - "tiered-AI flags (--quality-mode tiered-fast|claude-first|tier0-only)"
  - "UX flags (--no-prompt, --json-errors, --accept-dirty, --accept-foreign-target, --review)"
  - "internal helpers: ingest, draft-leaf, draft-category, index-rebuild, index-rebuild-one, shape-check"
  - "exit code summary (0 ok, 1 usage, 2 validation/ambiguity/review-abort, 3 resolve miss, 4 node too old, 5 git missing/too old, 6 wiki corrupt, 7 NEEDS_TIER2 suspend-and-resume, 8 DEPS_MISSING runtime dependency missing)"
tags:
  - cli
  - commands
  - reference
activation:
  keyword_matches:
    - cli
    - command
    - subcommand
    - build
    - extend
    - rebuild
    - fix
    - join
    - validate
    - rollback
    - migrate
    - diff
    - log
    - show
    - blame
    - reflog
    - history
    - remote
    - sync
    - ingest
    - shape-check
    - index-rebuild
    - draft-leaf
  tag_matches:
    - any-op
  escalation_from:
    - build
    - extend
    - validate
    - rebuild
    - fix
    - join
source:
  origin: file
  path: cli.md
  hash: "sha256:d26a2c5e19a7257aa7febd2f04f26db8df89debf44e7ea20a9be0db9136c7f7c"
---


# CLI subcommand reference

All subcommands are invoked via `node scripts/cli.mjs <subcommand> [args]`. Never read the source of any `.mjs` file — everything you need is documented here.

The CLI exits with code **4** if invoked on Node.js < 18.0.0, code **5** if git is missing or older than 2.25, and code **6** if an existing wiki's private repo is corrupt (fsck failure). These are defence-in-depth runtime guards — always run the Bash preflight from SKILL.md first so the user sees the detailed, actionable message.

All git invocations run under the isolation env (see `guide/coexistence.md`): no hooks, no system config, no global config, no GPG signing, no askpass. Remote URLs in every echoed line and error message are redacted via `redactUrl`.

## Top-level operations

Every top-level operation resolves its intent via `scripts/lib/intent.mjs` and may refuse with an `INT-NN` structured error if the invocation is ambiguous (see `guide/user-intent.md`). All accept the layout-mode / tiered-AI / UX flags documented at the bottom of this file.

### `build <source> [--layout-mode <mode>] [--target <path>]`

Create a new wiki from a source corpus.

- **Default** — writes to a sibling `<source>.wiki/`. Initialises `.llmwiki/git/` on first use, takes a `pre-op/<op-id>` snapshot, runs ingest → draft-frontmatter → operator-convergence → index-generation → validation → commit-finalize, tags `op/<op-id>`.
- `--layout-mode in-place` — transforms `<source>/` itself; `pre-op/<op-id>` captures the original content byte-for-byte so the operation is reversible via `rollback`.
- `--layout-mode hosted --target <path>` — writes under a user-chosen path that has a `.llmwiki.layout.yaml` contract.
- **Exit codes:** 0 on success; 2 on intent ambiguity or validation failure; 6 on wiki-corrupt preflight.

### `extend <wiki> <source> [flags]`

Add a new source corpus to an existing wiki. The wiki keeps its layout mode; `extend` appends commits under a new `op/<op-id>` tag.

### `validate <wiki>`

Run all hard invariants against a wiki. Read-only. Prints one `[TAG] CODE target` line per finding plus a `N error(s), M warning(s)` summary.

- **Exit codes:** 0 if clean, 2 if any errors, 6 if the private git is corrupt.
- **Invariants:** see `guide/invariants.md`. `GIT-01` and `LOSS-01` are guarded on the presence of `.llmwiki/git/HEAD` and `.llmwiki/provenance.yaml` respectively.

### `rebuild <wiki> [--review]`

Re-run operator convergence on an existing wiki to optimise for token-efficiency. Same phase pipeline as build.

- `--review` — between operator convergence and validation, print `git diff --stat pre-op/<id>..HEAD` and the per-iteration commit list; prompt the user for approve / abort / `drop:<sha>`. Drops become `git revert --no-edit` commits and the loop re-prompts so the user can drop multiple iterations before approving. Requires a TTY; non-interactive sessions fall through with `outcome: "non-interactive"` and no changes.
- **Abort** resets the working tree to `pre-op/<id>` and exits with code 2.

### `fix <wiki>`

Repair methodology divergences detected by `validate` / `shape-check`. AUTO-class fixes are deterministic; AI-ASSIST fixes ask Claude at session-time to draft content; HUMAN-class divergences surface as structured prompts for the user to resolve. *(Currently a minimal build-forward stub; full fix pipeline — with a dedicated INT error code for HUMAN-class findings — is future work. Today, HUMAN findings are raised as plain validation errors and the user reruns fix after correcting the upstream cause.)*

### `join <target> <wiki-a> <wiki-b> [<wiki-c> …]`

Merge two or more wikis into one unified wiki at `<target>`. Requires an explicit canonical designation (multi-source `join` without ordering raises `INT-07`). *(Currently a stub; full join pipeline is future work.)*

### `rollback <wiki> --to <ref>`

Restore the wiki's working tree to a prior commit, destructively (`git reset --hard` + `git clean -fd`). Never touches the private git metadata.

- `<ref>` accepts: `<op-id>` (state after that op finished), `pre-<op-id>` (state before that op started — maps to the `pre-op/<op-id>` tag), `genesis` (the very first tracked state), or any git ref expression (`HEAD~2`, etc).
- Refs starting with `-` or containing control characters are refused at the boundary (security D2 guard).
- **Exit codes:** 0 on success; 2 if the ref cannot be parsed or does not exist.

### `migrate <legacy-wiki>`

Convert a pre-Phase-2 `<source>.llmwiki.v<N>/` wiki to the new `<source>.wiki/` layout. Copies the directory's content into the new sibling, initialises `.llmwiki/git/`, commits as genesis, and tags `op/<opId>`. The legacy directory is left untouched; the user prunes it manually later. Always prompts before proceeding (`INT-04`).

## Hidden-git plumbing

Read-only introspection subcommands that run `git` under the isolation env against the wiki's private repo. Claude uses these when the user asks "what changed", "when did this break", "why was this split".

### `log <wiki> [--op <id>] [git-log-args…]`

`git log` passthrough. Default output is `--oneline --decorate --all`.

- `--op <id>` narrows the range to `pre-op/<id>..op/<id>` (or `pre-op/<id>..HEAD` for an in-flight operation), matching `diff --op` sugar.
- Additional git-log args pass through (`-p`, `-n`, `--format=%H`, etc.).
- **Exit codes:** 0 on success, 2 if `--op` names a non-existent pre-op tag.

### `show <wiki> <ref> [-- <path>]`

`git show` passthrough. Display the contents of a commit, tree, blob, or tag.

### `diff <wiki> [--op <id>] [git-diff-args…]`

`git diff` passthrough. The wrapper adds `--find-renames --find-copies` by default so rename/copy detection is on (this means the output is byte-identical to `git diff --find-renames --find-copies`, not to a plain `git diff`).

- `--op <id>` expands to `pre-op/<id>..op/<id>` (or `pre-op/<id>..HEAD`).
- Additional git-diff args pass through (`--stat`, `--name-status`, `--patch`, etc.).

### `blame <wiki> <path> [git-blame-args…]`

`git blame` passthrough for line-level attribution.

### `reflog <wiki> [git-reflog-args…]`

`git reflog` passthrough. Surfaces even aborted operations — crucial for debugging a Build that crashed mid-convergence.

### `history <wiki> <entry-id>`

Higher-level wrapper: walks `<wiki>/.llmwiki/op-log.yaml` for op-level references to the entry, then runs `git log --oneline --follow` on any file matching `**/<entry-id>.md` to catch renames across operations. Produces a two-section report.

## Remote mirroring

Optional: push the private git's tag history to a bare remote the user manages. The skill never auto-pushes; `sync` is always explicit.

### `remote <wiki> add <name> <url>`

Configure a remote. The URL is redacted on both the success line and any error message (security B3).

### `remote <wiki> list`

List configured remotes as `name\tfetch-url\tpush-url`. URLs redacted.

### `remote <wiki> remove <name>`

Delete a configured remote.

### `sync <wiki> [--remote <name>] [--push-branch <branch>] [--skip-fetch] [--skip-push]`

Fetch tags from the remote (read side), then push the private repo's `op/*` and `pre-op/*` tags (write side). Default push refspec is tag-only so the remote is a read-only history mirror rather than a competing branch HEAD.

- `--remote <name>` — which configured remote to talk to (default `origin`).
- `--push-branch <branch>` — additionally push `refs/heads/<branch>`. Validated against `^[A-Za-z0-9][A-Za-z0-9._/-]*$` to block refspec injection (security D7).
- `--skip-fetch` / `--skip-push` — one-sided sync.

## Internal helpers

These are called by orchestrated phases; users rarely invoke them directly. Documented for completeness.

### `ingest <source>`

Walks a source directory, computes content hashes, emits an array of entry candidates.

- **Output (stdout, JSON):** `{ "candidates": [ {id, source_path, absolute_path, ext, size, hash, kind, title, lead, headings}, … ] }`.
- **Determinism:** walk order is sorted by path; symlinks are dropped (directories and files only).

### `draft-leaf <candidate-file>`

Script-first frontmatter draft for a single candidate.

- **Output (stdout, JSON):** `{ "data": <frontmatter-object>, "confidence": <0..1>, "needs_ai": <boolean> }`.

### `draft-category <candidate-file>`

Deterministic category hint by directory prefix.

### `index-rebuild <wiki>`

Regenerate every `index.md` in a wiki, bottom-up. Preserves authored frontmatter fields and authored body content; replaces derived fields and the auto-generated navigation zone.

### `index-rebuild-one <dir> <wiki>`

Rebuild a single directory's `index.md`.

### `shape-check <wiki>`

Detect operator candidates and write findings to `<wiki>/.shape/suggestions.md`. Never touches the private git (the hook-mode path has an explicit no-git contract).

### Legacy `.llmwiki.vN` helpers

These subcommands survived the Phase 2 migration for backward compatibility with pre-Phase-2 wikis that still use the versioned-sibling naming. New wikis should not use them.

- `resolve-wiki <source>` — print current live wiki path for a legacy source. Exit 3 if none exists.
- `next-version <source>` — print the next version tag (e.g. `v3`).
- `list-versions <source>` — print `<tag>\t<absolute-path>` per existing version.
- `set-current <source> <version>` — update the current-pointer file.

## Layout mode flags

All top-level operations accept:

- `--layout-mode sibling|in-place|hosted` — select layout mode. Default `sibling`. Unknown values raise `INT-10`.
- `--target <path>` — explicit destination. Required for `hosted` mode; raises `INT-09a` if combined with `in-place`, `INT-09b` if missing for `hosted`.
- `--accept-foreign-target` — deliberate override to write into a non-empty non-skill-managed directory (escape hatch for `INT-01b`).

## Tiered-AI flags

- `--quality-mode tiered-fast|claude-first|tier0-only` — select the escalation policy. Default `tiered-fast` (TF-IDF → MiniLM embeddings → Claude). `tier0-only` never calls Claude, never loads Tier 1; mid-band pairs become "undecidable" markers the user resolves interactively. Unknown values raise `INT-13`.

## UX flags

- `--no-prompt` / env `LLM_WIKI_NO_PROMPT=1` — fail loudly on any ambiguity instead of prompting; emits `INT-12` if the skill would otherwise ask a TTY question.
- `--json-errors` — emit `INT-NN` ambiguity errors as JSON on stderr instead of numbered-options text.
- `--accept-dirty` — operate on a source inside a dirty user git repo (escape hatch for `INT-08`).
- `--review` — enable the `rebuild` interactive review cycle. See `guide/operations/rebuild.md`.

## `--version` / `--help`

Print the CLI version string or a condensed command list.

## Exit code summary

- **0** — success
- **1** — usage error (missing/bad arguments, unknown subcommand)
- **2** — validation errors, intent ambiguity (`INT-NN`), review abort, or a malformed rollback ref
- **3** — legacy `resolve-wiki` could not find a wiki for the given source
- **4** — Node.js is present but below the required minimum (defence-in-depth runtime guard)
- **5** — `git` binary missing or older than 2.25 (preflight)
- **6** — existing wiki's private git is corrupt (`git fsck` failed during preflight)
- **7** — `NEEDS_TIER2` — the operator-convergence phase accumulated Tier 2 requests (cluster naming, mid-band merge decisions, …) that must be resolved by the wiki-runner sub-agent before the operation can continue. **Exit 7 is NOT a failure.** It is the suspend-and-resume signal of the Tier 2 exit-7 handshake. The CLI writes every pending batch to `<wiki>/.work/tier2/pending-<batch-id>.json` before exiting; the wiki-runner spawns one `Agent` sub-agent per request, writes responses to `<wiki>/.work/tier2/responses-<batch-id>.json` next to the pending file, and re-invokes the CLI with the same positional args. See `guide/tiered-ai.md` "The exit-7 handshake" for details.
- **8** — `DEPS_MISSING` — a required runtime dependency (`gray-matter` or `@xenova/transformers`) could not be resolved from the skill's `node_modules/` and the install attempt was either declined (interactive `[Y/n]` answered `n`) or failed (`npm install` non-zero exit, or the deps were still missing after a successful install). The dependency preflight runs at the start of every subcommand except `--version` and `--help`; in non-interactive sessions (`!process.stdin.isTTY` or `LLM_WIKI_NO_PROMPT=1`) it attempts `npm install --silent` automatically before giving up. See `guide/ux/preflight.md` Case E for the full user-facing message and recovery steps.
