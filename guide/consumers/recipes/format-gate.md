---
id: recipe-format-gate
type: primary
depth_role: leaf
focus: "Gate consumer CI on skill-llm-wiki contract --json format_version"
parents:
  - ../index.md
tags:
  - contract
  - format-version
  - compatibility
  - consumers
activation:
  keyword_matches:
    - format version
    - contract gate
    - compatibility check
    - version gate
    - drift detection
  tag_matches:
    - contract
    - format-version

generator: "skill-llm-wiki/v1"
---

# Recipe: format_version gate

## Trigger

Your consumer's tests used to drift-test against SKILL.md prose. Replace that with a single integer comparison against `format_version`.

## Commands

```bash
skill-llm-wiki contract --json
```

Parse the envelope; assert `format_version >= <your required>`.

## Envelope fields

```json
{
  "schema": "skill-llm-wiki/contract/v1",
  "format_version": 1,
  "min_consumer_format_version": 1,
  "package_version": "1.0.1",
  "frontmatter_schema": { "leaf": { "required": [...], "fields": {...} } },
  "layout_tokens": [{ "token": "{yyyy}", "description": "..." }, ...],
  "subcommands": { "build": { "positionals": ["source"], "flags": [...] }, ... },
  "envelope_schema": { "schema": "skill-llm-wiki/v1", "fields": {...} },
  "exit_codes": { "0": "ok", "1": "usage error", ... }
}
```

Fields consumers care about:

- `format_version`: integer. Bumps on breaking changes.
- `min_consumer_format_version`: integer. The oldest consumer format_version the current skill still speaks to. A consumer whose required version is below this refuses to run; between this and `format_version` runs unchanged.
- `package_version`: semver string. For display only; gate on `format_version`, not on semver.

## Minimum consumer code

```js
import { spawnSync } from "node:child_process";

export const REQUIRED_WIKI_FORMAT_VERSION = 1;

export function enforceContract(required = REQUIRED_WIKI_FORMAT_VERSION) {
  const r = spawnSync("skill-llm-wiki", ["contract", "--json"], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `skill-llm-wiki contract failed (${r.status}): ${r.stderr}`,
    );
  }
  const env = JSON.parse(r.stdout);
  if (env.format_version < required) {
    throw new Error(
      `skill-llm-wiki format_version=${env.format_version} is below the required ${required}. ` +
        `Upgrade: npm i -g @ctxr/skill-llm-wiki@latest`,
    );
  }
  if (env.min_consumer_format_version > required) {
    throw new Error(
      `skill-llm-wiki dropped support for format_version=${required}; ` +
        `current min_consumer_format_version=${env.min_consumer_format_version}. ` +
        `Your consumer must upgrade its integration to format_version >= ${env.min_consumer_format_version}.`,
    );
  }
  return env;
}
```

## CI one-liner

```bash
# Fail CI if the installed skill is below the required format_version.
FV=$(skill-llm-wiki contract --json | jq -r '.format_version')
if [ "$FV" -lt 1 ]; then echo "skill format_version=$FV below required 1" >&2; exit 1; fi
```

## When to bump your required version

Bump `REQUIRED_WIKI_FORMAT_VERSION` when:

- The skill bumps `format_version` and your consumer depends on the new behaviour.
- A leaf frontmatter field your consumer reads is added or removed.
- A CLI flag your consumer passes becomes mandatory or is removed.
- The envelope shape (schema `skill-llm-wiki/v1`) changes the field your consumer parses.

Do NOT bump when the skill ships a `package_version` patch or minor release that doesn't touch the contract.

## Failure modes

- `format_version` missing from the envelope: the skill is too old to declare a format version (pre-1). Treat as `< 1` and fail with an upgrade message.
- Envelope is unparseable: the skill's `contract` subcommand is broken. Open an issue upstream.
- `min_consumer_format_version` exceeds your required version: the skill intentionally dropped support for your version. You must upgrade your consumer.

## Do not

- Drift-test against SKILL.md prose. The contract subcommand exists specifically so consumers do not need to read SKILL.md programmatically.
- Gate on `package_version` semver. A patch release can ship bug fixes without bumping `format_version`; a `format_version` bump is the only breaking-change signal.
- Cache the contract across PR runs. It's a ~100ms probe; run it every time.
