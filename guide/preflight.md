---
id: preflight
type: primary
depth_role: leaf
focus: "user-facing messages for Node.js preflight failures"
parents:
  - index.md
covers:
  - "Case A message: Node.js is not installed, with install options per platform"
  - "Case B message: Node.js version is too old, with upgrade options per platform"
  - "post-install verification command"
  - "PATH-staleness hint for existing shell sessions"
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
