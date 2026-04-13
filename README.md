# LLM Wiki Skill for Claude Code

[![npm](https://img.shields.io/npm/v/@ctxr/skill-llm-wiki)](https://www.npmjs.com/package/@ctxr/skill-llm-wiki)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Build, extend, validate, repair, rebuild, and merge **LLM wikis** — filesystem-based knowledge stores structured for deterministic, token-efficient retrieval by a language model. Produces sibling-versioned `.llmwiki.vN` outputs with hierarchical `index.md` files, DAG parents, activation signals, and deterministic rewrite operators that keep the tree in a token-minimal normal form as it grows.

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

The installed package contains only what Claude needs at runtime: `SKILL.md` (the only file Claude reads), `LICENSE`, `README.md`, and `scripts/` (invoked via `node scripts/cli.mjs <subcommand>`, never read as source). There is intentionally no internal design doc or methodology file shipped with the skill — everything operationally relevant is condensed into `SKILL.md` so a session never wastes tokens loading supporting documentation.

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
# → creates ./docs.llmwiki.v1/ next to ./docs

Add ./arch to my docs wiki
# → produces ./docs.llmwiki.v2/ with the new content integrated

Validate ./docs.llmwiki.v2
# → read-only invariant check; prints findings with severity

Rebuild ./docs.llmwiki.v2 --plan
# → writes a rewrite plan you can inspect before applying

Rebuild ./docs.llmwiki.v2 --apply .shape/rewrite-plan-*.yaml
# → produces a restructured v3 if the plan passes golden-path checks

Fix ./docs.llmwiki.v2 --dry-run
# → lists repairs (AUTO, AI-ASSIST, HUMAN classes) without mutating

Merge ./docs.llmwiki.v2 and ./runbooks.llmwiki.v1 into handbook
# → creates ./handbook.llmwiki.v1/ with merged content and rewired references
```

Nothing happens until you ask. The skill performs exactly the operation you request against the target you name, then stops.

## Layout modes

The skill operates in one of two modes per invocation, decided automatically by whether a layout contract exists at the target root.

### Free mode (default)

No layout contract → the skill owns the output layout. Given a source folder `./docs`, the wiki is produced as a sibling `./docs.llmwiki.v1/`. Subsequent operations produce `./docs.llmwiki.v2/`, `./docs.llmwiki.v3/`, …, and a plaintext `./docs.llmwiki.current` file tracks which version is live. The source folder is never written to. The skill decides the full directory structure by classifying entries into top-level categories and runs the rewrite operators freely until the tree converges to a token-minimal normal form.

### Hosted mode

A `.llmwiki.layout.yaml` file at the target root → the skill operates as a guest that strictly honors a host-defined structure. The contract describes the required directories, what each is for, which entry types are allowed, dynamic subdirectory templates (e.g. `daily/{yyyy}-{mm}-{dd}/`), and any additional invariants. The skill writes in-place into the target (or into a sibling versioned directory if the contract says so), never creates directories outside the contract, and gates every rewrite-operator application against the contract. The contract is authoritative — when methodology defaults and the contract disagree, the contract wins. Quality is never compromised because the contract only adds constraints on top of the methodology's hard invariants; it never removes them.

Hosted mode is designed for the case where other tools or skills write into the target between your invocations (for example, a memory folder where a daily-journal skill appends entries under `daily/<today>/`). When asked to operate on such a target, the skill validates, reports drift, and reconciles the tree explicitly — never reactively.

## The Six Operations

| Operation | Purpose | Output |
| --------- | ------- | ------ |
| **Build** | Create a new wiki from raw sources | free: `<name>.llmwiki.v1/` · hosted: in-place into target |
| **Extend** | Add new sources to an existing wiki | new version (free) or in-place writes (hosted) |
| **Validate** | Read-only invariant check | structured findings report |
| **Rebuild** | Optimise structure for token efficiency | rewrite plan, then new version/in-place apply on `--apply` |
| **Fix** | Repair methodology divergences | new version with repairs (or in-place with backup) |
| **Join** | Merge two or more wikis into one | new unified wiki |

### Safety envelope (all operations)

- **Free mode: sources are immutable.** Given `./docs`, outputs live at `./docs.llmwiki.vN/`. The original folder is never written to.
- **Hosted mode: contract defines the write surface.** The skill writes only into directories the contract permits and never creates directories outside it. Before any structural mutation, the target is snapshotted to `<target>/<backup_dir>/<timestamp>/` so rollback is always possible.
- **Every change is a new version or an atomic in-place commit.** Free mode rolls back by flipping a plaintext pointer; hosted mode rolls back by restoring the backup snapshot.
- **Resumable phase pipelines.** Each operation decomposes into named phases tracked in `<wiki>/.work/progress.yaml`. Interrupt any operation (Ctrl-C, crash, reboot) and re-run — it resumes from the last completed item.
- **Deterministic.** Same source + same seed → byte-identical output. AI calls are cached by request hash, so resumes replay cached responses for free.
- **Atomic commits.** The final move into place is the last step of every operation. A failed operation leaves nothing visible changed.

## How it works

1. **Ingest** — walk the source tree, compute content hashes, emit entry candidates.
2. **Classify** — group entries into categories by filename/directory heuristics; AI fallback when heuristics fail.
3. **Draft frontmatter** — derive `id`, `focus`, `covers[]`, `activation`, `tags`, `parents[]` from structure where possible; AI fallback for prose-heavy sources.
4. **Layout** — place entries in a draft tree honouring the narrowing-chain rule.
5. **Operator convergence** — apply DECOMPOSE, NEST, MERGE/LIFT, DESCEND in priority order until the tree reaches its normal form.
6. **Index generation** — emit a single unified `index.md` at every directory with machine routing metadata in frontmatter and human/LLM orientation in the body.
7. **Validation** — run hard invariants (narrowing chain, DAG acyclicity, parent-file contract, link integrity, canonical-parent consistency, …).
8. **Golden-path check** — if fixtures exist, verify retrieval hasn't regressed compared to the previous version.
9. **Commit** — atomic move, flip the current-pointer, archive work artifacts under `.shape/history/`.

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
└── scripts/
    ├── cli.mjs             # Deterministic CLI dispatcher — invoked, never read
    └── lib/
        ├── paths.mjs       # Versioned-sibling conventions + generator marker
        ├── frontmatter.mjs # Zero-dep YAML frontmatter parser/writer
        ├── manifest.mjs    # Progress manifest read/write/advance
        ├── ingest.mjs      # Source walk + content hashing
        ├── draft.mjs       # Deterministic frontmatter drafting
        ├── indices.mjs     # Unified index.md rebuild
        ├── validate.mjs    # Hard-invariant checks
        └── shape-check.mjs # Operator candidate detection
```

`SKILL.md` explicitly instructs Claude to read only itself and never open any other file in the skill directory — not the scripts, not this README, nothing. Scripts are invoked via `node scripts/cli.mjs <subcommand>` and their inputs, outputs, and exit codes are fully documented in `SKILL.md` so no source inspection is ever necessary.

The development repository also contains `methodology.md`, an internal design reference for maintainers. It is deliberately excluded from the installed package (`files[]` in `package.json` does not list it) so it is never copied into any user environment and never loaded during a skill session.

The CLI subcommands you will see the skill invoke:

```bash
node scripts/cli.mjs ingest <source>
node scripts/cli.mjs draft-leaf <candidate-file>
node scripts/cli.mjs draft-category <candidate-file>
node scripts/cli.mjs index-rebuild <wiki>
node scripts/cli.mjs index-rebuild-one <dir> <wiki>
node scripts/cli.mjs validate <wiki>
node scripts/cli.mjs shape-check <wiki>
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

Soft shape-signals (operator candidates, golden-path regressions, coverage holes) are reported separately and drive the next Rebuild without blocking current operations.

## Script vs AI balance

| Phase | Runs |
| ----- | ---- |
| ingest, layout, index generation, validation, commit, routing | 100% deterministic scripts |
| classify, draft-frontmatter | Script-first with AI fallback when heuristics are low-confidence |
| semantic operator review, HUMAN-class repairs | Explicit user or AI decision |

Token cost is proportional to the prose-intensity of the corpus, not its total size. All AI calls are cached by request hash so resumes are free.

## Development

```bash
npm test                         # run smoke tests
node scripts/cli.mjs --version   # print CLI version
node scripts/cli.mjs --help      # list subcommands
```

Smoke tests verify: frontmatter roundtrip, source ingest, hand-built wiki validates, index-rebuild idempotency, and the script safety net against unrelated folders.

## License

[MIT](LICENSE)
