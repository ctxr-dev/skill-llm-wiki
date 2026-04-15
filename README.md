# skill-llm-wiki — Structured knowledge that your AI can actually use

[![npm](https://img.shields.io/npm/v/@ctxr/skill-llm-wiki)](https://www.npmjs.com/package/@ctxr/skill-llm-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://img.shields.io/badge/CI-Ubuntu%20%2B%20Windows-green)](.github/workflows/ci.yml)

> **Turn any folder of markdown, docs, or source into a deterministic, token-efficient knowledge base your AI agent reads the way you'd want it to — once, and only the parts it needs.**

## The problem every AI-heavy workflow eventually hits

You want your AI pair — Claude, Cursor, an agent loop, whatever — to *know things*. Architecture decisions. Runbooks. API contracts. Prior postmortems. Team conventions. The messy folder of `.md` notes you've been keeping for eighteen months.

So you dump it into the context window. And then you watch:

- **Token costs balloon** because every query re-reads the whole thing.
- **Answers go stale** because the AI grabbed a snippet from a doc that was deprecated three sprints ago.
- **Irrelevant context bleeds in** and your AI confidently cites something that isn't in scope for this task.
- **The folder structure drifts** because nobody has time to keep hand-maintained README indexes in sync with reality.

The fix isn't "more context window." It's **giving your AI a retrieval structure it can actually walk** — one that names what's in each subtree, routes queries to only the relevant leaves, and rewrites itself whenever the shape of the knowledge changes. That's what `skill-llm-wiki` builds.

## What you get

Point this skill at a folder. It produces an **LLM wiki**: a sibling folder of markdown files organised into a deterministic, token-efficient retrieval structure. Your AI agent reads the root index, makes a semantic routing decision based on each subcategory's `focus` string, descends only into the subtrees that match the current task, and loads exactly the leaves it needs.

The wiki is **just markdown on disk**. No database, no vector store service, no lock-in. Every file is something you can read, edit, grep, and commit to your own git. The skill adds a hierarchy, a routing grammar, and a history substrate — then gets out of the way.

**Effectiveness, measured on real corpora:**

- **~90% of retrieval decisions resolve without reaching Claude** at all. TF-IDF + local MiniLM embeddings handle the routine cases for free, on-device, with zero API cost.
- **Token cost scales with *ambiguity*, not corpus size.** A 10,000-entry wiki costs roughly the same per query as a 100-entry wiki when the ambiguity rate is comparable. Decisive decisions short-circuit the ladder.
- **Dogfooded on itself.** The skill's own operational reference (`guide/`) was rebuilt by the skill. Same content, ~24% smaller on-disk after the convergence loop picked an 8-subcategory nested structure.
- **Deterministic and reproducible.** Same source + `LLM_WIKI_FIXED_TIMESTAMP=<epoch>` → byte-identical commit and tree SHAs across runs and across machines. Your build is hermetic.
- **Novel-corpus validated.** The 45-leaf `skill-code-review` corpus builds in one convergence iteration, 13 non-conflicting NESTs applied atomically, zero orphans, `validate` returns 0 errors / 0 warnings.

## Why this matters for AI-heavy workflows

If you are building anything that involves an AI agent reading your codebase, your docs, your notes, or your decisions — you are already paying a structure tax. Either your agent re-reads too much (token bill balloons, latency climbs, context gets noisy) or it reads the wrong thing (answers drift, confidence is unjustified, debugging takes longer than writing the feature).

A well-structured LLM wiki flips that. Instead of "cram everything into the prompt and hope the model attends to the right parts," you get:

- **Routing discipline.** Your agent walks a semantic hierarchy from the root, and only loads the leaves whose `focus` string actually matches the current task. No blind full-tree reads.
- **Fresh history, not stale snapshots.** Every operation is a git commit inside a private repo under `<wiki>/.llmwiki/git/`. Roll back a bad rebuild with one command. Diff two operations. Blame a line in an index. Your AI's knowledge base is version-controlled with the same discipline as your code.
- **Rewrite operators that fire themselves.** When you add 50 new docs and the tree shape drifts, the convergence loop (DESCEND → LIFT → MERGE → NEST → DECOMPOSE) detects the drift, proposes structural changes, gates each one on a routing-cost metric, and commits the ones that objectively improve retrieval. You never have to "go fix the index table of contents" again.
- **It works on anything.** Markdown notes, product docs, API references, research dumps, runbooks, ADRs, policy libraries, source code, mixed folders, whole monorepos — the ingester doesn't care.

This skill is built for people who ship with AI and want their AI to ship better — AI vibe coders who have moved past "paste the file and pray" and want their knowledge base to compound the same way their codebase does.

## How it works (the short version)

1. **Ingest** — walk the source folder, compute content hashes, emit one candidate per file with byte-range provenance so nothing is silently dropped.
2. **Draft frontmatter** — for each entry, derive `id`, `focus`, `covers[]`, `tags`, and `parents[]` from structure where possible; Claude fills in prose-heavy cases.
3. **Layout + operator convergence** — the convergence loop applies deterministic rewrite operators (DESCEND, LIFT, MERGE, NEST, DECOMPOSE) until the tree reaches its token-minimal normal form, measured by a `routing_cost` metric. Clusters are proposed via Tier 2 sub-agents; each application is gated on whether it actually improves routing cost and rolled back otherwise.
4. **Index generation** — every directory gets an `index.md` with machine routing metadata in frontmatter and human/LLM orientation prose in the body.
5. **Validate + commit-finalize** — hard invariants (id uniqueness, DAG acyclicity, narrowing-chain consistency, byte-range loss check, private-git integrity) run before the operation is allowed to finalise. Any failure rolls back the entire operation to the pre-op snapshot.

Every phase is a git commit in the wiki's private history, so you can inspect, diff, roll back, and mirror exactly like a real repo — because it is one.

## Features at a glance

- **Git-backed history.** Every operation is a snapshot + a series of per-phase commits under an isolated private git. Rollback, diff, blame, log, reflog, and remote mirroring are first-class skill subcommands — `skill-llm-wiki diff <wiki> --op <id>` is a passthrough to `git diff --find-renames --find-copies` scoped to the op's commit range, rollback is a byte-exact `git reset --hard pre-op/<id>`, and every URL printed by the remote-sync subcommands is redacted by default.
- **Stable sibling layout.** `<source>.wiki/` is the one folder a wiki ever lives in. No more `.llmwiki.v1`/`.v2`/`.v3` directory proliferation — prior states are reachable as git tags (`pre-op/<id>`, `op/<id>`) in the private repo.
- **Three layout modes, never guessed.** `sibling` (default), `in-place` (source IS the wiki), and `hosted` (user-chosen path with a `.llmwiki.layout.yaml` contract). Ambiguous invocations refuse and prompt — see the "Ask, don't guess" rule.
- **User-repo coexistence.** An auto-generated `.gitignore` hides the private metadata from any ancestor user git. The skill's isolation env block (`GIT_DIR`, `GIT_CONFIG_NOSYSTEM`, `core.hooksPath=/dev/null`, …) keeps the two gits from leaking into each other.
- **Tiered AI strategy.** TF-IDF (free) → local MiniLM embeddings (required, ~23 MB one-time model download, zero-API) → Claude (only for mid-band ambiguity and decisions requiring natural-language judgment). `--quality-mode tiered-fast|claude-first|tier0-only` selects the escalation policy.
- **Deterministic slug collisions.** NEST operator auto-resolves slug-vs-member-id collisions with a deterministic `-group` suffix before apply. Your convergence loop never needs manual retries for DUP-ID.
- **Optional interactive review.** `skill-llm-wiki rebuild <wiki> --review` prints the post-convergence diff and commit list, lets the user approve / abort / `drop:<sha>` specific iterations, and re-runs validation + index regen on the reverted tree.
- **Windows parity.** The CI matrix runs the smoke suite on both `ubuntu-latest` and `windows-latest`; the isolation env switches `/dev/null` to `NUL` and enables `core.longpaths=true` on Windows.

Works on any corpus: markdown notes, product docs, API references, research, runbooks, architecture records, policy libraries, source code, mixed folders, whole projects.

## Quick Start

```bash
# Install into your project
npx @ctxr/kit install @ctxr/skill-llm-wiki
```

Then in Claude Code, ask for any of the six operations:

```text
Build an LLM wiki from ./docs
Add ./arch to my docs wiki
Validate my docs wiki
Rebuild my docs wiki
Fix my docs wiki
Merge my docs and runbooks wikis into a handbook
```

## Requirements

This skill has two hard requirements. If either is missing, the skill will refuse to run and print a clear message explaining why and how to fix it.

1. **[Claude Code](https://claude.ai/code) CLI or IDE extension.**
2. **Node.js ≥ 18.0.0.** The skill's deterministic CLI (`scripts/cli.mjs`) is a Node.js program, so Node must be available in the shell Claude Code uses to run Bash commands. If Node.js is missing or below the minimum version, Claude will stop the operation before making any changes and relay platform-specific install instructions.

### Verify your environment before invoking the skill

Open a terminal and run:

```bash
node --version
```

- If you see `v18.0.0` or newer → you're ready.
- If you see a version below `v18.0.0` → upgrade Node.js before using the skill.
- If you see `command not found` or similar → install Node.js before using the skill.

### Installing or upgrading Node.js

Pick the option for your platform.

**macOS (Homebrew):**

```bash
brew install node        # or: brew upgrade node
```

**macOS / Linux (nvm — recommended for dev machines):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 20
nvm use 20
```

**Linux (Debian/Ubuntu):**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Linux (RHEL/Fedora):**

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

**Windows (winget):**

```powershell
winget install OpenJS.NodeJS
```

**Windows (Chocolatey):**

```powershell
choco install nodejs-lts
```

**Any platform:** download the official installer from <https://nodejs.org/en/download/>.

After installing, open a **fresh** terminal (so the shell picks up the new `PATH`) and verify with `node --version` again.

### Two-layer safety net

The skill checks Node.js availability before running any operation so you never see cryptic failures:

1. **Preflight (Bash).** Before the first CLI invocation of every operation, Claude runs `node --version` via Bash and stops with a detailed install message if Node is missing or too old. Nothing gets mutated before this check passes.
2. **Runtime guard (Node).** `scripts/cli.mjs` re-checks `process.version` as its very first action and exits with code 4 and a short message if somehow invoked on an unsupported Node. Defense-in-depth so even a broken shell environment cannot produce a half-finished wiki.

Both checks fail **loud and early** with a clear explanation and zero side-effects. The skill is safe to point at real folders on any machine.

## Installation

### Via @ctxr/kit

```bash
npx @ctxr/kit install @ctxr/skill-llm-wiki            # project-local
npx @ctxr/kit install @ctxr/skill-llm-wiki --user     # user-global
```

Installs to `.claude/skills/ctxr-skill-llm-wiki/` (or `~/.claude/skills/…` with `--user`). No post-install wiring, no automatic hooks, no filesystem watchers — the skill is pure standby until you explicitly ask Claude to run an operation against a specific directory.

The installed package contains `SKILL.md` (the routing entry point Claude reads at activation), `LICENSE`, `README.md`, `scripts/` (invoked via `node scripts/cli.mjs <subcommand>`, never read as source), and `guide/` (context-specific routing leaves loaded on keyword activation — `hidden-git.md` when the user asks about history or diff, `user-intent.md` when the request is ambiguous, `tiered-ai.md` when the user asks about quality modes, etc.). The internal design doc `methodology.md` is deliberately excluded from the installed package (`files[]` in `package.json` does not list it) so it is never copied into any user environment and never loaded during a session.

### Manual

```bash
git clone https://github.com/ctxr-dev/skill-llm-wiki.git /tmp/skill-llm-wiki
mkdir -p .claude/skills
cp -r /tmp/skill-llm-wiki .claude/skills/skill-llm-wiki
```

### Git Submodule

```bash
git submodule add https://github.com/ctxr-dev/skill-llm-wiki.git \
    .claude/skills/skill-llm-wiki
```

## Usage

Ask Claude for any of the six operations against a specific target directory. Examples:

```text
Build an LLM wiki from ./docs
# → creates ./docs.wiki/ next to ./docs, initialises the private
#   git at ./docs.wiki/.llmwiki/git/, tags pre-op/<id> and op/<id>

Add ./arch to my docs wiki
# → extends ./docs.wiki/ in place with a new op tag

Validate ./docs.wiki
# → read-only invariant check; prints findings with severity

Rebuild ./docs.wiki --review
# → runs convergence, prints the diff + per-iteration commit list,
#   and prompts approve / abort / drop:<sha> before validation

Diff ./docs.wiki --op <op-id> --stat
# → byte-identical native `git diff --stat` against the private repo

Rollback ./docs.wiki --to pre-op/<op-id>
# → byte-exact reset to the snapshot taken before that operation

Fix ./docs.wiki
# → runs AUTO-class repairs; HUMAN-class findings surface as structured prompts for the user to resolve

Merge ./docs.wiki and ./runbooks.wiki into handbook
# → creates ./handbook.wiki/ with merged content and rewired references
```

Nothing happens until you ask. The skill performs exactly the operation you request against the target you name, then stops. Ambiguous invocations (two folders would both match, two layout modes are both compatible, a default sibling would stomp on a foreign directory, …) refuse with an `INT-NN` structured error rather than guessing — the skill's "ask, don't guess" rule is a hard contract.

## Layout modes

Every operation accepts `--layout-mode <mode>`; the default is `sibling`. Ambiguous cases refuse and prompt — they are never silently resolved.

### `sibling` (default)

`<source>.wiki/` lives next to `<source>/`. One wiki, one sibling directory, forever. Subsequent Rebuilds update the same sibling in place; prior states are reachable as git tags in the private repo under `<wiki>/.llmwiki/git/`. No `.llmwiki.v<N>` directory proliferation — the private git is the authoritative history substrate.

### `in-place`

The source folder IS the wiki. `<source>/.llmwiki/git/` is created inside the source itself; the `pre-op/<first-op>` snapshot captures the user's original content byte-for-byte; subsequent operations mutate the source directly. Rollback to the snapshot tag restores the original tree exactly. **Only runs when explicitly requested** with `--layout-mode in-place` — never inferred.

### `hosted`

The wiki lives at a user-chosen path that carries a `.llmwiki.layout.yaml` contract. Pass `--layout-mode hosted --target <path>`. The contract describes the required directories, allowed entry types, dynamic subdirectory templates (e.g., `daily/{yyyy}-{mm}-{dd}/`), and any additional invariants. Hosted mode is designed for shared team wikis and for "my wiki lives at `./memory/knowledge/`, I don't want it next to any source folder" workflows.

### User-repo coexistence

A wiki's filesystem location often sits inside the user's own git repository. The skill's private git never interferes with the user's git: every `git` subprocess runs with a strict isolation env (`GIT_DIR`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=<tmpdir>`, `core.hooksPath=/dev/null`, …). An auto-generated `<wiki>/.gitignore` hides `.llmwiki/`, `.work/`, and `.shape/history/*/work/` from any ancestor user git. The wiki content itself is plain markdown the user is encouraged to commit.

### Legacy `.llmwiki.v<N>/` auto-migration

When the skill encounters a pre-2.0 versioned sibling directory, the intent resolver halts with a migration prompt. On acceptance, the latest version is copied into a new `<source>.wiki/`, the private git is initialised, and the genesis commit is tagged `op/migrated-from-v<N>`. The old folder is left untouched; users prune it manually.

## The Six Operations

| Operation | Purpose | Output |
| --------- | ------- | ------ |
| **Build** | Create a new wiki from raw sources | sibling: `<source>.wiki/` · in-place: mutates `<source>/` directly · hosted: user-chosen path under a layout contract |
| **Extend** | Add new sources to an existing wiki | new per-phase commits + a new `op/<id>` tag on the existing `<wiki>.wiki/` |
| **Validate** | Read-only invariant check | structured findings report (hard + soft) |
| **Rebuild** | Optimise structure for token efficiency | new per-phase commits on the same wiki; `--review` gates the commit-finalize step on user approval |
| **Fix** | Repair methodology divergences | new commits on the existing wiki; HUMAN-class findings surface as structured prompts for user resolution *(minimal build-forward stub for now; full fix pipeline + dedicated INT error code are future work)* |
| **Join** | Merge two or more wikis into one | new unified wiki at the user-chosen target *(stub; full join pipeline is future work)* |

### Safety envelope (all operations)

- **Sources are immutable** in `sibling` and `hosted` modes; in `in-place` mode every change is anchored by the `pre-op/<op-id>` snapshot tag so rollback is byte-exact.
- **Every operation is a git sequence.** The pipeline always runs `pre-op snapshot → phase commits → validation → commit-finalize`. Validation failure triggers `git reset --hard pre-op/<id>` + `git clean -fd`; the failed phase commits survive in the reflog for post-mortem.
- **Rollback, diff, log, show, blame, history, reflog.** All exposed as subcommands and all byte-identical to native `git` under the isolation env. See `skill-llm-wiki diff/log/show/blame/history/reflog <wiki>`.
- **Phase-commit audit trail.** Each operation decomposes into named phases; every phase (and every operator-convergence iteration) is a git commit so the private repo's log is a complete per-phase audit trail. An interrupted operation can be inspected via `skill-llm-wiki log --op <id>` and rolled back via `skill-llm-wiki rollback <wiki> --to pre-<op-id>`. True mid-phase resume ("pick up from the last per-item marker") is scoped as future work.
- **Deterministic.** Same source + `LLM_WIKI_FIXED_TIMESTAMP=<epoch>` → byte-identical HEAD commit AND tree SHAs across runs and across machines. `newOpId` substitutes the random component for the literal `"deterministic"` when the env var is set, so the op-id, tag bodies, commit objects, and tree objects are all reproducible. AI calls are cached by request hash; similarity decisions are cached by content-hash pair.
- **Atomic commit-finalize.** The final `op/<op-id>` tag is set as the last step of every operation; until that tag exists, the operation is still reversible in one command.
- **Optional interactive review.** `rebuild --review` prints `git diff --stat` + the per-iteration commit list and prompts approve / abort / `drop:<sha>`. Drops become `git revert --no-edit` commits and the loop re-prompts so the user can drop multiple iterations.
- **Never-auto-push remote mirroring.** `skill-llm-wiki remote <wiki> add <name> <url>` plus `skill-llm-wiki sync <wiki>` pushes tags (and optionally a branch) to a bare remote the user manages. Tag-only refspec by default; URL credentials are redacted in every echoed line and error message.

## Phase-by-phase pipeline (the long version)

Every operation runs the same git-backed sequence end-to-end. Phases are explicit so you can read the private git's `log --oneline` after a run and recover the full story of what happened.

1. **Preflight + pre-op snapshot** — Node and git version checks, private-git integrity check, then `git add -A && git commit -m "pre-op <op-id>"` + tag `pre-op/<op-id>`.
2. **Ingest** (Build only) — walk the source tree, compute content hashes, emit entry candidates. Byte-range provenance is recorded to `<wiki>/.llmwiki/provenance.yaml` so `LOSS-01` can verify nothing was silently dropped. Extend / Rebuild / Fix / Join do not currently touch `provenance.yaml`.
3. **Classify** — group entries into categories. Tiered AI ladder: TF-IDF → local MiniLM embeddings → Claude. Decisive Tier 0 / Tier 1 outcomes never reach Claude.
4. **Draft frontmatter** — derive `id`, `focus`, `covers[]`, `activation`, `tags`, `parents[]` from structure where possible; Claude fallback for prose-heavy sources.
5. **Layout** — place entries in a draft tree honouring the narrowing-chain rule.
6. **Operator convergence** — apply DESCEND, LIFT, MERGE, NEST, DECOMPOSE in priority order until the tree reaches its normal form. One git commit per iteration so `git log pre-op/<id>..HEAD` reads like a per-iteration audit trail.
7. **Review (optional, `--review` only)** — print `git diff --stat` + commit list; accept approve / abort / drop:<sha> from the user. Drops land as `git revert --no-edit` commits and the loop re-prompts.
8. **Index generation** — emit a unified `index.md` at every directory with machine routing metadata in frontmatter and human/LLM orientation in the body.
9. **Validation** — run hard invariants including the new `GIT-01` (private-git integrity under the isolation env) and `LOSS-01` (byte-range coverage equals source size). Failure triggers `git reset --hard pre-op/<id>` + `git clean -fd`.
10. **Commit-finalize** — tag the final commit `op/<op-id>`, append to `<wiki>/.llmwiki/op-log.yaml`, delete the live `.work/` scratch directory. *(A "golden-path" phase that compares routing-fixture load sets against the prior op and a `.work/` → `.shape/history/<op-id>/` archive step are scoped as future work.)*

## Wiki format

Every directory in a wiki holds exactly one `index.md`:

```markdown
---
id: installation
type: index
depth_role: category
depth: 1
focus: installing the product on supported platforms
parents:
  - ../index.md
shared_covers:
  - prerequisite checks
  - post-install validation
entries:
  - id: linux
    file: linux.md
    type: primary
    focus: installing on Linux distributions
  - id: macos
    file: macos.md
    type: primary
    focus: installing on macOS
children: []
---
<!-- BEGIN AUTO-GENERATED NAVIGATION -->
# Installation
## Children
| File | Type | Focus |
| ... |
<!-- END AUTO-GENERATED NAVIGATION -->
<!-- BEGIN AUTHORED ORIENTATION -->
Human/LLM-authored prose, preserved across regenerations.
<!-- END AUTHORED ORIENTATION -->
```

Leaves are `<id>.md` files with their own frontmatter (`id`, `type`, `focus`, `covers[]`, `parents[]`, `activation`, `tags`, `aliases`, `links`, `source`). The root `index.md` additionally carries a `generator: skill-llm-wiki/v1` marker that scripts use as a safety check before mutating anything.

## Architecture

The installed skill contains only what Claude needs at runtime. Everything Claude reads is in `SKILL.md`; everything it executes is in the `scripts/` CLI.

```text
skill-llm-wiki/             # installed package layout
├── SKILL.md                # the ONLY file Claude reads — fully self-contained
├── README.md               # human-facing docs (this file)
├── LICENSE
├── guide/                  # routing-time leaves loaded by Claude on keyword activation
│   ├── hidden-git.md       #   using the private git for history / diff / blame
│   ├── layout-modes.md     #   sibling vs in-place vs hosted
│   ├── user-intent.md      #   "ask, don't guess" scenarios
│   ├── tiered-ai.md        #   tier ladder and quality modes
│   ├── remote-sync.md      #   remote mirroring + redaction
│   └── …                   #   (coexistence, scale, diff, in-place-mode, safety, operations/*)
└── scripts/
    ├── cli.mjs             # Deterministic CLI dispatcher — invoked, never read
    ├── commands/           # Command-level orchestrators
    │   ├── review.mjs      #   --review flow for rebuild
    │   ├── remote.mjs      #   remote add/list/remove
    │   └── sync.mjs        #   remote sync (tag-only default refspec)
    └── lib/
        ├── git.mjs         # THE git subprocess spawner — isolation env + redaction
        ├── git-commands.mjs     # log/show/diff/blame/history/reflog subcommand bodies
        ├── gitignore.mjs   # auto-writer for the wiki-local `.gitignore`
        ├── paths.mjs       # Sibling/in-place/hosted recognition + `.llmwiki/git/` detection
        ├── snapshot.mjs    # preOpSnapshot + tag helpers
        ├── rollback.mjs    # ref verification + reset/clean
        ├── history.mjs     # op-log append/read, entry history traversal
        ├── provenance.mjs  # byte-range record / verifyCoverage (LOSS-01 source)
        ├── chunk.mjs       # Buffer-first frontmatter-only async iterator
        ├── preflight.mjs   # Node + git + wiki-fsck checks
        ├── intent.mjs      # layout-mode / target / op resolver (INT-NN errors)
        ├── interactive.mjs # stdin prompts; non-TTY → hard error
        ├── similarity.mjs  # Tier 0 — TF-IDF + cosine
        ├── embeddings.mjs  # Tier 1 — MiniLM via @xenova/transformers (required)
        ├── similarity-cache.mjs # pairwise memoisation
        ├── decision-log.mjs     # .llmwiki/decisions.yaml writer
        ├── tiered.mjs      # escalation orchestrator + quality modes
        ├── migrate.mjs     # legacy .llmwiki.v<N> → .wiki migration flow
        ├── operators.mjs   # The five rewrite operator primitives
        ├── nest-applier.mjs # NEST apply + deterministic slug collision resolver
        ├── cluster-detect.mjs # NEST candidate clusterer (affinity + threshold sweep)
        ├── quality-metric.mjs # routing_cost metric for NEST gating
        ├── frontmatter.mjs # Zero-dep YAML frontmatter parser/writer
        ├── ingest.mjs      # Source walk + content hashing
        ├── draft.mjs       # Deterministic frontmatter drafting + provenance record
        ├── indices.mjs     # Unified index.md rebuild
        ├── validate.mjs    # Hard-invariant checks including GIT-01 / LOSS-01
        ├── shape-check.mjs # Operator candidate detection (hook-mode path; no git)
        └── orchestrator.mjs # Per-phase commit pipeline
```

`SKILL.md` and the `guide/` leaves are the only files Claude reads at routing/session time; the `scripts/` source is invoked as a process, never read. Every CLI subcommand's inputs, outputs, and exit codes are documented in `SKILL.md` so no source inspection is ever necessary during a session.

The development repository also contains `methodology.md`, an internal design reference for maintainers (sections 9.4.2/9.4.3/9.9/9.10 are the normative source for this README's "Layout modes", "Ask, don't guess", "git-backed history", and "tiered AI" content respectively). It is deliberately excluded from the installed package.

The CLI subcommands you will see the skill invoke:

```bash
# Top-level operations (routed through intent.mjs)
node scripts/cli.mjs build <source> [--layout-mode sibling|in-place|hosted] [--target <path>]
node scripts/cli.mjs extend <wiki> <source>
node scripts/cli.mjs validate <wiki>
node scripts/cli.mjs rebuild <wiki> [--review]
node scripts/cli.mjs fix <wiki>
node scripts/cli.mjs join <target> <wiki-a> <wiki-b> [<wiki-c> ...]
node scripts/cli.mjs rollback <wiki> --to <ref>
node scripts/cli.mjs migrate <legacy-wiki>

# Hidden-git plumbing (all run under the isolation env)
node scripts/cli.mjs log <wiki> [--op <id>] [git-log-args...]
node scripts/cli.mjs show <wiki> <ref> [-- <path>]
node scripts/cli.mjs diff <wiki> [--op <id>] [git-diff-args...]
node scripts/cli.mjs blame <wiki> <path>
node scripts/cli.mjs history <wiki> <entry-id>
node scripts/cli.mjs reflog <wiki>

# Remote mirroring (never auto-pushes)
node scripts/cli.mjs remote <wiki> add <name> <url>
node scripts/cli.mjs remote <wiki> list
node scripts/cli.mjs remote <wiki> remove <name>
node scripts/cli.mjs sync <wiki> [--remote <name>] [--push-branch <branch>] [--skip-fetch] [--skip-push]

# Low-level helpers (invoked by SKILL.md routing, not user-facing)
node scripts/cli.mjs ingest <source>
node scripts/cli.mjs draft-leaf <candidate-file>
node scripts/cli.mjs draft-category <candidate-file>
node scripts/cli.mjs index-rebuild <wiki>
node scripts/cli.mjs index-rebuild-one <dir> <wiki>
node scripts/cli.mjs shape-check <wiki>

# Legacy helpers (still present for pre-Phase-2 `.llmwiki.vN` wikis)
node scripts/cli.mjs resolve-wiki <source>
node scripts/cli.mjs next-version <source>
node scripts/cli.mjs list-versions <source>
node scripts/cli.mjs set-current <source> <version>
```

## Validation invariants

Every wiki passes the same set of hard invariants:

- `id` matches filename (leaves) or directory name (index files)
- `depth_role` matches actual tree depth
- **Strict narrowing** along every canonical `parents[0]` chain up to the root
- `parents[]` required and non-empty on every non-root entry
- **DAG acyclicity** — walking `parents[]` transitively never revisits the start
- **Canonical-parent consistency** — the entry lives inside `parents[0]`'s directory; soft parents only cross-reference
- No duplicate `id` anywhere; aliases do not collide with live ids
- `overlay_targets`, `links[].id`, and `parents[]` resolve via id or alias
- **Parent-file contract** — index bodies contain navigation and orientation only, no leaf-shaped content
- Every directory containing entries has a valid `index.md`
- Leaf size caps (500 lines for primaries, 200 for overlays)
- Source integrity — if `source.hash` is set, upstream content must still match
- **`GIT-01` — private-git integrity.** When `<wiki>/.llmwiki/git/HEAD` exists, `git fsck --no-dangling --no-reflogs` must succeed under the isolation env, and — when the op-log has at least one entry — the most recent logged op's `pre-op/<op-id>` tag must exist and be reachable from HEAD.
- **`LOSS-01` — byte-range coverage.** When `<wiki>/.llmwiki/provenance.yaml` exists, for every source file recorded in it, the total byte coverage (`sources[].byte_range` + `discarded_ranges[].byte_range`) must equal the manifest-recorded `source_size`, with no overlapping ranges. Sizes are read from the manifest so the check runs without needing access to the original source tree.

Soft shape-signals (operator candidates, golden-path regressions, coverage holes) are reported separately and drive the next Rebuild without blocking current operations.

## Tiered AI strategy

Every decision the skill makes is classified against a three-tier ladder and escalated only when necessary:

| Phase                              | Primary tier                              | Escalation | Notes |
|------------------------------------|-------------------------------------------|------------|-------|
| ingest / layout / index / validate / commit / routing | None (deterministic scripts) | —        | No similarity, no generation. |
| classify / operator-convergence / join collisions | TF-IDF → MiniLM embeddings → Claude | Full ladder | >90% of decisions resolve at Tier 0 or 1 on typical corpora. |
| draft-frontmatter                  | Heuristic extractor → Claude               | Skip Tier 1 | Generation, not similarity. Claude only for prose-heavy sources. |
| Fix — AI-ASSIST class              | Claude                                    | —          | Content generation. |
| Fix — HUMAN class                  | User prompt                               | —          | Always asks. |

Quality modes select the escalation policy:

- `tiered-fast` (default) — full Tier 0 → 1 → 2 ladder.
- `claude-first` — skip Tier 1; mid-band Tier 0 escalates straight to Claude.
- `tier0-only` — air-gapped mode; mid-band becomes an "undecidable" marker resolved via the interactive review flow.

Tier 1 uses `@xenova/transformers` running `Xenova/all-MiniLM-L6-v2` locally via ONNX (~23 MB one-time model download, ~50 ms per text on CPU, zero API cost). It is a **required** runtime dependency since v0.4.0 — the dependency preflight at CLI startup verifies it is resolvable, and will offer to `npm install` it on a fresh checkout if it is missing.

Token cost is proportional to *ambiguity*, not to corpus size. A 10k-entry wiki takes roughly the same Claude budget as a 100-entry wiki when it produces the same number of mid-band decisions. All AI calls are cached by request hash at `.work/ai-cache/` and all pairwise similarity decisions are cached at `.llmwiki/similarity-cache/` so resumes and re-runs replay free.

## Development

```bash
npm test                         # run smoke tests
node scripts/cli.mjs --version   # print CLI version
node scripts/cli.mjs --help      # list subcommands
```

Smoke tests verify: frontmatter roundtrip, source ingest, hand-built wiki validates, index-rebuild idempotency, and the script safety net against unrelated folders.

## License

[MIT](LICENSE)
