---
name: skill-llm-wiki
description: Use when the user explicitly asks to build, extend, validate, repair, rebuild, or merge an LLM-optimized knowledge wiki from markdown notes, documentation, source code, or mixed folders. Supports free mode (sibling-versioned outputs) and hosted mode (strict layout contract enforced in-place). This file is fully self-contained; nothing else in the skill directory needs to be read.
---

# skill-llm-wiki

## ⚠ Read only this file. Never read anything else in this directory.

**Hard rule: `SKILL.md` is the only file you read from this skill.** Do not open `README.md`, do not open any `.mjs` file under `scripts/`, do not open any other markdown file, and do not run `cat`, `head`, `tail`, or `Read` against anything inside the installed skill directory (`.claude/skills/ctxr-skill-llm-wiki/` or `~/.claude/skills/ctxr-skill-llm-wiki/`). Every concept, schema, invariant, operator, operation, and CLI subcommand you need to drive this skill is already documented in the sections below.

**Scripts are tools, not references.** The files under `scripts/` (e.g. `scripts/cli.mjs` and `scripts/lib/*.mjs`) are invoked via `node scripts/cli.mjs <subcommand>` exactly as described in the CLI Reference section. Never read their source. Never import from them. Never inspect their internals to figure out behavior — everything a script does that you need to know is in this file.

**Why this matters.** Every byte you read is a token spent. Reading 60KB of methodology plus 25KB of scripts per session wastes context for no benefit; this file contains a deliberately-condensed subset of all the information you actually need. Respect the budget.

## ⚠ Preflight: verify Node.js is installed (mandatory before every operation)

This skill's deterministic CLI (`scripts/cli.mjs`) is a Node.js program. **Node.js ≥ 18.0.0 is a hard requirement.** Not every machine has Node.js installed, and some machines have a version that is too old. The skill must never attempt to run a CLI command without first verifying that Node is present and new enough — otherwise the user sees cryptic `command not found` or `SyntaxError` output instead of a clear, actionable message.

### The preflight rule

**Before the first `node scripts/cli.mjs` invocation of every operation**, run exactly this via the Bash tool:

```bash
node --version 2>/dev/null || printf '%s\n' '__NODE_MISSING__'
```

Then interpret the single line of output:

**Case A — output is exactly `__NODE_MISSING__`:** Node.js is not installed on this machine. **Stop the operation immediately.** Do not attempt any `node scripts/cli.mjs` command. Do not try to install Node automatically. Do not offer workarounds. Relay the message below to the user verbatim, then wait for them to install Node and re-invoke the operation.

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

**Case B — output is a version string like `v16.17.0`:** parse the major version (the integer between the leading `v` and the first `.`). If it is **less than 18**, stop immediately and relay the message below to the user. Substitute `${VERSION}` with the actual version string you received.

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

**Case C — output is a version string and the major is ≥ 18:** preflight passed. Proceed with the operation normally.

### Preflight rules

- **Run the preflight at the start of every operation.** Not once per session — every operation. The user may change their Node environment between invocations (switch nvm versions, open a fresh terminal, etc.).
- **Never cache the result.** Always re-check.
- **Never skip it to save a tool call.** The preflight is a single Bash command and costs almost nothing.
- **Never wrap it in extra shell logic.** Run the exact command shown above. Parse the exact output. No creativity.
- **Never attempt to install or upgrade Node yourself.** You relay the message to the user; they take the action.
- **Never proceed past a failed preflight.** Stop, deliver the message, wait. A failed preflight is not a problem to work around — it is a blocker that the user must clear before any part of any operation can run.
- **Never invoke `node scripts/cli.mjs` before the preflight has passed in the current operation.** If the user asks a follow-up question after the preflight fails, re-run the preflight from scratch when they ask to retry.

### Defense-in-depth: the CLI also self-checks

`scripts/cli.mjs` performs a runtime Node version check as the very first thing it does. If somehow you skip the Bash preflight and invoke the CLI on a Node version below the minimum, the CLI exits with code 4 and prints a short message pointing back at this section. Do not rely on this — the CLI's message is terser than the user-facing text above, and the user experience is worse when Node is missing entirely (Bash reports `command not found` and the CLI never runs at all). Always run the Bash preflight first so the detailed, actionable message is what the user sees.

## What this skill does

Builds and maintains **LLM wikis**: filesystem-based knowledge stores structured for deterministic, token-efficient retrieval by a language model. A wiki is a directory tree of markdown files whose `index.md` at every level carries activation signals so a router can load only the slice relevant to a given task.

The skill exposes **six operations**:

| Operation | Purpose |
| --------- | ------- |
| **Build** | Create a new wiki from raw source(s) |
| **Extend** | Add new sources to an existing wiki |
| **Validate** | Read-only correctness check |
| **Rebuild** | Optimise structure via rewrite operators (plan + apply) |
| **Fix** | Repair methodology divergences |
| **Join** | Merge two or more wikis into one |

## Non-automation contract

This skill has **no hooks, no filesystem watchers, no PostToolUse listeners, no install-time wiring, no background processes**. Every action happens only in direct response to an explicit user request against an explicit target directory. If the user did not ask for an operation, do nothing. Do not propose automation. Do not create hooks. Do not schedule anything.

If the user hand-edits a wiki and the indices go stale, nothing happens until they explicitly ask you to refresh it — at which point you run `node scripts/cli.mjs index-rebuild <wiki>` and the other CLI commands documented below.

## Layout modes: free and hosted

The skill operates in one of two modes per invocation. The distinguishing signal is whether a layout contract file exists at the target root.

### Free mode (default)

**No layout contract → free mode.**

- The user gives you a **source folder** (e.g. `./docs`).
- You produce a sibling wiki at `./docs.llmwiki.v1/`.
- Subsequent operations produce `./docs.llmwiki.v2/`, `./docs.llmwiki.v3/`, …
- A plaintext `./docs.llmwiki.current` file at the sibling level tracks which version is live (a single line: `v2`). Rollback is `echo v1 > ./docs.llmwiki.current`.
- The source folder is **immutable** — never write into it.
- The skill decides the full directory structure by classifying ingest candidates into top-level categories.
- Rewrite operators run freely until convergence.

### Hosted mode

**A `.llmwiki.layout.yaml` file at the target root → hosted mode.**

- The user (or another skill) provides a **target directory** (e.g. `./memory/`) with a layout contract describing the full directory structure, what each directory is for, and any additional rules.
- You write **in-place** into the target (or into a sibling versioned directory if the contract says `versioning.style: sibling-versioned`).
- The contract is **authoritative**. You never create directories outside it. You never place entries in violation of its rules. Rewrite operators are suppressed whenever they would violate the contract.
- You still enforce every methodology invariant (narrowing chains, DAG parents, parent-file contract, unified `index.md`, etc.) within the contract's boundaries.
- Before any structural mutation (Rebuild, Fix, Join apply), snapshot the target tree to `<target>/<backup_dir>/<timestamp>/` if the contract has `backup_before_mutate: true` (default true).

### Detecting mode

Before any operation against a target directory, check:

```bash
test -f <target>/.llmwiki.layout.yaml && echo hosted || echo free
```

For operations that act on a **source** (Build's initial call, Extend's new source), the mode is decided by whether the target wiki has a layout contract — if you're building a new wiki, the user may drop a contract in an empty target directory first, then ask you to Build into it. Always check.

### Coexistence

In hosted mode, other tools or skills may write into the target between your invocations (for example, a daily journal skill appending to `./memory/daily/<today>/` via its own hook). This is expected. Reconcile external changes only when the user explicitly asks — run Validate, report findings, then run Fix if requested. Never assume the state you left the wiki in is still the state now.

## Core concepts

- **Entry** — a single knowledge unit, usually one `.md` file with YAML frontmatter plus a body.
- **Frontmatter** — the YAML header on an entry. The sole source of truth for all metadata about that entry. Indices and routing are derived from frontmatter; never the other way around.
- **Index** — the per-directory `index.md` file. Has `type: index`. Derived from children's frontmatter in its auto-generated fields.
- **Primary entry** — a leaf entry the router loads into the assembled context as a top-level content block when its activation matches.
- **Overlay entry** — a leaf entry appended to one or more primary entries' contexts when the overlay's own activation matches. Overlays are scope modifiers.
- **Activation signal** — a matchable pattern (file glob, import string, keyword, structural hint, escalation reference) the router uses to decide whether to load an entry.
- **Context profile** — a small structured summary the router builds before consulting any index. Activation signals are matched against the profile.
- **Narrowing chain** — the sequence of `focus` strings obtained by walking an entry's canonical `parents[0]` chain up to the root. A well-formed wiki has strictly-narrowing chains.
- **Operator** — one of four transformations (DECOMPOSE, NEST, MERGE/LIFT, DESCEND) that reshape the tree toward a token-minimal normal form.
- **Layout contract** — a YAML file at a hosted-mode target describing the required directory structure and rules.
- **Work manifest** — `<wiki>/.work/progress.yaml`, the durable progress record that makes every long-running operation resumable from interruption.

## Static structure rules

Every well-formed wiki satisfies all of these at rest:

1. Every directory containing entries has exactly one `index.md`.
2. The root `index.md` carries `generator: skill-llm-wiki/v1` in its frontmatter. Scripts use this marker as a safety check before mutating anything.
3. Child `focus` strings are strictly narrower than every ancestor's in the canonical `parents[0]` chain, walked to the root.
4. `parents[]` is required and non-empty on every non-root entry. The first element is canonical and determines filesystem location.
5. DAG acyclicity: walking `parents[]` transitively from any entry must never revisit the starting entry.
6. Canonical-parent consistency: an entry's file physically lives inside `parents[0]`'s directory. Soft parents (`parents[1..]`) list the entry with a `canonical_parent: <path>` marker in their own index — no physical duplication.
7. No duplicate `id` anywhere in the wiki. Aliases must not collide with live ids.
8. Every `entries[]` reference in an index resolves to an on-disk file.
9. Every overlay's `overlay_targets` resolves to an existing primary id or alias.
10. Every `links[].id` resolves to an existing id or alias.
11. **Parent file contract**: an `index.md` body may contain only navigation and orientation — no leaf content (no checklist items, no code fences, no multi-paragraph domain exposition, no data tables). The authored orientation zone has a 2 KB byte budget.
12. Leaf size caps: primary entries at most 500 lines; overlay entries at most 200 lines.
13. No forbidden configurations: no child with broader focus than its parent, no folder without an index, no entry listed in an index that doesn't exist on disk.

## Frontmatter schema

### Fields on every entry

- **`id`** (required, kebab-case). For leaves: matches filename without `.md`. For indices: matches containing directory name.
- **`type`** (required, enum): `primary` | `overlay` | `index`.
- **`depth_role`** (required, enum): `category` | `subcategory` | `leaf`.
- **`focus`** (required, one-line string). Strictly narrower than every entry in the canonical `parents[]` chain.
- **`parents`** (required, string[], length ≥ 1 for non-root). Each element is a relative path to a parent `index.md` or the parent's id. First element is canonical; additional elements are soft DAG parents. The root's `parents: []`.
- **`tags`** (optional, string[]).
- **`domains`** (optional, string[]).
- **`aliases`** (optional, string[]). Prior ids this entry has absorbed or inherited from rewrites.
- **`links`** (optional, array of `{id, relation}`). Typed cross-entry relations: `related-to`, `depends-on`, `supersedes`, `contradicts`, `example-of`, `referenced-by`.
- **`source`** (optional, object): `{origin, path, hash?}`. Drift detection.
- **`version`** / **`updated`** (optional, ISO date).
- **`nests_into`** (optional, string[]). Explicit hint to the NEST operator.

### Leaf-only fields (`type: primary | overlay`)

- **`covers`** (required, string[], 3–15 bullets). Concrete concerns this entry addresses. Each bullet is a short statement, not a restatement of the focus.
- **`activation`** (required for conditional primaries and all overlays). Object with any of:
  - `file_globs[]` — glob patterns against file paths in the profile.
  - `import_patterns[]` — strings to match against imports or dependencies.
  - `tag_matches[]` — tags the profile carries.
  - `keyword_matches[]` — keywords to find in the profile's text.
  - `structural_signals[]` — semantic patterns the profile includes.
  - `escalation_from[]` — ids of other entries; if any activate, this one does too.
- **`applies_to`** (optional): `"all"` or string[]. Languages, platforms, etc.

### Overlay-only fields (`type: overlay`)

- **`overlay_targets`** (required, string[]). Ids or aliases of primary entries this overlay attaches to.

### Index-only fields (`type: index`)

- **`shared_covers`** (required, string[]). Concerns shared by all children. Auto-computed as the intersection of children's `covers[]`, but authors may hand-augment.
- **`activation_defaults`** (optional). Activation-shaped object; children AND-narrow against it.
- **`orientation`** (optional, string). Short human/LLM orientation paragraph; preserved across regenerations.
- **`entries`** (auto-generated, array). Aggregated child metadata.
- **`children`** (auto-generated, string[]). Relative paths to child `index.md` files.

### Root-index-only fields

- **`generator`** (required): `skill-llm-wiki/v1`. Scripts check this before mutating.
- **`rebuild_needed`** (boolean, default false).
- **`rebuild_reasons`** (string[], default []).
- **`rebuild_command`** (string, default `skill-llm-wiki rebuild <wiki> --plan`).
- **`sources`** (array of objects, for multi-source wikis): one entry per ingested source with `origin`, `content_hash`, `added_at`.
- **`source_wikis`** (array, for joined wikis): one entry per merged source wiki with version and hash at merge time.
- **`mode`** (optional): `hosted` when operating under a layout contract.
- **`layout_contract_path`** (optional, string): relative path to the layout contract file, typically `.llmwiki.layout.yaml`.

## Unified `index.md` file format

Every directory has exactly one `index.md`. Layout:

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
orientation: |
  Pick the child matching the target operating system.
---

<!-- BEGIN AUTO-GENERATED NAVIGATION -->
# Installation

**Focus:** installing the product on supported platforms

## Children

| File | Type | Focus |
| ---- | ---- | ----- |
| [linux.md](linux.md) | 📄 primary | installing on Linux distributions |
| [macos.md](macos.md) | 📄 primary | installing on macOS |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
Pick the child matching the target operating system.
<!-- END AUTHORED ORIENTATION -->
```

**Rebuild contract:** content between the `BEGIN AUTO-GENERATED NAVIGATION` / `END AUTO-GENERATED NAVIGATION` markers is always replaced by the `index-rebuild` CLI. Content between the `BEGIN AUTHORED ORIENTATION` / `END AUTHORED ORIENTATION` markers is preserved verbatim. Authored frontmatter fields (`orientation`, `rebuild_needed`, custom keys) are preserved; derived fields (`entries`, `children`, `shared_covers`) are replaced.

## The four rewrite operators

Reshape trees toward a token-minimal normal form. Applied in fixed priority order: **DESCEND > LIFT > MERGE > NEST > DECOMPOSE**.

### DECOMPOSE (horizontal split)

**Rule:** If a single entry covers N ≥ 2 disjoint concerns, split it into N peer entries under a common parent. The parent holds what they share; each peer holds its specifics.

**Detection:** `covers[]` clusters into ≥2 disjoint groups by tag/keyword similarity; OR `activation.file_globs` contain patterns with no common prefix/suffix; OR body has ≥2 H2 sections each meaningful standalone; OR `covers[]` exceeds 12 items.

**Application:** partition covers into clusters; create sibling entries with narrower focus; hoist shared items to the parent index's `shared_covers[]`; add `aliases[]` entry pointing to the original id so existing references don't break; delete the original file.

### NEST (vertical specialisation)

**Rule:** If an entry's internal structure reveals narrower specialisations of its focus, extract them into leaf files under a new child folder; the entry becomes a parent index.

**Detection:** body has ≥3 H2 sections each a strict narrowing of the focus; OR `nests_into[]` is set; OR size exceeds leaf cap while sections are sequentially derived.

**Application:** create `<entry-id>/` folder; move each narrowing section to `<entry-id>/<specialisation-id>.md`; replace the original with `<entry-id>/index.md` carrying `type: index` and `shared_covers[]` computed from the new leaves; narrowing chain becomes strictly monotonic through the new index.

### MERGE / LIFT (redundancy collapse)

**MERGE — two siblings collapse into one.** Detection: `focus` similarity above threshold, `covers[]` overlap > 70%, compatible activation, compatible `parents[]`. Application: union the covers, pick the more general focus, take the union of activation and parents, write the merged entry with both original ids in `aliases[]`, delete the sources, rewire references via alias resolution.

**LIFT — single-child folder collapses up.** Detection: a non-root folder contains exactly one non-index entry. Application: move the child up one level, update its `parents[]` to point at the grandparent, delete the now-empty folder and its `index.md`, preserve the folder's id on the lifted child as an alias.

### DESCEND (gravity toward leaves)

**Rule:** Substantive domain knowledge must live at leaves. Parent indices contain only navigation and shared context. Push leaf-shaped content from parent bodies down into child leaves.

**Detection:** parent index body (authored zone) exceeds 2 KB budget; OR contains leaf-content signatures (checklist items, code fences, multi-paragraph exposition, data tables).

**Application:** create a new leaf (or append to an existing relevant one) to host the extracted content; move the content; leave a short link reference in the parent's orientation if navigation benefits.

### Priority rationale

Information-preserving reductions happen first (DESCEND moves content deeper without losing it; LIFT removes empty structure). Collapses happen next (MERGE reduces byte count). Expansions happen last (NEST and DECOMPOSE add structural surface area). This order prevents operators from creating structure that would immediately be collapsed.

### Contract-gating in hosted mode

Every operator application is checked against the layout contract **before** being accepted. Rejected moves include: NEST that would exceed a directory's `max_depth`; LIFT that would remove a contract-required directory; MERGE across dynamic subdirs where the contract treats them as separate (e.g. two different days in a `daily/` tree); DECOMPOSE that would place peers into a non-existing contract directory. Rejected moves are suppressed; remaining operators still run until convergence.

## Layout contract schema

A layout contract is a YAML file at the hosted-mode target's root: `<target>/.llmwiki.layout.yaml`. Presence of this file is the sole signal that enters hosted mode.

### Full schema

```yaml
mode: hosted

versioning:
  style: in-place                 # or: sibling-versioned
  backup_before_mutate: true
  backup_dir: .llmwiki.backups    # relative to target root

purpose: "Persistent memory for the agent across sessions"

# Additional hard invariants enforced by Validate and Fix on top of
# the methodology's defaults.
global_invariants:
  - "every leaf must declare a source.origin field"
  - "no leaf exceeds 300 lines"

layout:
  - path: knowledge
    purpose: "long-lived factual knowledge and reference entries"
    content_rules:
      - "each leaf is a self-contained fact"
      - "covers[] lists concrete concerns, not vague topics"
    allow_entry_types: [primary]
    max_depth: 3

  - path: daily
    purpose: "time-series daily journal"
    dynamic_subdirs:
      template: "{yyyy}-{mm}-{dd}"
      purpose: "entries from a single day"
      allow_entry_types: [primary]
      content_rules:
        - "one leaf per event or observation"
        - "past days are read-only except via explicit Fix"

  - path: policies
    purpose: "rules the agent must follow"
    allow_entry_types: [primary, overlay]

  - path: projects
    purpose: "active and archived project workspaces"
    children:
      - path: active
        purpose: "in-flight projects"
      - path: archive
        purpose: "completed or abandoned projects"
```

### Field semantics

- **`mode`** — must be `hosted`.
- **`versioning.style`** — `in-place` writes directly into the target; `sibling-versioned` produces `.llmwiki.vN` siblings but respects contract structure inside each version.
- **`versioning.backup_before_mutate`** (default true) — snapshot target to `backup_dir/<timestamp>/` before any structural mutation.
- **`versioning.backup_dir`** (default `.llmwiki.backups`) — relative to target.
- **`purpose`** (optional) — becomes the root index's `focus` if not authored otherwise.
- **`global_invariants`** (optional) — additional hard invariants enforced on top of the methodology defaults.
- **`layout`** (required) — array of top-level subdirectory specs.
- **`layout[].path`** (required) — directory name relative to target root. No `/`, no `..`.
- **`layout[].purpose`** (required) — becomes the directory index's `focus`.
- **`layout[].content_rules`** (optional) — per-leaf rules checked as soft signals by Validate.
- **`layout[].allow_entry_types`** (optional, default all) — which entry types are permitted.
- **`layout[].max_depth`** (optional) — hard cap on nesting within this subtree.
- **`layout[].dynamic_subdirs`** (optional) — marks the directory as a container for dynamically-named subdirectories.
- **`layout[].dynamic_subdirs.template`** (required within dynamic_subdirs) — placeholder template. Supported placeholders: `{yyyy}` `{mm}` `{dd}` `{hh}` `{mi}` `{ss}` `{iso}` `{slug}`. Resolved against the clock (or a user-supplied slug) at write time.
- **`layout[].dynamic_subdirs.purpose`** / `content_rules` / `allow_entry_types` — inherited by dynamically-created subdirectories.
- **`layout[].children`** (optional) — nested directory specs for fixed deeper structure.

### Contract validation

Before any operation in hosted mode, parse the contract and verify:

- `mode: hosted` is present.
- Every `path` is a legal single-segment directory name.
- No duplicate paths at the same level.
- `dynamic_subdirs.template` uses only supported placeholders.
- `children` nesting is well-formed (no cycles).
- `versioning.style: sibling-versioned` is only used where sibling naming is possible.

A contract that fails these checks aborts the operation with a clear error. Tell the user exactly which rule failed and where.

### Conflict resolution: contract always wins

When methodology defaults and the contract disagree, the contract wins:

- Rewrite operators cannot override contract structure.
- The narrowing chain is still enforced, but root `focus` comes from the contract's `purpose` if provided.
- Validation adds contract invariants on top of methodology invariants; it never removes methodology invariants.

A hosted wiki is strictly at least as constrained as a free wiki — never less. Quality is never compromised because the contract adds structure; the methodology's guarantees remain intact.

## Safety envelope

Every operation honors these rules. Break any of them and you have broken the skill.

1. **Free mode: source is immutable.** Never write inside the user's source folder. Ever.
2. **Hosted mode: contract defines the write surface.** Write only into directories the contract permits. Never create directories outside the contract. Never place entries in violation of its rules.
3. **Stage in `.work/` before touching the live wiki.** All intermediate artifacts (ingest records, drafted frontmatter, layout plans, validation reports) live under `<wiki>/.work/` during an operation. The live files only change during the commit phase at the end.
4. **Progress manifest before every per-item write.** `<wiki>/.work/progress.yaml` tracks current phase and next item. Flush it after every item so a SIGKILL leaves the run resumable.
5. **Run the full validator before commit.** Any hard-invariant violation aborts. Nothing becomes the new live state until validation is green.
6. **Atomic commit.** The final move into place and the current-pointer flip (free mode) or the snapshot-and-swap (hosted mode) are the last operations. Failure before commit leaves the previous state intact.
7. **Backup before structural mutation in hosted mode.** If the contract has `backup_before_mutate: true`, snapshot the target tree to `<backup_dir>/<timestamp>/` before Rebuild/Fix/Join apply.

## Hard validation invariants (checked by `validate`)

All of these are hard errors and block commit:

1. Every entry has required frontmatter fields for its `type`.
2. `id` matches filename (leaves) or directory name (indices).
3. `depth_role` matches actual tree depth.
4. Strict narrowing chain along canonical `parents[0]` up to the root.
5. Every `entries[]` reference in an index resolves to an on-disk file.
6. Every `overlay_targets` resolves to an existing primary id or alias.
7. Every `links[].id` resolves to an existing id or alias.
8. Non-root entries have non-empty `parents[]`.
9. DAG acyclicity — `parents[]` never forms a cycle.
10. Canonical-parent consistency — entry lives inside `parents[0]`'s directory.
11. No duplicate ids; aliases don't collide with live ids.
12. Size caps: primaries ≤ 500 lines, overlays ≤ 200 lines.
13. Parent file contract — index body authored zone ≤ 2 KB, no leaf-content signatures.
14. Every directory containing entries has a valid `index.md`.
15. No entry at depth > 0 outside an indexed directory.
16. Every relative markdown link in bodies resolves.
17. Counts in human-facing summaries match actual entry counts.
18. Stale-index detection — no leaf mtime newer than its containing index's mtime.
19. Source integrity — if `source.hash` is set, current upstream hash must match.
20. Cross-reference coherence — every soft-parent cross-reference resolves to a real canonical entry.
21. Root index carries `generator: skill-llm-wiki/v1`.

In hosted mode, add the contract's `global_invariants` to this list.

## Soft shape signals (reported by `shape-check`)

Non-blocking suggestions that feed the next Rebuild:

- **DECOMPOSE candidate**: `covers[]` clusters into disjoint groups, or exceeds 12 items.
- **NEST candidate**: ≥3 H2 sections each a strict narrowing, or `nests_into[]` is set.
- **MERGE candidate**: sibling pair with high focus similarity and >70% covers overlap.
- **LIFT candidate**: folder contains exactly one non-index entry.
- **DESCEND candidate**: index body authored zone exceeds budget or contains leaf signatures.
- **Coverage hole**: `shared_covers[]` empty or no overlap with children.
- **Golden-path regression**: a fixture's load set grew vs. the previous version.

## Operations

Every operation runs as a phased pipeline tracked in `<wiki>/.work/progress.yaml`. Each per-item phase writes a checkpoint after every item so an interrupted run resumes deterministically on the next invocation. In hosted mode, every phase honors the layout contract.

### Build

**Purpose:** create a new wiki from source(s).

**Phases:**

0. **preflight** — run the Node.js preflight (see "⚠ Preflight: verify Node.js is installed" above). If it fails, stop and relay the user-facing message. Do not proceed to phase 1.
1. **check-mode** — `test -f <target>/.llmwiki.layout.yaml` if the user gave you a target; otherwise default to free mode with sibling output.
2. **validate-contract** (hosted only) — parse the contract and verify the schema rules above.
3. **ingest** — `node scripts/cli.mjs ingest <source>` → JSON array of candidates. Save to `<wiki>/.work/ingest/candidates.json`.
4. **classify** — for each candidate, assign a category path. Free mode: cluster by similarity (use `draft-category` as a first-pass heuristic, fall back to your own semantic clustering for prose-heavy sources with no taxonomy). Hosted mode: map each candidate to one of the contract's `layout[].path` entries by matching candidate content against each directory's `purpose` + `content_rules`. If no contract directory fits, escalate to HUMAN (tell the user which candidates couldn't be placed and why).
5. **draft-frontmatter** — for each candidate, run `node scripts/cli.mjs draft-leaf` to get a script-first draft with a confidence score. If `needs_ai: true` or confidence is below your threshold, read the source file via `Read` and rewrite `focus` and `covers[]` into strong, concrete statements. Save each final frontmatter under `<wiki>/.work/frontmatter/<id>.yaml`.
6. **layout** — create the target version directory (`node scripts/cli.mjs next-version <source>` for free mode; for hosted mode create `<target>/` if empty or use the existing directory). Materialize each entry as `<wiki>/<category>/<id>.md` using the Write tool, combining drafted frontmatter + original body.
7. **operator-convergence** — apply the four rewrite operators in priority order. In hosted mode, check each proposed application against the contract before accepting. Record each application to `<wiki>/.work/operators/applied.yaml`. Stop when no operator reports a change.
8. **index-generation** — `node scripts/cli.mjs index-rebuild <wiki>` to emit `index.md` at every directory.
9. **validation** — `node scripts/cli.mjs validate <wiki>`. If any hard invariant fails, fix the offending frontmatter and re-run. Do not commit until validation returns 0 errors.
10. **golden-path** (optional) — if the user provided fixture queries, establish a baseline by routing each through the new wiki and recording the load set. Save to `<wiki>/.work/golden-path/baseline.yaml`.
11. **commit** — free mode: `node scripts/cli.mjs set-current <source> v<N>` to flip the current-pointer. Hosted mode in-place: the files are already in place; just archive `<wiki>/.work/` to `<wiki>/.shape/history/build-<timestamp>/`.

### Extend

**Purpose:** add new sources to an existing wiki without reprocessing existing entries.

**Phases:**

1. **resolve-current** — `node scripts/cli.mjs resolve-wiki <source>` (free mode) or treat the target directly (hosted mode).
2. **check-mode** — hosted vs free.
3. **ingest-new** — walk only the new source(s).
4. **classify-new** — classify each new entry against existing categories. In hosted mode, against the contract's `layout[]`. If nothing fits, create a new top-level category (free mode) or escalate to HUMAN (hosted mode — you may not invent new contract directories).
5. **draft-frontmatter-new** — same as Build's draft-frontmatter phase, for new entries only.
6. **copy-on-write** (free mode) — compute next version tag, create `<wiki-next>/`, copy the current version over, apply new entries into the affected branches. Hosted mode in-place: write new entries directly into the existing directories.
7. **index-rebuild-affected** — `node scripts/cli.mjs index-rebuild <wiki>`.
8. **validation** — full hard-invariant check.
9. **commit** — flip current-pointer (free mode) or atomic write-in-place (hosted mode). Archive `<wiki>/.work/` to `.shape/history/extend-<timestamp>/`.

Extend does not apply rewrite operators. Accumulated shape warnings are surfaced via `shape-check` and addressed by an explicit next Rebuild.

### Validate

**Purpose:** read-only correctness check.

**Command:** `node scripts/cli.mjs validate <wiki>` — exits 0 on clean, 2 on errors. Warnings are printed but don't affect exit code.

**Your job:** run the command, read the report, surface every finding to the user with the code (e.g. `PARENTS-REQUIRED`, `ID-MISMATCH-FILE`, `DUP-ID`) and the affected path. Do not auto-fix unless the user asks — use the Fix operation for repairs. In hosted mode, also note contract invariants separately so the user sees which layer is failing.

### Rebuild

**Purpose:** optimise structure via rewrite operators, produce a new version (or in-place updated tree in hosted mode).

**Phases:**

1. **validate-input** — the input wiki must pass hard invariants. If not, tell the user to run Fix first.
2. **check-mode** — free vs hosted; load contract if present.
3. **collect-candidates** — run `node scripts/cli.mjs shape-check <wiki>` and read `<wiki>/.shape/suggestions.md`. Score each candidate against fitness (density + weighted-content).
4. **dry-run-apply** — apply operators in priority order on an in-memory projected tree state. In hosted mode, contract-gate every proposed move. After each application, recompute fitness. Accept only if fitness strictly improves or a hard invariant is newly satisfied.
5. **iterate** — until no accepted moves.
6. **golden-path-check** — if fixtures exist, route each through the projected tree. Roll back any move that causes a regression.
7. **emit-plan** — write `<wiki>/.shape/rewrite-plan-<timestamp>.yaml`. Stop here if `--plan` was passed.
8. **backup** (hosted + in-place only) — snapshot target to `<backup_dir>/<timestamp>/`.
9. **apply** — execute the plan: copy current version to a new version directory (free mode) or apply changes in place (hosted + in-place), rewrite file locations, rebuild indices, re-validate.
10. **commit** — flip current-pointer (free) or finalize in-place (hosted). Archive work.

### Fix

**Purpose:** repair methodology divergences. Uses the same safety envelope, produces a new version (or in-place updated tree in hosted mode).

**Repair classes:**

- **AUTO** — script-deterministic repairs: missing `id` that matches filename, stale indices, derivable `parents[]`, broken `links[].id` with alias resolution, parent-file contract violations (extract leaked content to a new leaf), out-of-sync counts, `depth_role` mismatches, missing `aliases[]` after rename cascades.
- **AI-ASSIST** — script detects, you generate the repair content: missing `focus`, missing `covers[]`, `focus` failing the narrowing chain, DECOMPOSE needing semantic partition, source-hash drift needing fresh frontmatter from updated content.
- **HUMAN** — user must decide: cycles in `parents[]`, colliding ids that are not semantically identical, canonical-parent inconsistencies, orphaned overlay targets, contract violations with no clear repair.

**Modes:**

- `--dry-run` — plan only, no mutation.
- `--batch` — apply AUTO and AI-ASSIST, write HUMAN items to decisions file, exit.
- `--interactive` — apply each class in sequence, stop for HUMAN decisions inline.
- `--hard-only` — repair hard-invariant violations only.
- `--with-soft` — also address soft signals via operator primitives.

**Phases:** validate-input → scan-divergences → plan-fixes → apply-auto → apply-ai-assist → prompt-human → regenerate-indices → validate-again → golden-path → commit.

### Join

**Purpose:** merge N ≥ 2 existing wikis into one.

**Phases:**

1. **ingest-all** — read every source wiki's tree into memory.
2. **source-validate** — Validate each source. Any hard failure halts with "fix this source first."
3. **plan-union** — build an in-memory union of categories, entries, overlays, relationships.
4. **resolve-id-collisions** — policy:
   - `--id-collision=merge`: if frontmatter compatible, apply MERGE; merged entry inherits both ids in `aliases[]` and both source wikis in `source_wikis[]`.
   - `--id-collision=namespace` (default): rename each colliding entry `<source-prefix>.<original-id>`. Record the rename.
   - `--id-collision=ask`: halt, write to HUMAN decisions file.
5. **merge-categories** — for top-level categories with matching focus, category-level MERGE.
6. **rewire-references** — walk every `links[].id`, `overlay_targets`, `parents[]`; resolve via id → alias → rename map.
7. **apply-operators** — full operator-convergence on the unified tree.
8. **generate-indices** — full `index-rebuild`.
9. **validation** — hard invariants on the joined tree.
10. **golden-path-union** — each source's fixtures must still pass. Regressions halt for user decision.
11. **commit** — atomic move into target versioned directory. In hosted mode, both contracts must be compatible (same top-level paths and compatible rules) or a merged contract must be supplied at the join target.

**Source immutability:** every source wiki is read-only during the operation and byte-identical afterward.

## CLI subcommand reference

All subcommands are invoked via `node scripts/cli.mjs <subcommand> [args]`. Never read the source of any `.mjs` file — everything you need is documented here.

### `ingest <source>`

Walks a source directory, computes content hashes, emits an array of entry candidates.

- **Input:** `<source>` = absolute or relative path to a directory.
- **Output (stdout, JSON):** `{ "candidates": [ {id, source_path, absolute_path, ext, size, hash, kind, title, lead, headings}, … ] }` where:
  - `id`: kebab-case id derived from path
  - `source_path`: path relative to the source root
  - `hash`: `sha256:<hex>` content hash
  - `kind`: `prose` or `code`
  - `title`: first H1 or filename fallback
  - `lead`: first paragraph (up to 400 chars)
  - `headings`: array of `{level, text}` for every H1–H6
- **Exit codes:** 0 on success.
- **Determinism:** walk order is sorted by path.

### `draft-leaf <candidate-file>`

Script-first frontmatter draft for a single candidate. Takes a JSON file containing one candidate (as produced by `ingest`).

- **Input:** `<candidate-file>` = path to a JSON file with one candidate object.
- **Output (stdout, JSON):** `{ "data": <frontmatter-object>, "confidence": <0..1>, "needs_ai": <boolean> }`. If `needs_ai: true`, you must read the source file yourself and rewrite `focus` and `covers[]`.
- **Exit codes:** 0 on success.

### `draft-category <candidate-file>`

Deterministic category hint by directory prefix. Cheap first-pass classifier.

- **Input:** same as `draft-leaf`.
- **Output (stdout):** single-line category slug.
- **Exit codes:** 0 on success.

### `index-rebuild <wiki>`

Regenerate every `index.md` in a wiki, bottom-up. Preserves authored frontmatter fields and authored body content; replaces derived fields and the auto-generated navigation zone.

- **Input:** `<wiki>` = path to a wiki root (must contain an `index.md` with `generator: skill-llm-wiki/v1`).
- **Output (stdout):** one line summary: `rebuilt N index.md files`.
- **Exit codes:** 0 on success; non-zero on any error.
- **Safety:** the script verifies the root carries the generator marker before mutating anything. Running against a non-wiki directory is a no-op error.

### `index-rebuild-one <dir> <wiki>`

Rebuild a single directory's `index.md`. Useful for targeted refreshes.

- **Input:** `<dir>` = directory to rebuild; `<wiki>` = wiki root.
- **Output (stdout):** `rebuilt <path>`.
- **Exit codes:** 0 on success.

### `validate <wiki>`

Run all hard invariants against a wiki. Read-only.

- **Input:** `<wiki>` = wiki root.
- **Output (stdout):** one `[TAG] CODE  path` line per finding, then a summary `N error(s), M warning(s)`.
- **Exit codes:** 0 = clean, 2 = errors. Warnings do not affect exit code.

### `shape-check <wiki>`

Detect operator candidates and write findings to `<wiki>/.shape/suggestions.md`. Also updates the root `index.md` `rebuild_needed` flag when pending suggestions cross the configured threshold.

- **Input:** `<wiki>` = wiki root.
- **Output (stdout):** `N pending shape candidate(s)` followed by one `  OPERATOR  target / reason` entry per candidate.
- **Exit codes:** 0 on success.

### `resolve-wiki <source>`

Print the current live wiki path for a source (reads the current-pointer file).

- **Input:** `<source>` = source folder path.
- **Output (stdout):** absolute path to current live wiki, e.g. `/path/to/docs.llmwiki.v2`.
- **Exit codes:** 0 if a wiki exists, 3 if no wiki has been built yet.

### `next-version <source>`

Print the next version tag for a source (used when creating a new version).

- **Input:** `<source>`.
- **Output (stdout):** next tag, e.g. `v3`.
- **Exit codes:** 0.

### `list-versions <source>`

List all existing versioned wikis for a source.

- **Input:** `<source>`.
- **Output (stdout):** one `<tag>\t<absolute-path>` per existing version, sorted ascending.
- **Exit codes:** 0.

### `set-current <source> <version>`

Update the current-pointer file.

- **Input:** `<source>`, `<version>` (e.g. `v2`).
- **Output (stdout):** `current → v2`.
- **Exit codes:** 0.

### `--version` / `--help`

Print the CLI version string or this command list (condensed).

## How to invoke the skill

When the user asks for an LLM wiki operation:

0. **Run the Node.js preflight first.** See the "⚠ Preflight: verify Node.js is installed" section above. This is step zero of every operation — before reading the user's ask further, before resolving paths, before anything. If the preflight fails, stop and relay the user-facing message verbatim. Do not proceed to step 1 until preflight passes.
1. **Read the user's ask carefully.** Which operation? What's the source? What's the target? Confirm uncertain details before mutating anything.
2. **Identify the exact target.** Every operation acts on a specific directory. If the user says "my wiki," ask which one or resolve via `node scripts/cli.mjs resolve-wiki <source>`. Never run against a directory you inferred without confirmation.
3. **Detect mode.** Check for a layout contract at the target root. If present, operate in hosted mode and strictly honor the contract. If absent, operate in free mode.
4. **Plan the phases.** Use the TodoWrite tool for long operations so the user can see progress and interrupt if needed.
5. **Start with the lowest-risk phase.** For anything touching an existing wiki, run Validate first and report findings before proceeding to structural changes.
6. **Use the CLI for deterministic phases.** Ingest, index-rebuild, validate, shape-check, path resolution, version management — all via `node scripts/cli.mjs`. Cheaper and more consistent than reimplementing inline.
7. **Handle AI-intensive work in your own context.** Drafting `focus` and `covers[]` from prose, classifying with no taxonomy, semantic DECOMPOSE partitioning, AI-ASSIST Fix repairs — these are yours. Read the source files with `Read`, write the frontmatter with `Write`, verify it roundtrips.
8. **Verify before commit.** Always run Validate on the new state before commit. Never leave a wiki in a broken state.
9. **Stop after the requested operation completes.** Do not chain into Rebuild or Fix unless asked. Do not run `shape-check` on wikis the user didn't mention. Do not open sibling wikis for comparison.
10. **Surface information in the response text, never in side-effects.** If Validate finds soft signals or `rebuild_needed: true`, tell the user. Do not schedule, queue, or pre-execute any follow-up.

## Writing layout contracts on behalf of the user

If the user describes a desired hosted structure in natural language ("I want a memory folder with knowledge, daily entries per day, and projects with active/archive"), draft a `.llmwiki.layout.yaml` matching the description and **show it to the user for confirmation before writing the file**. Getting the contract wrong at Build time means every subsequent operation is constrained by the mistake, so always confirm.

## Common mistakes to avoid

- **Skipping the Node.js preflight.** It runs before every operation. Every operation. No exceptions. A failed preflight stops the operation; it is not a problem to work around.
- **Attempting to install Node.js automatically.** Never. The user controls their environment. You relay the install instructions and wait.
- **Reading any file other than this one.** The scripts, the README, the license, any notes — none of them. Everything you need is above.
- **Writing inside the user's source folder (free mode).** Never. Read-only. Always.
- **Writing outside the layout contract (hosted mode).** The contract is authoritative. If the user wants a new directory, they must update the contract first and ask you to re-Validate.
- **Writing leaf content into `index.md`.** Index bodies are navigation only. Content belongs in leaf files.
- **Skipping narrowing-chain checks.** A child's `focus` must be strictly narrower than every parent's. If you can't articulate how, the child is in the wrong branch.
- **Loading the whole wiki at query time.** The router is selective. If you're loading every file, routing is broken.
- **Proposing automation.** No hooks, no watchers, no schedules. Every action is an explicit user request against an explicit target.
- **Running operations the user didn't ask for.** If the user says "validate my docs wiki," run Validate. Do not continue into Rebuild, Fix, or shape-check. Do not touch sibling wikis.
- **Overwriting authored frontmatter fields during index rebuild.** The `index-rebuild` CLI preserves authored fields. If you're re-rendering an index by hand, do the same.
- **Forgetting the generator marker check.** When operating on an existing wiki, verify the root `index.md` carries `generator: skill-llm-wiki/v1` (the scripts do this automatically; if you're manually checking, don't forget).
- **Inventing contract directories in hosted mode.** Only the directories the contract lists exist. If nothing fits, escalate to HUMAN.
- **Mixing hosted and free mode in one operation.** A wiki is either hosted or free from the moment you detect it; don't switch partway.
- **Forgetting to flush the progress manifest.** Every per-item advance flushes; otherwise a crash loses work that was already done.
- **Running `shape-check` or `index-rebuild` against random folders.** The scripts protect against this via the generator marker, but don't rely on it — pass the correct wiki path explicitly.
