---
id: preflight
type: primary
depth_role: leaf
focus: "user-facing messages for preflight failures (node / git / wiki-fsck)"
parents:
  - index.md
covers:
  - "Case A message: Node.js is not installed, with install options per platform"
  - "Case B message: Node.js version is too old, with upgrade options per platform"
  - "Case C message: git missing or older than 2.25 (exit 5)"
  - "Case D message: existing wiki's private git is corrupt (exit 6)"
  - "Case E message: required runtime dependencies missing (exit 8)"
  - post-install verification command
  - PATH-staleness hint for existing shell sessions
tags:
  - preflight
  - user-messages
activation:
  tag_matches:
    - preflight-failure
  keyword_matches:
    - node missing
    - node too old
    - install node
    - upgrade node
source:
  origin: file
  path: preflight.md
  hash: "sha256:ddf2d24577bef0beaa1b15b1e9e39a073fc04a6016fbe000faec3e99ac1a2e9a"
---

# Preflight — user-facing messages

Relay one of the messages below **verbatim** to the user when the Node.js preflight fails. Do not paraphrase. Do not try to install or upgrade Node yourself. Do not propose workarounds. After relaying, stop the operation and wait for the user to take the action.

## Case A — Node.js is not installed

> **Cannot proceed: Node.js is not installed.**
>
> The `skill-llm-wiki` skill requires Node.js ≥ 18.0.0 to run its deterministic CLI (`scripts/cli.mjs`). This machine does not have Node.js installed, so no operation can be performed until you install it. I will not install Node.js for you — please do it yourself so you stay in control of your environment.
>
> Installation options (pick one for your platform):
>
> - **macOS (Homebrew):** `brew install node`
> - **macOS / Linux (nvm, recommended for dev machines):** `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash` then `nvm install 20 && nvm use 20`
> - **Linux (Debian/Ubuntu):** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
> - **Linux (RHEL/Fedora):** `curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs`
> - **Windows (winget):** `winget install OpenJS.NodeJS`
> - **Windows (Chocolatey):** `choco install nodejs-lts`
> - **Any platform (official installer):** download from <https://nodejs.org/en/download/>
>
> After installing, verify in a fresh terminal:
>
> ```bash
> node --version     # should print v18.0.0 or newer
> ```
>
> If `node --version` works in a new terminal but not in this session, your shell's `PATH` may be stale — open a fresh terminal or source your shell profile (`source ~/.zshrc` / `source ~/.bashrc`), then ask me to retry the operation.

## Case B — Node.js is installed but too old

Substitute `${VERSION}` with the exact version string you received from `node --version` (e.g. `v16.17.0`).

> **Cannot proceed: Node.js ${VERSION} is too old.**
>
> The `skill-llm-wiki` skill requires Node.js ≥ 18.0.0. Your installed version is `${VERSION}`, which is below the minimum. Please upgrade Node.js before retrying the operation. I will not upgrade it for you.
>
> Upgrade options:
>
> - **macOS (Homebrew):** `brew upgrade node`
> - **macOS / Linux (nvm):** `nvm install 20 && nvm use 20`
> - **Linux (NodeSource, Debian/Ubuntu):** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
> - **Linux (NodeSource, RHEL/Fedora):** `curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs`
> - **Windows (winget):** `winget upgrade OpenJS.NodeJS`
> - **Windows (Chocolatey):** `choco upgrade nodejs-lts`
> - **Any platform (official installer):** download from <https://nodejs.org/en/download/>
>
> After upgrading, verify in a fresh terminal:
>
> ```bash
> node --version     # should print v18.0.0 or newer
> ```
>
> Then ask me to retry the operation.

## Case C — git binary missing or too old (exit code 5)

Emitted by `preflightGit` in `scripts/lib/preflight.mjs`. The CLI uses the private-git backbone (`<wiki>/.llmwiki/git/`) for every operation; without a modern enough git binary, nothing works. The skill requires git ≥ **2.25**.

> **Cannot proceed: `git` is missing or too old.**
>
> The `skill-llm-wiki` skill requires `git` ≥ 2.25 on `PATH` to run its private-git substrate. This machine either does not have git installed or has a version too old for the features the skill depends on (`git -c core.hooksPath=/dev/null`, `git rev-parse --verify`, isolated-config env vars). Please install or upgrade git before retrying.
>
> Installation / upgrade options:
>
> - **macOS (Homebrew):** `brew install git` / `brew upgrade git`
> - **Linux (Debian/Ubuntu):** `sudo apt-get install git`
> - **Linux (RHEL/Fedora):** `sudo dnf install git`
> - **Windows:** download from <https://git-scm.com/download/win>
>
> After installing, verify in a fresh terminal:
>
> ```bash
> git --version      # should print git version 2.25 or newer
> ```
>
> Then ask me to retry the operation.

## Case D — existing wiki's private git is corrupt (exit code 6)

Emitted by `preflightWiki` in `scripts/lib/preflight.mjs` when a target wiki has a `.llmwiki/git/` directory but `git fsck --no-dangling --no-reflogs` fails. This indicates the private repo has been damaged — possibly by a parallel process writing into it, a filesystem crash mid-commit, or manual edits to `.llmwiki/git/`.

> **Cannot proceed: the wiki's private git repository is corrupt.**
>
> `git fsck` failed inside `${WIKI}/.llmwiki/git/`. The skill will not run any operation against a corrupt repo because the Phase 1 safety contract (losslessness, rollback) depends on `GIT-01` holding. Options:
>
> 1. **Inspect the damage yourself.** Run `skill-llm-wiki reflog ${WIKI}` and `skill-llm-wiki log ${WIKI}` to see what's still reachable, then roll back to the last known-good tag with `skill-llm-wiki rollback ${WIKI} --to <op-id>`.
> 2. **Rebuild from source.** If the original source tree is still available, delete the wiki and re-run `skill-llm-wiki build <source>`. The private repo will be reinitialised from scratch.
> 3. **Ask me for help.** Paste the `git fsck` output you received and I can help diagnose whether the damage is recoverable.
>
> I will not attempt automatic repair — a broken repo is the kind of thing that should be an explicit decision, not a silent fix.

## Case E — skill-llm-wiki dependencies are missing (exit code 8)

Emitted by `preflightDependencies` in `scripts/lib/preflight.mjs`. The CLI checks both runtime dependencies on every invocation (excluding `--version` / `--help`) and refuses to proceed if either cannot be resolved from the skill's `node_modules/`.

> **Cannot proceed: one or more `skill-llm-wiki` runtime dependencies could not be found.**
>
> The skill needs both of the following packages installed in its own `node_modules/`:
>
> - `gray-matter` — required for parsing authored frontmatter in source files during ingest.
> - `@xenova/transformers` — required for the local Tier 1 embeddings model used during operator-convergence.
>
> To install them, run this in the skill directory:
>
> ```bash
> cd /path/to/skill-llm-wiki
> npm install
> ```
>
> If the CLI was started in an interactive terminal, it will prompt `Install now? [Y/n]` and run `npm install --silent` for you on confirmation. If it was started non-interactively (no TTY, or `LLM_WIKI_NO_PROMPT=1`), it will attempt the silent install itself before re-checking.
>
> If `npm install` fails, the underlying error is shown above. Common causes:
>
> - **No network access.** `@xenova/transformers` is large (~25 MB) and the local model file is downloaded on first embed call (another ~23 MB). Both `npm install` and the first build need network unless the cache is pre-warmed.
> - **Corrupted `node_modules/`.** Delete `node_modules/` and `package-lock.json` and re-run `npm install`.
> - **Read-only filesystem.** The skill cannot install into a read-only deployment; the dependencies must be vendored in by whoever produced the deployment.
>
> The CLI exits with code **8** (`DEPS_MISSING`) when the install attempt is declined or fails.
