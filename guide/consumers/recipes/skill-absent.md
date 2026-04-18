---
id: recipe-skill-absent
type: primary
depth_role: leaf
focus: "Detect the skill is missing and surface an upgrade path without silently degrading"
parents:
  - ../index.md
tags:
  - skill-absent
  - preflight
  - install-hint
  - consumers
activation:
  keyword_matches:
    - skill missing
    - skill not installed
    - install hint
    - preflight skill
    - hard dependency
  tag_matches:
    - skill-absent
    - preflight

generator: "skill-llm-wiki/v1"
---

# Recipe: skill-absent detection

## Trigger

Your consumer treats `@ctxr/skill-llm-wiki` as a hard dependency and must refuse to run when the skill is missing, rather than silently degrading to raw-markdown writes.

## Commands

```bash
skill-llm-wiki contract --json
```

This is the canonical probe. It is exempt from the runtime-dep preflight inside the skill itself, so even a partially-broken install still answers the probe as long as the binary is on PATH.

## Decision tree

1. `skill-llm-wiki contract --json` exits `0` with a parseable envelope containing `format_version >= <your required>`: proceed.
2. `skill-llm-wiki contract --json` exits `0` with `format_version` below your required value: the skill is present but too old. Surface an upgrade message.
3. `skill-llm-wiki contract --json` exits non-zero: the skill is installed but broken (e.g. runtime deps corrupted). Surface a reinstall message.
4. The binary is not on PATH (spawnSync returns ENOENT or no output): the skill is not installed. Surface an install message.

## Minimum consumer code

```js
import { spawnSync } from "node:child_process";

const REQUIRED_FORMAT_VERSION = 1;

export function probeSkill() {
  const r = spawnSync("skill-llm-wiki", ["contract", "--json"], {
    encoding: "utf8",
  });
  if (r.error && r.error.code === "ENOENT") {
    return { ok: false, state: "absent" };
  }
  if (r.status !== 0) {
    return { ok: false, state: "broken", stderr: r.stderr };
  }
  try {
    const env = JSON.parse(r.stdout);
    if ((env.format_version ?? 0) < REQUIRED_FORMAT_VERSION) {
      return { ok: false, state: "too-old", current: env.format_version };
    }
    return { ok: true, ...env };
  } catch {
    return { ok: false, state: "unparseable" };
  }
}

export function enforceSkillPresent() {
  const p = probeSkill();
  if (p.ok) return p;
  const hint =
    p.state === "absent"
      ? "@ctxr/skill-llm-wiki is not installed.\n" +
        "Install with: npx @ctxr/kit install @ctxr/skill-llm-wiki"
      : p.state === "too-old"
        ? `@ctxr/skill-llm-wiki format_version ${p.current} is below the required ${REQUIRED_FORMAT_VERSION}.\n` +
          "Upgrade with: npm i -g @ctxr/skill-llm-wiki@latest"
        : `@ctxr/skill-llm-wiki is installed but not answering the contract probe.\n${p.stderr ?? ""}`;
  throw new Error(hint);
}
```

## Do not

- Silently fall back to raw markdown writes when the skill is missing. Every downstream tool that expects the wiki format will break.
- Inline the install command guess. Read the envelope's `package_version` and compare to your own requirement; publish your install hint alongside your agent.
- Cache the probe result across sessions. A user can uninstall the skill at any time; the probe is cheap (~100ms) and should run once per invocation.

## Recovery

Once the consumer reports the skill is missing, recovery for the user is:

```bash
# Via @ctxr/kit (preferred, manages SKILL.md path + update flow):
npx @ctxr/kit install @ctxr/skill-llm-wiki

# Or plain npm for CI / scripted environments:
npm i -g @ctxr/skill-llm-wiki
```

The consumer's preflight should re-run `probeSkill()` after the install.
