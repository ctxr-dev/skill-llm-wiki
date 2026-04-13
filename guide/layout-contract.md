# Layout contract (hosted mode)

A layout contract is a YAML file at the hosted-mode target's root: `<target>/.llmwiki.layout.yaml`. Presence of this file is the sole signal that enters hosted mode. When you read this file, you are operating on a hosted-mode target and must honor every rule below.

## Full schema

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

## Field semantics

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

## Contract validation

Before any operation in hosted mode, parse the contract and verify:

- `mode: hosted` is present.
- Every `path` is a legal single-segment directory name.
- No duplicate paths at the same level.
- `dynamic_subdirs.template` uses only supported placeholders.
- `children` nesting is well-formed (no cycles).
- `versioning.style: sibling-versioned` is only used where sibling naming is possible.

A contract that fails these checks aborts the operation with a clear error. Tell the user exactly which rule failed and where.

## Conflict resolution: contract always wins

When methodology defaults and the contract disagree, the contract wins:

- Rewrite operators cannot override contract structure.
- The narrowing chain is still enforced, but root `focus` comes from the contract's `purpose` if provided.
- Validation adds contract invariants on top of methodology invariants; it never removes methodology invariants.

A hosted wiki is strictly at least as constrained as a free wiki — never less. Quality is never compromised because the contract adds structure; the methodology's guarantees remain intact.

## Writing layout contracts on behalf of the user

If the user describes a desired hosted structure in natural language ("I want a memory folder with knowledge, daily entries per day, and projects with active/archive"), draft a `.llmwiki.layout.yaml` matching the description and **show it to the user for confirmation before writing the file**. Getting the contract wrong at Build time means every subsequent operation is constrained by the mistake, so always confirm.
