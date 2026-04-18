---
id: consumers-quickstart
type: primary
depth_role: leaf
focus: "Ten-minute integration path for any consumer that shells out to skill-llm-wiki"
parents:
  - index.md
tags:
  - quickstart
  - integration
  - consumers
activation:
  keyword_matches:
    - quickstart
    - getting started
    - first integration
    - how do i call
    - new consumer
  tag_matches:
    - quickstart

generator: "skill-llm-wiki/v1"
---

# Quickstart

You are building a skill, agent, or CI job that wants to manage docs via `skill-llm-wiki`. Here is the shortest path that gets you working without reinventing the common scaffolding.

## 1. Declare the dependency and gate on format_version

`skill-llm-wiki` ships a machine-readable version contract. Read it in your preflight:

```bash
skill-llm-wiki contract --json | jq -r '.format_version'
```

Fail fast if that number is below your required minimum. See [recipes/format-gate.md](recipes/format-gate.md) for the canonical gate.

## 2. Locate the install path once

Every other consumer concern (templates, testkit, SKILL.md) hangs off one canonical probe:

```bash
skill-llm-wiki where --json
```

Fields you will actually use: `skill_root`, `skill_md`, `templates_dir`, `testkit_dir`. Stop hard-coding `~/.claude/skills/ctxr-skill-llm-wiki/...`; read it from the probe.

## 3. Init a topic wiki with one command

Instead of copying a layout contract and then running build with the right flags, use:

```bash
skill-llm-wiki init .development/shared/reports --kind dated --template reports --json
```

The skill seeds the contract from its own shipped templates and prints the exact `build` command to run next. See [recipes/dated-wiki.md](recipes/dated-wiki.md) and [recipes/subject-wiki.md](recipes/subject-wiki.md).

## 4. After every leaf write, run heal

Your consumer writes a leaf. Immediately call:

```bash
skill-llm-wiki heal .development/shared/reports --json
```

Parse the envelope. Switch on `verdict`:

- `ok`: nothing to do.
- `fixable`: run `skill-llm-wiki fix <wiki>`.
- `needs-rebuild`: run `skill-llm-wiki rebuild <wiki>`.
- `broken`: surface the diagnostics to the user; do not auto-mutate.

See [recipes/post-write-heal.md](recipes/post-write-heal.md) for the full envelope handling.

## 5. Gate CI on validate

Your CI job runs `skill-llm-wiki validate <wiki> --json` against every wiki the project ships. See [recipes/ci-gate.md](recipes/ci-gate.md).

## 6. Handle the skill-absent case explicitly

If your consumer is a hard dependency on `skill-llm-wiki`, refuse to run when the skill is missing and point the user at the install command. See [recipes/skill-absent.md](recipes/skill-absent.md) for the canonical message and exit shape.

## 7. Use the shipped testkit in your test suite

Hand-rolled stubs and fixtures drift over time. Import from `scripts/testkit/` (path discoverable via `where --json`). See [recipes/testing.md](recipes/testing.md).

## What this replaces

- Hand-written layout YAML files duplicated across every consumer.
- `validate → fix → rebuild` ladders reimplemented per consumer.
- Three-step path discovery for SKILL.md.
- Drift-detection tests against SKILL.md prose.
- Hand-rolled presence stubs.

The envelope schema is stable across `format_version` 1; consumers gate on that integer and bump when the skill does.
