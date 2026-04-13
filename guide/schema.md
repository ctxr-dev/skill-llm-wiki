---
id: schema
type: primary
depth_role: leaf
focus: "frontmatter field schema and the unified index.md file format"
parents:
  - index.md
covers:
  - "fields common to every entry (id, type, depth_role, focus, parents, tags, domains, aliases, links, source, version, nests_into)"
  - "leaf-only fields (covers, activation, applies_to)"
  - "overlay-only fields (overlay_targets)"
  - "index-only fields (shared_covers, activation_defaults, orientation, entries, children)"
  - "root-index-only fields (generator, rebuild_needed/reasons/command, sources, source_wikis, mode, layout_contract_path)"
  - "unified index.md file layout with frontmatter + auto-generated navigation + authored orientation zones"
  - "rebuild contract: which fields/zones are preserved vs replaced on regeneration"
tags:
  - schema
  - frontmatter
  - index-format
activation:
  keyword_matches:
    - schema
    - frontmatter
    - index.md format
    - field
  tag_matches:
    - writing-frontmatter
  escalation_from:
    - build
    - extend
    - fix
    - join
---

# Frontmatter schema and unified index.md format

## Fields on every entry

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

## Leaf-only fields (`type: primary | overlay`)

- **`covers`** (required, string[], 3–15 bullets). Concrete concerns this entry addresses. Each bullet is a short statement, not a restatement of the focus.
- **`activation`** (required for conditional primaries and all overlays). Object with any of:
  - `file_globs[]` — glob patterns against file paths in the profile.
  - `import_patterns[]` — strings to match against imports or dependencies.
  - `tag_matches[]` — tags the profile carries.
  - `keyword_matches[]` — keywords to find in the profile's text.
  - `structural_signals[]` — semantic patterns the profile includes.
  - `escalation_from[]` — ids of other entries; if any activate, this one does too.
- **`applies_to`** (optional): `"all"` or string[]. Languages, platforms, etc.

## Overlay-only fields (`type: overlay`)

- **`overlay_targets`** (required, string[]). Ids or aliases of primary entries this overlay attaches to.

## Index-only fields (`type: index`)

- **`shared_covers`** (required, string[]). Concerns shared by all children. Auto-computed as the intersection of children's `covers[]`, but authors may hand-augment.
- **`activation_defaults`** (optional). Activation-shaped object; children AND-narrow against it.
- **`orientation`** (optional, string). Short human/LLM orientation paragraph; preserved across regenerations.
- **`entries`** (auto-generated, array). Aggregated child metadata.
- **`children`** (auto-generated, string[]). Relative paths to child `index.md` files.

## Root-index-only fields

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
