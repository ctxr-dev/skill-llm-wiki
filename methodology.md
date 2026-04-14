# LLM Wiki Methodology

> **Maintainer-only design reference.** This document is the underlying methodology specification for skill-llm-wiki. It is intentionally excluded from the installed artifact (`package.json` `files[]` does not list it) so it is NEVER loaded by Claude during a skill invocation — every operational rule Claude needs lives in `SKILL.md`. Do not link to this document from `SKILL.md` or reference it in any code path. It exists in the repo for humans maintaining the skill; reading it during a session is pure token waste.
>
> A filesystem-based pattern for structuring any body of knowledge so a language model can retrieve exactly the slice it needs — no more, no less — deterministically, safely, and with minimal tokens.

---

## 1. Purpose & Problem Statement

An **LLM wiki** is a filesystem-based knowledge store structured for deterministic, token-efficient retrieval by a language model. It is not a website, not a documentation system for humans, and not a search engine. It is a directory tree of markdown files organised so that when an LLM needs to answer a question, it can load precisely the relevant slice of the corpus and nothing else.

### The problem

When an LLM is given a large body of knowledge to work with, it typically faces one of two bad choices:

1. **Load everything.** Simple, loses context budget to irrelevant content, and collapses completely once the corpus exceeds the model's window.
2. **Load blindly.** Fast and cheap, but the model has no way to tell which files are relevant to the current question until it has already read them — so it either guesses (and misses) or retrieves by semantic similarity (which is imprecise and non-deterministic).

An LLM wiki solves this by encoding **explicit activation signals** in structured metadata. A router reads a tiny index, matches signals against the current task, and loads only the entries whose signals matched. The process is deterministic, cheap, and scales with the corpus's organisation rather than its size.

### Domain universality

This methodology is not tied to any particular subject matter. It applies to:

- Product documentation, API references, SDK guides
- Architecture notes, design documents, decision records
- Research papers, literature notes, experiment logs
- Operations runbooks, incident reports, on-call guides
- Policy libraries, legal documents, compliance checklists
- Tutorial collections, training materials, reference walkthroughs
- Business glossaries, product catalogs, domain vocabularies
- Source code explanations, generated API docs, build manifests
- Prompt libraries, agent instruction sets, evaluation fixtures
- Any other corpus that is too large to load whole but small enough to organise

The only constraint is that the corpus must have some structure — if every sentence depends on every other sentence (pure narrative), selective loading cannot help. For everything else, the pattern applies.

### When to use

- The corpus is larger than about 50 KB.
- Queries against it touch narrow slices, not the whole.
- The slice a query needs is predictable from signals in the query, the environment, or the user's context.
- The corpus grows or evolves over time and you want organisation to keep up.

### When not to use

- Tiny corpora (< 50 KB): just load everything, the overhead isn't worth it.
- Pure prose where every sentence depends on every previous one: selective loading breaks the narrative.
- Single-shot throwaway contexts: build cost is not recovered.
- Corpora where queries always need the whole thing: indices add overhead with no offsetting benefit.

---

## 2. Core Concepts & Vocabulary

These terms appear throughout the rest of the document. They are defined once here and used consistently. Every implementation of this methodology should adopt these names.

- **Entry.** A single knowledge unit — usually one `.md` file — with YAML frontmatter plus a body.
- **Frontmatter.** The YAML header on an entry file. The sole source of truth for metadata about the entry.
- **Index.** A file (`index.md`) that aggregates metadata from the entries in a directory. Derived from frontmatter, never hand-edited in its derived parts. Every directory holding entries has one.
- **Primary entry.** A leaf-type entry that the router loads into the assembled context as a top-level content block when its activation matches.
- **Overlay entry.** A leaf-type entry that is appended to one or more primary entries' contexts when the overlay's own activation matches. Overlays are scope modifiers — they enrich other entries' context with situationally-relevant content.
- **Index entry.** The per-directory file (`index.md`) itself. It has `type: index` and holds navigation metadata plus shared context for its children.
- **Activation signal.** A matchable pattern (file glob, import string, keyword, tag, semantic hint, explicit escalation reference) that the router uses to decide whether to load an entry.
- **Context profile.** A small structured summary the router builds before consulting any index. Activation signals are matched against the profile, not against the raw query.
- **Router.** The component (typically an orchestrator prompt, a small script, or a library function) that reads indices and decides what to load. The router is deterministic: same profile, same tree, same output.
- **Hook.** A filesystem event handler that keeps derived indices in sync with frontmatter whenever a file is edited.
- **Validator.** A script that enforces structural invariants on the wiki — id matches filename, required fields present, files referenced by indices exist, links resolve, size caps honored, DAG acyclic, etc.
- **Depth.** How many directory levels a file lives beneath the wiki root. Depth 0 is the root; deeper means more specific.
- **Narrowing chain.** The sequence of `focus` strings obtained by walking an entry's canonical `parents[]` chain up to the root. A well-formed wiki has strictly-narrowing chains.
- **Operator.** One of four transformations (DECOMPOSE, NEST, MERGE/LIFT, DESCEND) that reshape the tree toward a normal form.
- **Rewrite plan.** A file listing proposed operator applications — produced by Rebuild, reviewed by a user or AI, applied atomically if approved.
- **Work manifest.** `.work/progress.yaml` — the durable progress record that makes every long-running operation resumable from interruption.

---

## 3. Static Structure: The Hierarchical Index Principle

This section defines what a well-formed wiki looks like at rest. Section 3.5 describes how the tree evolves; this section describes the invariants every state must honor.

> **Every directory containing entries carries its own index. Indices deeper in the tree must be less abstract, more specific, and narrower in scope than their parents. A child index must not restate its parent — it must add resolution.**

### Depth-role rules

- **Depth 0 — the root.** Contains a single `index.md` (the root index) and a `.shape/` subdirectory for rewrite plans, suggestions, and history. No primary or overlay entry files live at depth 0. Every top-level category is a subdirectory.

- **Depth 1 — categories.** Each subdirectory of the root is a top-level category. Its `index.md` declares the category's focus, lists its children (either subcategories or leaf entries), and holds category-wide activation defaults and shared context.

- **Depth 2 and deeper — subcategories.** Each level narrows further. The `focus` string at depth N+1 must be strictly narrower than the `focus` at depth N. Children inherit activation defaults from the parent's `activation_defaults` block via AND-narrowing: a child activates only if the parent's defaults match AND the child's own signals match.

- **Leaves.** Primary and overlay entry files live at whatever depth is most specific for their scope. If a leaf could be made more specific by introducing a new child directory around it, the NEST operator (section 3.5) will eventually do so; at rest, leaves are at their maximally-specific home.

### Illustrative narrowing chain

A product-documentation wiki might look like:

```
docs.llmwiki.v3/
├── index.md                 focus: "the whole product"
├── installation/
│   ├── index.md            focus: "getting the product running"
│   ├── linux/
│   │   ├── index.md        focus: "installing on Linux distributions"
│   │   ├── debian.md       focus: "Debian and derivatives"
│   │   └── rhel.md         focus: "RHEL and derivatives"
│   └── macos.md            focus: "installing on macOS"
├── configuration/
│   ├── index.md            focus: "runtime configuration surface"
│   └── ...
└── api/
    ├── index.md            focus: "HTTP API reference"
    └── ...
```

Each `focus` at each depth is strictly narrower than its parent. A query about "Debian installation" descends root → installation → linux → debian.md, reading only four files' frontmatter plus one leaf body. A query about "REST API pagination" descends root → api → pagination.md and never touches the installation subtree.

### Inheritance semantics

- **Activation narrowing.** A child entry's effective activation is `parent.activation_defaults ∧ child.activation`. If the parent's defaults restrict to `.py` files and the child's own signals match `*/migrations/*`, the child effectively matches `.py` files in any migrations directory. Narrowing compounds down the chain.

- **Shared context.** A parent index may declare `shared_covers[]` — concerns that all its children have in common. When the router loads any descendant leaf, it prepends the ancestor chain's accumulated `shared_covers[]`, so the leaf body never repeats the common material. This is how the DECOMPOSE operator (section 3.5) can split an entry without duplicating its shared background.

- **Focus narrowing.** Every child's `focus` must be a strict narrowing of every parent's `focus` in the canonical ancestor chain. The validator enforces this textually (the child's focus should mention vocabulary that is a subset or refinement of the parent's scope) and structurally (the parent chain resolves without cycles).

### Parent file contract

Every directory has exactly one `index.md`. This file's purpose is navigation, orientation, and shared-context inheritance — **not** holding domain knowledge itself. Specifically:

- The frontmatter holds machine routing metadata (entries, children, shared_covers, focus, activation defaults, parents, type, depth_role).
- The body holds human and LLM orientation — a title, a rendered navigation table, optionally a short authored prose paragraph explaining what the subtree contains and how to choose between its children.
- The body **must not** contain substantive leaf-level content: no checklist items, no code fences, no multi-paragraph domain exposition, no extensive examples. If such content needs to exist in this part of the tree, it belongs in a leaf entry under the parent, not in the parent's index.
- The validator enforces this contract as a hard invariant. Violations are errors, not warnings. This is the contractual enforcement of the gravity-toward-leaves principle (section 3.5, DESCEND operator).

### Forbidden configurations

- A child index whose `focus` is identical to or broader than its parent's. If a parent and child have the same focus, one of them is redundant and the MERGE or LIFT operator should have collapsed them.
- A directory containing entry files without an `index.md`. Every indexed directory must have its index.
- An entry whose physical location on disk does not match `parents[0]`'s directory. The canonical parent determines where a file lives; deviation is a hard error.
- An entry listed in an index that does not exist on disk. Dangling references are errors.
- Duplicate ids. Every id must be unique across the wiki; aliases (historical ids from past rewrites) must not collide with live ids.
- Cycles in the `parents[]` DAG. Walking parents transitively from any node must never revisit the starting node.

### Why hierarchy instead of flat tags

Tags alone cannot provide progressive disclosure. A flat tag system loads the full set of tag-matching entries in one shot, regardless of how specific the match is. A hierarchical index allows the router to check the root index (one file, tiny), descend only into matched branches, and stop at the precise depth where the query's specificity is satisfied. Tags remain useful as a cross-cutting filter (section 11), but they complement the tree rather than replace it.

---

## 3.5. Dynamic Shape: The Four Rewrite Operators

The static rules in section 3 describe what the tree should look like at rest. This section describes how the tree should evolve — the four operators that Build, Fix, Rebuild, and Join apply to push any tree toward its normal form. These operators are the active mechanism by which a wiki is shaped; they are not passive validator checks.

### The four principles

- **(a) Horizontal decomposition.** If something is too complex and can be decomposed into several peer principles, it should become a horizontal division of one into many, with the common part as the shared parent.
- **(b) Vertical specialization.** If something can be derived from a more general concept into a deeper nested level, it should become nested — a folder with leaf files.
- **(c) Redundancy collapse.** If something can be combined, or its division and nesting are redundant because it's the same thing, it should be combined or lifted up.
- **(d) Gravity toward the leaves.** If knowledge can move down the hierarchy and let the upper levels carry less, it should. Specific knowledge lives in leaves; upper levels are for AI orientation and navigation.

Each principle becomes one operator below.

### Operator 1: DECOMPOSE (horizontal factoring)

**Rule.** If a single entry covers N ≥ 2 disjoint concerns, split it into N peer entries under a common parent. The parent holds what the peers share; each peer holds its specifics.

**Detection — frontmatter-first.** An entry is a DECOMPOSE candidate when one or more of:

- Its `covers[]` clusters into ≥2 disjoint topic groups by tag or keyword similarity.
- Its `activation.file_globs` contain patterns with no common prefix or suffix — indicating the entry fires for unrelated content.
- Its body has ≥2 H2 sections where each section has independent activation signals and its own internal cohesion.
- Its `covers[]` exceeds the per-entry bullet count cap while the entry itself isn't otherwise oversized (suggesting breadth rather than depth).

**Application.**

1. Partition the `covers[]` (and corresponding body sections) into clusters.
2. For each cluster, create a new sibling entry carrying that cluster's items, with a new id (derived from the cluster's dominant keyword) and a narrower `focus` describing just that cluster's concern.
3. Hoist shared items — covers that appear in all clusters, or the entry's lead paragraph describing the whole — to the parent index's `shared_covers[]` field.
4. Each new sibling gets `parents: [<common-parent>]` and an `aliases[]` entry containing the original entry's id so existing `links[].id` and `overlay_targets` references don't break.
5. Delete the original entry file; the parent index now lists the new siblings as its children.

**Post-condition.** The parent's `shared_covers[]` plus the union of new siblings' `covers[]` reconstructs the original entry's full coverage (content-preservation invariant). Each new sibling's `focus` is strictly narrower than the parent's.

### Operator 2: NEST (vertical specialization)

**Rule.** If an entry's internal structure reveals narrower specializations of its own focus, extract those specializations into leaf files under a new child folder; the entry becomes a parent index.

**Detection.** An entry is a NEST candidate when:

- Its body has ≥3 H2 sections, and each section is a strict narrowing of the entry's main focus (not just a different facet — that's DECOMPOSE territory).
- An explicit `nests_into[]` hint in frontmatter lists section ids to extract.
- The entry's size exceeds the leaf cap while its sections are sequentially derived (each builds on the previous).

The distinction between NEST and DECOMPOSE is the relationship between the parts:

- NEST: parts are **is-a** narrowings of the whole (subtypes, subcases, specializations).
- DECOMPOSE: parts are **has-a** components (independent concerns that happen to live together).

When both could apply, the tie-break ordering in "Priority" below decides.

**Application.**

1. Create a new directory `<entry-id>/` alongside the original file.
2. For each narrowing section, extract it to `<entry-id>/<specialization-id>.md`, carrying the section's content as the new leaf's body and drafting frontmatter for it (focus narrower, covers extracted from the section's bullets).
3. The original entry file is replaced by `<entry-id>/index.md`: a proper index entry with the same id as the original, `type: index`, `shared_covers[]` computed from the extracted leaves' common material, and the original's activation rules as `activation_defaults` for the new subtree.
4. Any references to the original entry's id continue to resolve — the id now belongs to the new index entry, and the narrowing chain is strictly monotonic through it.

**Post-condition.** The narrowing chain from root through the new index to each new leaf is strictly monotonic; the original entry's id lives on as the parent index id; no content is lost.

### Operator 3: MERGE / LIFT (redundancy collapse)

Two sub-operators sharing a goal: remove structure that doesn't earn its keep.

**MERGE — detection.** Two sibling entries are MERGE candidates when:

- Their `focus` strings have similarity above a configurable threshold.
- Their `covers[]` overlap by more than a configurable fraction (default 70%).
- Their activation signals are compatible (no mutually-exclusive matches).
- Their `parents[]` lists are compatible (MERGE preserves the union of soft parents).

**MERGE — application.**

1. Compute the merged `covers[]` as the union of both entries' items.
2. Compute the merged `focus` as the more general of the two (the one whose scope includes the other).
3. Compute the merged activation as the union of both entries' signals.
4. Compute the merged `parents[]` as the union (first element is the shared canonical parent; additional soft parents from either side survive).
5. Write the merged entry to disk under the canonical parent's directory, with both original ids listed in `aliases[]`.
6. Delete the two source files.
7. Rewire any `links[].id` or `overlay_targets` that referenced either original id — they resolve via the `aliases[]` field.

**LIFT — detection.** A folder is a LIFT candidate when it contains exactly one non-index entry. The structure of the folder adds nothing — the child could live one level up without losing narrowing.

**LIFT — application.**

1. Move the single child up one level into the grandparent's directory.
2. Update the child's `parents[]` to point at the grandparent.
3. Delete the now-empty folder and its `index.md`.
4. The deleted folder's id lives on as an alias on the lifted child (so references still resolve).
5. Regenerate the grandparent's index to list the newly-arrived child.

**Post-condition.** No two siblings have redundant coverage. No folder exists to hold a single file.

### Operator 4: DESCEND (gravity toward leaves)

**Rule.** Substantive domain knowledge must live at leaves. Parent indices contain only navigation, orientation, and genuinely shared context. Push any parent content that looks leaf-shaped down into a child leaf.

**Detection.** A parent `index.md` is a DESCEND candidate when:

- Its body (excluding auto-generated navigation and rendered shared_covers) exceeds a small byte threshold.
- Its body contains leaf-content signatures — checklist items, code fences, multi-paragraph domain exposition, tables of specific data.
- Its computed weighted-content score exceeds its depth-proportional budget (section 10).

**Application.**

1. Identify the leaf-shaped content in the parent's body.
2. Create a new leaf entry at the appropriate depth under the parent (or append to an existing relevant leaf if one is a natural host).
3. Move the content to the new leaf, draft its frontmatter, insert a short link reference in the parent's body if navigation benefits.
4. If no suitable child folder exists to hold the new leaf, this operator cooperates with NEST to create one.

**Post-condition.** Parent files contain no knowledge that would fit as a leaf's primary content. Parent bodies are navigation and orientation only.

### Cooperation and orthogonality

The four operators answer four different questions:

- **DECOMPOSE:** "Too many different things in one place — split sideways."
- **NEST:** "Too many narrowings of one thing in one place — split downward."
- **MERGE / LIFT:** "Not enough reason for this structure to be separate — collapse."
- **DESCEND:** "This parent is carrying weight that belongs in its children — push down."

They are designed to be orthogonal: for any candidate situation, exactly one operator should apply cleanly. When multiple operators could apply (rare), a fixed priority resolves the conflict.

### Priority for tie-breaking

When multiple operators could apply to the same subtree, the fixed order is:

1. **DESCEND** (information-preserving, reduces parent content)
2. **LIFT** (information-preserving, reduces structure)
3. **MERGE** (reduces byte count)
4. **NEST** (restructures without adding content)
5. **DECOMPOSE** (adds structural surface area, restructures the most)

The rationale: information-preserving reductions happen first, collapses next, expansions last. This ordering prevents Rebuild from wasting effort creating structure that would immediately be collapsed.

---

## 3.6. Rewrite Semantics, Convergence & Stability

The four operators need a principled termination condition, or Rebuild could loop indefinitely. This section formalises why the rewrite system converges to a stable normal form.

### Information density

For each subtree, compute:

```
density = unique_covers_count / total_bytes_in_subtree_excluding_parent_navigation
```

A well-shaped tree has uniformly high density. A poorly-shaped tree has low density at fat parents (too much generic content) or spiky density at over-specific leaves (too little content per entry). Density is a cheap metric to compute from frontmatter alone.

### Weighted content (the gravity metric)

For each file, compute:

```
weight = body_size × depth_penalty(depth)
```

Where `depth_penalty` is monotonically decreasing — for example, `depth_penalty(d) = max(1, 8 - d)` — so byte content at depth 0 costs 8×, at depth 4 costs 4×, at depth 7 costs 1×. The total tree weight is the sum over all files.

Gravity toward the leaves (principle d) becomes the concrete objective: minimise total tree weight. The optimiser naturally pushes content deeper because every byte saved at a shallow level counts more than a byte at a deep level.

### Fitness function

Rebuild optimises:

```
fitness(tree) = average expected_query_cost over golden-path fixtures
expected_query_cost(query) = routing_overhead + matched_leaves_bytes + attached_overlays_bytes
routing_overhead = sum over all index files walked of their frontmatter bytes
```

A rebuild is only accepted if `fitness` strictly improves (or stays equal while a hard invariant is satisfied). Coverage preservation and the narrowing-chain constraint are hard constraints on the optimisation space; everything else is softly optimised.

### Convergence argument

- **DESCEND** and **LIFT** strictly reduce total weight — content moves deeper or structure flattens.
- **MERGE** strictly reduces total byte count.
- **NEST** and **DECOMPOSE** redistribute content without increasing total bytes; their contribution to convergence is the narrowing-chain constraint. Once every path is maximally narrowing, NEST cannot apply. Once every sibling group is disjoint, DECOMPOSE cannot apply.

At any state, the set of applicable moves is bounded. In the absence of improving moves, Rebuild halts. Oscillation between DECOMPOSE and MERGE is prevented by the overlap threshold: if MERGE fires, the merged result's cluster disjointness drops below the DECOMPOSE threshold, so DECOMPOSE on the merged result will not fire.

### Confluence

Full Church-Rosser confluence is not claimed. Order of operator application can produce slightly different final trees in edge cases. Instead, Rebuild applies operators in the fixed priority order from section 3.5 and iterates until no operator reports a change. Two different starting orders may produce different final trees, but both will satisfy all static invariants from section 3.

### Stability across incremental edits

Extend and Fix operations localise change: adding or repairing one entry triggers operator candidates only in the affected branch, not a global rebuild. The hook writes soft signals to `.shape/suggestions.md` without forcing rewrites. Full Rebuild is an explicit user-initiated operation — the system never silently restructures on every edit.

---

## 4. Frontmatter Schema

The frontmatter is the sole source of truth for all metadata about an entry. Derived artifacts — the body's navigation blocks, the parent's `index.md`, routing decisions — all compute from frontmatter. No machine-readable metadata lives anywhere else.

### Fields for all entries

- **`id`** (required, string, kebab-case). Unique identifier. For leaf entries, must match the filename without `.md`. For `type: index` entries, must match the containing directory name.
- **`type`** (required, enum: `primary` | `overlay` | `index`). `primary` and `overlay` are leaf entries. `index` is the per-directory `index.md`.
- **`depth_role`** (required, enum: `category` | `subcategory` | `leaf`). Makes the hierarchical position explicit so the validator can enforce the narrowing chain and the parent-file contract.
- **`focus`** (required, one-line string). Describes the entry's scope. For non-root entries, must be strictly narrower than every entry in the canonical `parents[]` chain walked to the root.
- **`parents`** (required, string[], length ≥ 1 for non-root entries; may be `[]` only on the root `index.md`). Each element is a relative path to a parent `index.md` or the parent's id. **The first element is canonical** and determines filesystem location — the entry's file physically lives inside the canonical parent's directory. Additional elements are soft parents: the entry is listed in their indices as a cross-reference marked `canonical_parent: <path>`, without physical duplication. DAG shape is first-class and required; the router, validator, and all operators handle multi-parent entries uniformly. Cycle detection is a hard invariant.
- **`tags`** (optional, string[]). Cross-cutting classification. Useful for flat filtering that cuts across the tree.
- **`domains`** (optional, string[]). The high-level domains this entry belongs to.
- **`aliases`** (optional, string[]). Prior ids this entry has absorbed or inherited from rewrites. Populated automatically by MERGE, LIFT, and NEST. The validator uses aliases to resolve `links[].id`, `overlay_targets`, and `parents[]` references that would otherwise dangle.
- **`links`** (optional, array of `{id, relation}`). Explicit cross-entry relations: `related-to`, `depends-on`, `supersedes`, `contradicts`, `example-of`, `referenced-by`. Orthogonal to `parents[]`: parents define hierarchy and routing, links define typed relations that do not affect routing.
- **`source`** (optional, object with `origin`, `path`, optional `hash`). If the entry was built from external content, record the origin for traceability and drift detection. Extend and Fix operations compare the recorded hash to the live source to detect upstream changes.
- **`version`** or **`updated`** (optional, ISO date). For rebuild detection and staleness tracking.
- **`nests_into`** (optional, string[]). Explicit hint to the NEST operator listing H2 section ids that should be extracted as leaves on the next Rebuild. Authors use this to suggest structural changes without executing them.

### Fields specific to leaf entries (`type: primary | overlay`)

- **`covers`** (required, string[], 3–15 bullets). Specific concerns this entry addresses, granular enough that an LLM can decide relevance without reading the body. Each bullet is a short, concrete statement of a concern — not a restatement of the focus.
- **`activation`** (required for conditional primary entries and all overlays). Object with any of:
  - `file_globs[]` — glob patterns against file paths in the profile.
  - `import_patterns[]` — strings to match against imports or dependencies.
  - `tag_matches[]` — tags the profile carries.
  - `keyword_matches[]` — keywords to find in the profile's text.
  - `structural_signals[]` — semantic patterns the profile includes.
  - `escalation_from[]` — ids of other entries; if any of them activate, this one activates too.
- **`applies_to`** (optional, `"all"` or string[]). Languages, platforms, or other dimensions this entry applies to.

### Fields specific to overlay entries (`type: overlay`)

- **`overlay_targets`** (required, string[]). Ids or aliases of primary entries this overlay attaches to. When both the overlay's activation matches and one of its targets is loaded, the overlay's body is appended to that target's assembled context.

### Fields specific to index entries (`type: index`)

- **`shared_covers`** (required, string[]). Concerns that all children of this index share. Loaded by the router alongside any matching descendant, implementing DECOMPOSE inheritance. Auto-computed by the hook as the intersection of children's `covers[]`; authors may hand-augment for semantic concerns the heuristic misses.
- **`activation_defaults`** (optional, activation-shaped object). Defaults that AND-narrow with each child's own activation. Children inherit these implicitly.
- **`orientation`** (optional, string). A short paragraph of human and LLM orientation describing what lives under this subtree and how to choose between its children. Authored-preserved across regenerations.
- **`entries`** (auto-generated, array). Aggregated metadata for each direct child entry file (leaf or child index). Recomputed on every index rebuild from children's frontmatter.
- **`children`** (auto-generated, string[]). Relative paths to child `index.md` files of nested subdirectories.

### Fields specific to the root `index.md` only

- **`rebuild_needed`** (boolean, default `false`). Set to `true` by the shape-check hook when accumulated suggestions cross a threshold. Cleared by a successful Rebuild.
- **`rebuild_reasons`** (string[], default `[]`). Short human-readable reasons, one per pending operator candidate or golden-path regression.
- **`rebuild_command`** (string, required). The exact command users should run to start a Rebuild, default `"skill-llm-wiki rebuild <wiki-root> --plan"`. Hardcoded so every surface (router response, Validate output, any write subcommand) displays the same invocation string.
- **`sources`** (array of objects). For wikis built from external sources, one entry per source with `origin` (the source path), `content_hash`, and `added_at` (ISO date). Accumulates as Extend adds more sources.
- **`source_wikis`** (array, optional). For wikis produced by Join, one entry per source wiki with its original version and its content hash at merge time. Preserves lineage across chained joins.

### Validation surface

Every field has a deterministic validation rule. Missing required fields are hard errors. Inconsistent fields (id doesn't match filename, depth_role doesn't match actual depth, parents don't resolve) are hard errors. Soft signals (a cover bullet that duplicates another's, an activation glob that never matches anything) generate shape suggestions but not errors. The full list lives in section 8.

---

## 5. The Unified `index.md` File

Every directory containing entries carries exactly one `index.md`. There is no separate machine-readable index file. There is no separate `README.md`. The single `index.md` holds both the machine routing metadata (in its frontmatter) and the human/LLM orientation (in its body). This avoids the duplication that arises when two serializations of the same data are kept in separate files.

### File anatomy

```markdown
---
# ===== AUTO-GENERATED from children (do not edit by hand) =====
id: installation
type: index
depth_role: category
depth: 1
focus: "getting the product running on supported platforms"
parents:
  - ../index.md
shared_covers:
  - "prerequisite checks: disk, memory, network"
  - "post-install validation"
  - "common uninstall procedure"
activation_defaults:
  file_globs: ["**/*install*", "**/*setup*"]
entries:
  - id: linux
    file: linux/index.md
    type: index
    focus: "installing on Linux distributions"
  - id: macos
    file: macos.md
    type: primary
    focus: "installing on macOS"
children:
  - linux/index.md
# ===== end auto-generated =====

# ===== AUTHORED (preserved across rebuilds) =====
orientation: |
  This subtree covers getting the product running on any supported platform.
  Choose the child matching the operating system; each child holds the
  platform-specific prerequisites and commands.
rebuild_needed: false
# ===== end authored =====
---

<!-- BEGIN AUTO-GENERATED NAVIGATION -->
# Installation

The installation subtree covers getting the product running on any supported platform.

**Shared across all installation procedures:**

- prerequisite checks: disk, memory, network
- post-install validation
- common uninstall procedure

## Children

| File | Focus | Summary |
|------|-------|---------|
| [linux/](linux/index.md) | installing on Linux distributions | Distribution-specific installers |
| [macos.md](macos.md) | installing on macOS | pkg installer and Homebrew |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
This subtree covers getting the product running on any supported platform.
Choose the child matching the operating system; each child holds the
platform-specific prerequisites and commands.
<!-- END AUTHORED ORIENTATION -->
```

### Rebuild contract for the single file

The hook's build-index step parses the existing `index.md`, extracts the authored fields (`orientation`, any human-written content between the AUTHORED markers, any non-derived frontmatter keys), recomputes the derived fields from the directory's children, and writes the file back atomically.

- Content between `BEGIN AUTO-GENERATED` / `END AUTO-GENERATED` markers is always replaced on each rebuild.
- Content outside those markers — specifically between `BEGIN AUTHORED` / `END AUTHORED` markers — is preserved verbatim.
- Authored frontmatter fields (`orientation`, `rebuild_needed`, `rebuild_reasons`, `rebuild_command`, and any user-added custom keys) are preserved. Derived fields (`entries`, `children`, `shared_covers` when auto-computed, `depth`, `focus` when computed from children) are replaced.
- Determinism: given the same children frontmatter and the same authored content, the regenerated file is byte-identical across runs. Field ordering, list ordering, and spacing are fixed by the generator.

### Why a single file, not two

- **No duplication.** One file per directory, one source of truth, one hook target. Editing `index.md` manually (to tweak orientation) is natural and safe.
- **No efficiency loss.** Parsing frontmatter from markdown is a one-pass operation in every mainstream markdown library. The router reads only the frontmatter section and skips the body unless orientation is explicitly requested.
- **No determinism loss.** YAML in frontmatter is the same YAML it would be in a separate file.
- **No richness loss.** Every field that would have been in a machine-only file lives in frontmatter: depth, focus, parents, shared_covers, activation_defaults, entries, children. Nothing is dropped.
- **Strictly better for readers.** The body renders as a real markdown page with a title, a navigation table, and optional orientation — superior to raw YAML for both humans and LLMs browsing the wiki directly.

### Leaf entries

Leaf entries (`type: primary | overlay`) are regular `<id>.md` files with their own frontmatter and body. They are not `index.md` files. The single-file index convention applies only to directory-level files.

### Self-describing tree

Every `index.md` knows its own depth, its parents, its children, and its focus. A router can walk from any `index.md` upward (via `parents[]`) or downward (via `children[]`) without needing an external catalog or a global manifest. The wiki is its own map.

---

## 6. Activation & Routing Flow

The router is the component that assembles the load set for a given task. It is deterministic: given the same tree and the same context profile, it produces the same load set. It never calls an LLM to make routing decisions — the LLM consuming the assembled context is the router's caller, not its helper.

### Flow

1. **Build the context profile.** The router scans the current task and its environment for signals — file paths, imports, dependencies, tags the user supplied, domain keywords, explicit hints. It produces a small structured profile (a few hundred bytes).

2. **Load the root `index.md`.** Parse frontmatter only. This is cheap. Check the `rebuild_needed` flag; if set, capture `rebuild_reasons` and `rebuild_command` for inclusion in the final response (see section 9.5). Routing proceeds regardless.

3. **Match categories.** Walk each entry in the root index's `children[]`. For each child, check whether any `activation_defaults` (inherited up the chain) or entry-level activation signal intersects the profile. Mark matching children for descent.

4. **Descend matched branches.** For each matching child, load its `index.md` frontmatter. Apply AND-narrowing: a child branch activates only if the profile matches its own signals AND matched the parent's. Accumulate ancestor `shared_covers[]` as descent proceeds. Repeat recursively into deeper indices.

5. **Collect leaf primaries.** At every depth where leaf entries exist, evaluate their activation against the profile. Matching leaves become candidates for the load set. Each candidate inherits the accumulated ancestor `shared_covers[]`.

6. **Dedupe across DAG paths.** When a leaf is reached via a non-canonical parent (it is listed with `canonical_parent: <path>` in the non-canonical index), record the id but do not count it twice. The router's load set is deduplicated by `id` — the same entry cannot be loaded twice even when two different ancestor chains reached it. Soft parents affect retrieval only in the sense that descending the soft parent's branch still surfaces the entry; they do not multiply it in the final context.

7. **Collect overlays.** Independently of the primary walk, for every overlay entry whose activation matches the profile, resolve its `overlay_targets` (via id or alias) and attach its body to those targets' contexts at load time. Overlays never load standalone — only attached.

8. **Load file bodies.** Only now are leaf bodies read from disk. Everything up to this point was frontmatter parsing.

9. **Assemble context.** For each loaded primary, prepend the ancestor chain's accumulated `shared_covers[]`, append any attached overlays, and emit. The caller receives: the assembled load set, the original profile, and any `rebuild_needed` banner captured in step 2.

### Token accounting

At every step above, the router has loaded only the minimum needed: indices walked to reach matched leaves, leaf bodies for matched entries, overlay bodies for matched overlays. Unmatched subtrees are never touched. In a well-shaped wiki, most of the corpus is never read for most queries. The token cost of a single routing decision is dominated by the bodies of matched leaves, not the size of the wiki.

### The router is stateless

The router holds no state between queries. It re-parses `index.md` files from disk each time. On modern filesystems this is cheap, and it means two concurrent routers never race. Stateful caching can be added as an implementation optimisation, but the methodology assumes stateless routing as the baseline.

---

## 7. Hooks & Auto-Sync

The hook keeps derived indices in sync with leaf frontmatter whenever files are edited. It never performs structural changes — those are reserved for Build, Fix, Rebuild, and Join.

### Hook configuration

- **Trigger:** any filesystem write (Edit, Write, Create) inside a wiki directory.
- **Condition:** the affected path is inside a tree whose root contains an `index.md` with `depth_role: category` and `depth: 0` — this identifies the path as part of a managed wiki.
- **Scope:** restricted to the `.llmwiki.vN` versioned directory where the current pointer points. The hook never fires on source folders.

### Primary action: index regeneration

For each edit, regenerate the `index.md` of the affected directory and every ancestor directory up to the root.

- Read each existing `index.md`, preserve its authored fields and authored body content, recompute the derived frontmatter and the auto-generated body zone, write back atomically.
- Ancestor propagation is required because a child's frontmatter change can alter a parent's computed `shared_covers[]`, narrowing-chain validation, or `children[]` list.
- Write is atomic (temp-file plus rename) so partial writes are never observed by concurrent readers.

### Secondary action: shape-check

After the index rebuild, a lightweight analyzer evaluates whether any of the four operators from section 3.5 would now apply to the affected branch. The shape-check does not auto-apply operators; it produces two outputs:

1. Appends new findings to `.shape/suggestions.md` at the wiki root, with timestamps, operator name, target entry or branch, detection trigger, and suggested action.
2. If accumulated suggestions exceed a configurable threshold (default: 5 pending candidates, or any detected hard-invariant-warning-level signal, or any golden-path regression), set `rebuild_needed: true` in the root `index.md` frontmatter and populate `rebuild_reasons[]`. Since the router loads the root on every query, this flag is visible on every subsequent routing decision — users cannot miss it.

### Timing and failure handling

- Index rebuild timeout: short (≤10s). Shape-check timeout: ≤5s.
- Failures are logged to `.shape/hook-errors.log` but do not block the edit. The full Validate operation catches anything the hook missed.
- Idempotency: running the hook twice on unchanged state produces byte-identical output. Entry ordering, key ordering, shape-suggestion ordering — all deterministic.

### No auto-Rebuild, ever

Rebuild is a heavyweight operation: it moves files, renames ids, creates new folders, potentially restructures large portions of the tree. It must never fire from a hook. The hook's job is to keep indices current and to surface pending shape work — never to execute restructuring. Actual Rebuild requires an explicit user-initiated invocation (section 9.5 documents how users learn about pending rebuilds).

### Shape-check opt-out

For very large wikis where per-edit shape analysis becomes noticeable, a config flag disables the shape-check during hook runs. In that mode, shape analysis runs only as part of explicit Validate operations. The index rebuild always runs regardless; only the analyzer is skipped.

---

## 8. Validation Invariants

The validator enforces structural correctness in two layers: **hard invariants** (violations are errors and block Rebuild, Fix, or Join commit) and **shape signals** (soft suggestions that feed `.shape/suggestions.md` for future restructuring).

### Hard invariants

1. Every entry has frontmatter with all fields required by its `type`.
2. For leaf entries (`type: primary | overlay`), `id` matches filename without `.md`. For `type: index`, `id` matches the containing directory name.
3. `depth_role` matches the entry's actual directory depth and tree position.
4. **Narrowing chain.** Walking `parents[0]` (the canonical parent) transitively up to the root produces a strictly-narrowing sequence of `focus` strings.
5. Every `entries[]` reference in an `index.md` resolves to an on-disk file (leaf or child index).
6. Every overlay's `overlay_targets` resolves to an existing primary `id` or a registered alias.
7. Every `links[].id` resolves to an existing id or a registered alias.
8. **`parents[]` required.** Every non-root entry has a non-empty `parents[]`. Only the root `index.md` may have `parents: []`.
9. **DAG acyclicity.** Walking `parents[]` transitively from any entry must never revisit the starting entry. Applies to every element of `parents[]`, not just `parents[0]`.
10. **Canonical-parent consistency.** An entry's file on disk must live inside `parents[0]`'s directory. Soft parents list the entry with a `canonical_parent: <path>` marker in their own `index.md`; they must not hold a physical copy.
11. No duplicate `id` anywhere in the wiki. Aliases must not collide with live ids.
12. File size caps: leaf entries at most N lines (default 500); overlay entries at most M lines (default 200, lower because they are appended to other contexts).
13. **Parent file contract.** The authored portion of an `index.md` body plus the `orientation` frontmatter field together must not exceed a small byte budget (default 2 KB) and must not contain leaf-content signatures (checklist items, code fences, multi-paragraph domain exposition, data tables). Auto-generated content between the AUTO-GENERATED markers is exempt.
14. Every directory containing entry files has an `index.md` with `type: index` and a matching `depth_role`.
15. No entry exists at depth > 0 outside a directory that has an `index.md`.
16. Every relative markdown link in bodies resolves (via id, alias, or filesystem path).
17. Counts in human-facing summaries (root `index.md` body, any external README) match the actual number of indexed entries.
18. **Stale-index detection.** If any leaf entry's mtime is newer than its containing `index.md`'s mtime, the index is stale — error (the hook should have caught it).
19. **Source integrity.** If `source.hash` is set on an entry, the upstream content's current hash must still match; otherwise the entry is stale and Fix should regenerate it.
20. **Cross-reference coherence.** For every entry listed in a soft parent's `index.md` with `canonical_parent: X`, the file `X/<entry-id>.md` must exist and its `parents[0]` must point back to `X`.

### Shape signals (soft)

These do not block commits but are written to `.shape/suggestions.md` and drive the next Rebuild's agenda. Counter restarts because they are a separate list under a new heading — not a continuation of the hard-invariant numbering above.

1. **DECOMPOSE candidate.** Entry's `covers[]` clusters into ≥2 disjoint groups by tag/keyword similarity.
2. **NEST candidate.** Entry has ≥3 H2 sections, body size > half-cap, and each section is a declared narrowing via `nests_into[]` or passes the heuristic narrowing check.
3. **MERGE candidate.** Two siblings with `focus` similarity above threshold, `covers[]` overlap above threshold, compatible `activation`, compatible `parents[]`.
4. **LIFT candidate.** Folder contains exactly one non-index entry.
5. **DESCEND candidate.** Parent index body weight (after stripping auto-generated navigation) exceeds its depth-proportional byte budget.
6. **Coverage hole.** A parent index's `shared_covers[]` is empty or has no overlap with its children's actual `covers[]` — suggests the category has no shared essence and may be spurious.
7. **Golden-path regression.** The last Rebuild's recorded fixture load-sets are compared to the current tree. Any fixture whose load set grew is flagged.

### Severity and reporting

Every check has an ID, a severity (`error` | `warning` | `info`), a human-readable description, and a pointer to the offending entry. The validator's report is structured YAML so that other tools (Fix, Rebuild, Join) can consume it without re-parsing. The same report feeds the prominent banners in Validate CLI output.

---

## 9. Operations: Build, Extend, Validate, Rebuild, Fix, Join

`skill-llm-wiki` exposes six top-level operations. Every operation shares a common safety envelope (section 9.4): the source is never mutated, outputs are versioned siblings, pipelines are phased and resumable. The operations differ in what they do to the tree, not in how safely they do it.

### Build

**Purpose.** Construct a brand-new wiki from a source — a markdown corpus, a source tree, a whole project, or a heterogeneous folder set.

**Inputs.** One or more source paths, an optional wiki name (default derived from the first source's basename), optional hints (initial category suggestions, tag preferences, domain list).

**Outputs.** A new sibling `<name>.llmwiki.v1/` containing a fully-formed wiki tree with indices at every depth, passing all hard invariants.

**Algorithm.**

1. **Ingest.** Walk each source; extract candidate entries (one file becomes one entry, or split large files at H2 boundaries).
2. **Classify.** Group entries by similarity using tags, filename prefixes, directory structure, and domain keywords. Each cluster becomes a candidate category. Script-first with AI fallback for unstructured sources (section 9.6).
3. **Draft frontmatter.** For each entry, derive `id`, `covers[]`, `focus`, `tags`, `domains`, and `activation.*` fields. Script extractors handle structured sources (docstrings, filename patterns, import scans); AI handles prose-heavy sources where heuristic confidence is low.
4. **Layout.** Place entries in a draft directory tree based on classify output and the narrowing-chain rule.
5. **Operator convergence.** Apply the four rewrite operators from section 3.5 in priority order until no operator reports a change. The first output is already in normal form.
6. **Index generation.** Emit `index.md` at every directory, with frontmatter and body zones per section 5.
7. **Validation.** Run all hard invariants. Hard violations abort. Soft signals populate `.shape/suggestions.md`.
8. **Golden-path fixtures.** Run any user-provided fixture queries and record baseline load sets for future Rebuild comparisons.
9. **Commit.** Atomic move from `.work/` staging to the final wiki layout. Update the current-pointer file.

**Determinism.** Build is idempotent: running it twice on the same source produces byte-identical output (sorted keys, stable ordering, content-hash-derived ids, no wall-clock dependencies).

### Extend

**Purpose.** Incorporate new source content into an existing wiki without reprocessing what's already there.

**Inputs.** The path to the existing wiki (`<name>.llmwiki.v<N>/`), one or more new source paths.

**Outputs.** A new `<name>.llmwiki.v<N+1>/`. The previous version is untouched.

**Algorithm.**

1. **Ingest new sources.** Walk the new paths; compute hashes; extract candidate entries.
2. **Classify against existing categories.** For each new entry, find the best existing category using the same similarity logic as Build. If no match fits, create a new depth-1 category or place under a catch-all that the next Rebuild will absorb.
3. **Draft frontmatter** for the new entries.
4. **Copy-on-write.** Materialise the new version by copying the old version to the new directory, then applying the new entries into the affected branches.
5. **Index generation.** Rebuild indices only for affected branches (ancestors up to the root). Other branches' indices are copied unchanged.
6. **Validation.** Full hard-invariant check on the new version.
7. **Commit.** Update the current-pointer to `v<N+1>`.

Extend does not apply rewrite operators. Incremental additions may temporarily create shape-warning states; those are surfaced via `.shape/suggestions.md` and the root `rebuild_needed` flag, and addressed by an explicit next Rebuild. This keeps Extend fast and predictable.

### Validate

**Purpose.** Read-only correctness check on an existing wiki.

**Inputs.** The path to a wiki.

**Outputs.** A structured report of all hard and soft invariants with severity and target, written to stdout and to `.shape/last-validate-report.yaml`. No disk mutations except the report file.

**Algorithm.** Walk the tree, run each check from section 8, collect findings, sort by severity, emit report. Prints a prominent banner if `rebuild_needed` is set or if any soft signals are pending — so that any user running Validate immediately sees the current shape-health state.

### Rebuild

**Purpose.** Structural optimisation of an existing wiki. Apply the rewrite operators in priority order, produce a new version that is strictly better by the fitness function (section 3.6), guarded by golden-path regression checks.

**Inputs.** The path to a wiki, optional `--plan` (draft only, do not apply), optional `--apply <plan-file>` (apply a previously-drafted plan), optional subtree restriction, optional operator budget.

**Outputs.** A rewrite plan file at `.shape/rewrite-plan-<timestamp>.yaml` listing every proposed operator application with source and destination paths. If `--apply` is passed, a new `<name>.llmwiki.v<N+1>/` is produced.

**Algorithm.**

1. **Validate the input wiki.** Any hard violation aborts — the user must Fix first.
2. **Collect candidates.** Run full shape analysis; read `.shape/suggestions.md`; score each candidate against the fitness function.
3. **Dry-run apply.** Apply operators in priority order on an in-memory projected tree state. After each application, recompute fitness. Accept only if fitness strictly improves or a hard invariant is satisfied.
4. **Iterate.** Continue until no accepted moves or the operator budget is exhausted.
5. **Golden-path check.** Route each fixture query against the projected tree. If any fixture's load set grows, roll back the offending move from the plan.
6. **Emit plan.** Write the plan file. Await `--apply` for actual mutation.
7. **Apply** (separate invocation). Stage all moves into `.work/`, run full Validate on the staged result, atomically commit to a new version directory, update the current-pointer, archive the previous version's `.shape/history/` for retrospective inspection.

**Safety.** Rebuild never mutates the input wiki version. A failed apply (due to validation failure or golden-path regression) leaves nothing changed — the current-pointer still points at the prior version, and the failed `.work/` staging directory is preserved for diagnosis.

### Operator primitives

The four operators from section 3.5 are implemented as reusable primitives. Each primitive takes `(tree_state, target_entry_or_group)` and returns a new tree state plus a human-readable description of what changed. Build, Fix, Rebuild, and Join all orchestrate over these primitives — there is no rename/move/split logic outside them.

---

## 9.4. Safety: Sibling Versioned Outputs, Resumable Phases, Never Touching the Source

This is the safety envelope that makes `skill-llm-wiki` trustworthy. Users must be able to run any operation against a real folder without fearing data loss, and interrupted operations must resume cleanly. Three pillars: immutability of sources, versioned sibling outputs, phase-based resumable pipelines.

### Pillar 1 — Sources are immutable

Given any user-supplied source (for example `./docs`), no operation ever writes inside that folder. Instead:

- First Build creates a sibling `./docs.llmwiki.v1/` and populates it.
- Rebuild creates `./docs.llmwiki.v2/` next to the existing v1. Old versions are never touched.
- Extend (ingesting a new source folder into an existing wiki) reads existing content plus the new source, produces v2. v1 stays intact.
- Fix reads the current version, produces a new version with repairs applied.
- Join reads multiple source wikis, produces a new versioned sibling under a user-supplied name.

The user's original source folder is read-only to every operation, always, without exception. This is a hard invariant enforced at the operation level — no script in any phase may open a source file for writing.

### Naming convention

`<source-basename>.llmwiki.v<N>/`. The `.llmwiki.` infix is required and recognisable — it makes the generated directory visibly distinct from the source and prevents confusion. Version numbers are sequential integers. No date-based names; rollback should not require parsing timestamps.

### Current-version pointer

A small file at the sibling level, named `<source-basename>.llmwiki.current`, contains a single line with the current version identifier (`v3`). All tools read this file to resolve "the live wiki." Rollback is atomic: `echo v2 > docs.llmwiki.current`. Using a plain text file rather than a symlink ensures compatibility with filesystems that disallow symlinks (Windows by default, some archive formats, some sandboxes).

### Pruning old versions

Always explicit: the user invokes a prune subcommand with a keep count. Never automatic. Users may legitimately diff across many versions or roll back to older ones, so deletion is a conscious act.

### Multi-source wikis

When the user extends `./docs.llmwiki.v1` with `./arch`, the resulting `./docs.llmwiki.v2` still lives next to `./docs` — not next to `./arch`. The wiki's canonical sibling location is the first source's neighbourhood. The additional source is recorded in the new version's root `index.md` frontmatter under `sources[]`, but the physical wiki location remains stable as it grows.

### Pillar 2 — Phase-based pipelines

Every operation (Build, Extend, Rebuild, Fix, Join) runs as a sequence of named phases. Each phase has a precise input (the previous phase's artifact), a precise output, and a completion marker. The pipeline is orchestrated via a single file `<wiki>/.work/progress.yaml` that is updated atomically after every per-item write.

### Canonical phases (Build; other operations have similar shapes)

1. **ingest** — walk the source(s), read files, compute content hashes, write one metadata record per candidate entry to `.work/ingest/`. Per-item unit: source file path. Output: list of entry candidates with hash, size, detected type.
2. **classify** — assign each candidate a draft category path via clustering (script) or LLM classification (AI fallback). Writes `.work/classify/assignments.yaml`. Per-item unit: entry id.
3. **draft-frontmatter** — generate frontmatter for each entry. Script-first for structured sources; AI fallback for prose-heavy entries where heuristic confidence is below the threshold. Writes `.work/frontmatter/<entry-id>.yaml`. Per-item unit: entry id.
4. **layout** — place each entry in a draft directory tree using classify assignments and the narrowing-chain rule. Writes `.work/layout/tree.yaml`. Phase unit: whole-tree atomic.
5. **operator-convergence** — apply the four operators from section 3.5 until no operator reports a change. Records every application to `.work/operators/applied.yaml`. Per-iteration checkpoint.
6. **index-generation** — emit `index.md` for every directory, with frontmatter and body zones. Writes to `.work/indices/` first; the commit phase moves them into final locations. Per-item unit: directory.
7. **validation** — run all hard invariants from section 8 against the projected tree. Writes `.work/validation/report.yaml`. Phase unit: whole-tree. Hard violations halt the pipeline.
8. **golden-path** — run fixture queries through the projected router on the new tree (and, for Rebuild, through the old tree as well) and compare load sets. Writes `.work/golden-path/report.yaml`. Regressions halt the pipeline.
9. **commit** — atomic filesystem move from `.work/` staging to the final wiki layout. Update the current-pointer. Archive the `.work/` tree into `.shape/history/<timestamp>/` for post-mortem inspection.

### Progress manifest schema

`<wiki>/.work/progress.yaml`:

```yaml
wiki_path: ./docs.llmwiki.v2
operation: build
source_paths:
  - ./docs
source_hashes:
  "./docs": "sha256:abc123..."
started: 2026-04-13T10:30:00Z
last_progress: 2026-04-13T10:47:22Z
current_phase: draft-frontmatter
determinism_seed: 1142008
phases:
  ingest:
    status: done
    items_total: 127
    items_completed: 127
    artifact: .work/ingest/
    completed_at: 2026-04-13T10:32:11Z
  classify:
    status: done
    items_total: 127
    items_completed: 127
    artifact: .work/classify/assignments.yaml
    completed_at: 2026-04-13T10:35:03Z
  draft-frontmatter:
    status: in_progress
    items_total: 127
    items_completed: 84
    next_item: security-overview
    failed_items: []
  layout:
    status: pending
  operator-convergence:
    status: pending
  index-generation:
    status: pending
  validation:
    status: pending
  golden-path:
    status: pending
  commit:
    status: pending
```

### Resumption protocol

1. On any skill invocation targeting an existing `.work/progress.yaml`, read the manifest.
2. If the current phase is `in_progress`, resume from `next_item` within that phase.
3. Every per-item success flushes the manifest before returning. Flush cost is sub-millisecond; the atomicity of a single-file write is the transactional primitive.
4. On phase completion, atomically advance `current_phase` and write. The next phase's first item begins only after this write succeeds.
5. On resume, recompute hashes for all source paths. If any source hash has changed (the user edited a source file during processing), halt with a clear error — the user chooses to discard `.work/` and start fresh, or to manually resolve.
6. **Determinism guarantee.** Given the same inputs and the same `determinism_seed`, a resumed run must produce byte-identical output to an uninterrupted run. This requires: deterministic file ordering (sorted by path), deterministic id generation (content-hash-derived, not random), no wall-clock-dependent logic, and any AI call cached by its exact input so resumes replay cached responses instead of re-calling models.

### AI call cache

Every AI call in any phase writes its full request and response to `.work/ai-cache/<sha256-of-request>.json`. On resume, before calling the model, the phase checks the cache. Hit → use the cached response (zero tokens). Miss → call the model, write the cache, continue. This turns AI work into a deterministic function of input, so an interrupted draft-frontmatter phase can resume and skip the work it already did without re-paying tokens. It also makes "build the wiki twice to compare" cost-free and makes iteration on the pipeline itself safe.

### Failure modes the design handles explicitly

- **Hard kill (SIGKILL, crash, power loss).** Resume from the last flushed manifest entry. Per-item phases lose at most the in-flight item. Whole-tree phases lose the current iteration.
- **Disk full.** The last durable write before disk-full is preserved; resume from there. User frees space and re-runs.
- **Source modified during processing.** Halt with error on resume; user chooses to discard `.work/` or to resolve manually. Never silently proceed with stale source.
- **AI service unavailable.** Per-item phases mark the item in `failed_items[]`, continue with remaining items. At phase end, if any failed, the pipeline halts with a report. Resume retries failed items only.
- **Validation or golden-path failure.** The pipeline halts before commit. `.work/` is intact and inspectable. The user fixes or aborts. Nothing in the public wiki layout has been touched — the previous version remains live via the current-pointer.
- **User manually edits `.work/`.** Treated as a deliberate override; affected items are re-hashed and re-processed from the first phase they were last consistent with.

### No partial commits

The commit phase is the only phase that writes to user-visible wiki files. It is atomic: either the new version is fully materialised and the current-pointer is flipped, or nothing visible changes. Interruptions during commit (an extremely short window) can leave `.work/` staged and the current-pointer unmoved; resumption detects this and finishes the commit.

---

## 9.5. Rebuild Surfacing & User Prompting

Rebuild is never applied automatically, but users must never be left guessing whether a rebuild is pending. Five surfacing channels layer so a pending rebuild is visible at any point of interaction with the wiki.

### Channel 1: `.shape/suggestions.md`

Every shape-check run appends operator-candidate findings here. Format: one section per candidate with timestamp, operator name, target entry or branch, detection trigger, and suggested action. This is the detailed audit trail — long, comprehensive, read by Rebuild and by users who want the full history.

### Channel 2: Root `index.md` `rebuild_needed` flag

When the shape-check detects accumulated signals past the threshold, it sets `rebuild_needed: true` in the root `index.md` frontmatter along with `rebuild_reasons[]` (short human-readable reasons) and `rebuild_command` (the canonical invocation string). This frontmatter is authored-preserved, so users can also set or clear it manually.

### Channel 3: Router response banner (every query)

Because the router loads the root `index.md` on every routing decision, it always sees the `rebuild_needed` flag. When the router assembles its response for a caller, if the flag is set, the response includes a short banner:

```
⚠ REBUILD PENDING: <first 3 rebuild_reasons joined>
Run: <rebuild_command>
```

This is the single most important surfacing channel because it is automatic and unavoidable. Every interaction with the wiki exposes it. Callers — LLMs or tools consuming the router's output — see it inline and can forward it to end users.

### Channel 4: Validate CLI output

When a user runs `skill-llm-wiki validate <wiki-root>`, the output prints a prominent banner at the top listing all pending shape signals, with the total count and the canonical rebuild command. This answers the question "how do I know if my wiki is healthy?" — run Validate, read the banner.

### Channel 5: Every write subcommand

Every subcommand that mutates the wiki (Extend, Fix, add-entry, retag) performs a shape-health check before returning and prints the rebuild command if signals are pending. This is the belt-and-suspenders channel — even if the user never reads query responses and never runs Validate, the signal appears the next time they touch the wiki.

### Canonical command

Hardcoded in root `index.md` frontmatter as `rebuild_command`, default: `skill-llm-wiki rebuild <wiki-root> --plan`. Using `--plan` by default means the first invocation only produces a rewrite plan file for review; actual application requires `--apply` on a subsequent invocation. This makes the visible command safe to run — it never immediately mutates the wiki.

### Clearing the flag

After a Rebuild successfully applies and the golden-path fixtures pass on the rebuilt tree, the root `rebuild_needed` is set back to `false`, `rebuild_reasons[]` is cleared, and `.shape/suggestions.md` is archived to `.shape/history/rebuild-<timestamp>.md`. The user can also clear the flag manually; the methodology treats manual clearing as deliberate opt-out, not a bug.

### Why multiple channels

Any single channel can be missed: logs unread, banners skipped, CLIs not invoked. The five-channel contract guarantees that for any pattern of wiki interaction, at least one channel surfaces the pending rebuild. Users might ignore one banner, but the next Validate run or Extend command will raise it again. The signal is persistent and impossible to miss without explicit opt-out.

---

## 9.6. Script vs. AI: The Balance

`skill-llm-wiki` uses scripts for everything it can and AI only where scripts cannot deliver quality. The rule is **script-first with AI fallback**: every phase attempts deterministic processing first, and escalates to AI only for items where the heuristic's confidence is below a threshold.

### Phase responsibility

| Phase | Script | AI | Rationale |
|-------|--------|-----|-----------|
| ingest | 100% | — | Filesystem walk, content hashing, file-type detection. No judgment calls. |
| classify | Primary | Fallback | Clustering by filename, directory, tag hints, embedding similarity handles structured sources cheaply. AI only earns tokens on unstructured prose. |
| draft-frontmatter | Primary | Fallback | Extraction from H1, lead paragraph, docstrings, code signatures, AST for source code. AI drafts when prose-heavy and heuristic confidence is low. |
| layout | 100% | — | Mechanical placement given classify output and the narrowing-chain rule. |
| operator-convergence | 100% | Rare consultation | Detection rules from section 3.5 are frontmatter-based; scripts handle them. AI is consulted only for edge cases where thresholds are ambiguous, and even then the consultation is optional. |
| index-generation | 100% | — | Aggregate children, render template, write file. Mechanical. |
| validation | 100% | — | Every hard invariant is a deterministic check. |
| golden-path | 100% | — | Run router on fixtures, compare load sets, diff. |
| commit | 100% | — | Atomic filesystem operations. |
| rebuild plan review | Primary (scoring) | Optional (user or AI inspection before apply) | Script scores moves; user or AI approves the plan. Bulk of work is already deterministic by the time the plan is inspected. |
| Fix (AUTO class) | 100% | — | Deterministic repairs — see section 9.7. |
| Fix (AI-ASSIST class) | Detection | Repair | Script detects, AI generates repair content for things like missing focus or broken narrowing. |
| Fix (HUMAN class) | Detection | — | Script detects, human decides. AI is not used for these. |

### Confidence-threshold fallback

Script-first phases produce each output with a confidence score derived from how many heuristics agreed. If the score is below the threshold, the output is marked `needs_ai_fallback: true`. At phase end, all flagged items are batched into a single AI call covering the full set, rather than one call per item. For draft-frontmatter specifically, the batch includes the source snippet, the current best heuristic output, and a prompt asking the model to confirm or improve — so the AI's job is editing, not writing from scratch, which is substantially cheaper in tokens.

### Token cost expectations

- **Source-code wikis** (large codebases → documentation): ~5–10% of phases require AI fallback. Token cost is proportional to the number of files with poor docstrings or unstructured comments.
- **Prose wikis** (research notes, policy libraries, narrative documentation): ~60–80% of entries require AI draft-frontmatter. Token cost scales with prose volume; each call is bounded and cached.
- **Mixed wikis**: somewhere in between. The script-first approach keeps the code portion almost free token-wise; the prose portion is the dominant cost.
- **Rebuild of an existing wiki:** typically 0% AI work. Detection and application are fully deterministic; AI is consulted only when the user explicitly asks for AI plan review.
- **Extend with a new source:** identical cost profile to Build, but only for the new source's entries. Existing entries are not re-processed.

### Where AI is never used

- Index generation — purely templated.
- Operator detection and application — deterministic frontmatter comparison.
- Validation — rule-based.
- Commit — filesystem moves.
- Routing at query time — the router is a deterministic walker over `index.md` frontmatter. It never calls an LLM to decide activation. (The LLM consuming the assembled context is the caller, not the router itself.)

### Caching guarantees determinism

Every AI call's request is hashed (SHA-256 over the full prompt, model id, and system instructions) and the response is written to `.work/ai-cache/<hash>.json`. On any subsequent invocation with the same hashed input, the cache hit is free. Running the same Build twice on unchanged inputs with the same seed produces 100% cache hits and zero new tokens.

### Net effect

A user running `skill-llm-wiki build ./docs` pays tokens roughly proportional to the prose-intensity of their corpus, not to its total size. A script-heavy wiki costs tens of kilotokens; a prose-heavy wiki costs hundreds of kilotokens. Both are one-shot costs. Subsequent queries against the built wiki cost only the activated-slice size discussed in section 10.

---

## 9.7. Fix: Find and Repair Methodology Divergences

Fix brings an existing wiki back into compliance with the methodology. It is the operation a user runs when the wiki has been hand-edited into an inconsistent state, built with an earlier methodology version, or allowed to drift as soft signals accumulated. Fix is narrower than Rebuild: it targets correctness, not optimisation.

### Relationship to other operations

- **Validate** reports divergences, changes nothing.
- **Fix** repairs divergences that have clear corrections.
- **Rebuild** restructures for efficiency, guarded by fitness and golden-path checks.

Fix and Rebuild can both end up making structural changes, but their drivers differ. Fix runs when something is wrong; Rebuild runs when something could be better. They are separate commands with separate intents.

Fix uses the same section 9.4 safety envelope: sibling versioned output, phased pipeline, resumable, source wiki immutable.

### Repair classes

Every invariant from section 8 is tagged with one of three fix classes:

#### AUTO — script repairs deterministically

- Missing `id` that matches filename: compute and insert.
- Stale `index.md` (mtime drift): regenerate from children.
- Missing `parents[]` on a non-root entry: derive from directory location (`parents: [../index.md]`).
- `shared_covers[]` out of sync with children: recompute.
- Broken `links[].id` where the target has a resolved alias: rewire via alias.
- Broken relative markdown links: fix via filesystem search plus alias fallback.
- Cross-reference coherence: repair orphaned soft-parent listings.
- Parent file contract violation where leaf-shaped content leaked into an index body: extract the leaked content into a new leaf entry under the parent (forced NEST).
- Counts in human-facing files out of sync: recompute.
- `depth_role` mismatched with actual depth: reset.
- Missing `aliases[]` entries after a rename cascade: populate from the rename map.

#### AI-ASSIST — script detects, AI generates repair content

- Missing `focus` field: AI synthesises from title and lead paragraph.
- Missing `covers[]`: AI extracts 3–8 concern bullets from the body.
- `focus` that fails the narrowing-chain check: AI proposes a rewritten focus that strictly narrows the parent's.
- Ambiguous DECOMPOSE candidate flagged as hard (entry too large, multiple disjoint concerns): AI partitions the body into peer entries with drafted frontmatter.
- Source-hash drift (upstream source file changed): AI regenerates the entry's frontmatter against the new source content.

#### HUMAN — user must decide

- Cycle in the `parents[]` DAG: which edge to cut is a semantic choice.
- Two entries with colliding ids that are not semantically identical: which to rename.
- An entry whose canonical parent is inconsistent with its file location: move the file, or change the canonical parent?
- An overlay whose `overlay_targets` all disappeared: delete the overlay, or rewire it to new targets?

### Phases

Fix runs through the common safety envelope with these phases:

1. **ingest-wiki** — read the existing wiki state into memory.
2. **scan-divergences** — run all Validate checks; classify each finding by AUTO / AI-ASSIST / HUMAN.
3. **plan-fixes** — produce `.work/fix-plan.yaml` listing every proposed repair, its class, and its target. `--dry-run` stops here.
4. **apply-auto** — execute all AUTO fixes deterministically.
5. **apply-ai-assist** — batch AI-ASSIST items into minimal-round-trip AI calls, apply outputs.
6. **prompt-human** — for HUMAN-class items, halt with a structured question list. Interactive runs prompt inline; batch runs write `.work/human-decisions-needed.yaml` and exit.
7. **regenerate-indices** — rebuild all affected `index.md` files.
8. **validate-again** — run all hard invariants on the projected fixed tree. If any repair introduced a new violation (rare but possible), halt and report.
9. **golden-path** — compare retrieval on the old and fixed trees using stored fixtures. Accept only if no regression.
10. **commit** — atomic move, new version directory, current-pointer updated.

### Modes

- `skill-llm-wiki fix <wiki> --interactive` — runs through phases, stops at `prompt-human` for each decision, resumes after each answer. Suitable when a user is at a terminal.
- `skill-llm-wiki fix <wiki> --batch` — runs AUTO and AI-ASSIST only, writes HUMAN items to a decisions file, exits. User fills in the decisions file and re-runs with `--resume`. Suitable for CI or unattended runs.
- `skill-llm-wiki fix <wiki> --dry-run` — stops after `plan-fixes`, writes the plan, exits. Nothing is mutated. Use to preview before committing.
- `skill-llm-wiki fix <wiki> --hard-only` — repairs hard-invariant violations only; soft signals are left alone.
- `skill-llm-wiki fix <wiki> --with-soft` — also addresses soft signals by optionally invoking operator primitives for single-operator-fixable cases.

### What Fix does not touch

- Any file in the input wiki version directory (source is read-only).
- Golden-path fixtures themselves (fixes can change what a fixture returns, but not the fixture definitions).
- Soft signals unless `--with-soft` is passed.

### What Fix creates

- A new sibling `<name>.llmwiki.v<N+1>/` with the repairs applied.
- An updated current-pointer on successful commit.
- A preserved `.shape/history/` lineage from the prior version.

---

## 9.8. Join: Merging Multiple Wikis Into One

Join takes N ≥ 2 existing wikis and produces a single new wiki containing all of their knowledge, with overlapping structure merged and cross-references rewired. It is the operation users run when they have accumulated separate wikis that should become one — for example, merging `./docs.llmwiki.v3`, `./runbooks.llmwiki.v2`, and `./policies.llmwiki.v1` into a unified `./handbook.llmwiki.v1`.

### Inputs

- Two or more existing wiki paths. Each must be a valid versioned wiki directory that passes hard Validate.
- A target name and location for the joined wiki. Default: a sibling of the first input with a user-supplied base name at `v1`.
- Optional policy flags:
  - `--id-collision=namespace|merge|ask` — how to handle same-id entries across sources.
  - `--category-overlap=unify|keep-separate` — how to handle top-level categories with matching focus.
  - `--conflict-strategy=halt|best-effort` — whether to stop at the first irresolvable conflict or continue best-effort and report.

### Outputs

- A new sibling versioned wiki directory containing the merged content.
- A join report at `.shape/history/join-<timestamp>.md` documenting every resolved collision, every MERGE application, every rewired reference, and every entry that was renamed.
- Each source wiki is read-only during the operation and byte-identical afterwards.

### Phases

Join runs through the common safety envelope with these phases:

1. **ingest-all** — read each source wiki's full tree into memory, tagging entries by source. Compute content hashes.
2. **source-validate** — run full Validate against each source. Any hard-invariant failure halts — the user must Fix that source first.
3. **plan-union** — walk all sources and build an in-memory union model of their categories, entries, overlays, and relationships.
4. **resolve-id-collisions** — find entries with colliding ids across sources. For each collision, apply the policy:
   - `--id-collision=merge`: check frontmatter compatibility (overlapping covers, compatible parents, non-conflicting focus). If compatible, apply the MERGE operator; the merged entry inherits both source ids as `aliases[]` and both source wikis as `source_wikis[]` entries.
   - `--id-collision=namespace`: rename each colliding entry with a `<source-prefix>.<original-id>` id. Record the rename.
   - `--id-collision=ask`: write the collision to the decisions file and halt, same as Fix's HUMAN class.
5. **merge-categories** — for top-level categories with matching or near-matching `focus`, apply a category-level MERGE: their children become siblings under the unified category, reparented via DAG `parents[]`.
6. **rewire-references** — walk every `links[].id`, `overlay_targets`, and `parents[]` in the union. Resolve each reference against the union via id → alias → rename map. Unresolvable links are either dropped with warning (overlay) or escalated to HUMAN (primary links and parents).
7. **apply-operators** — run the full operator-convergence phase from section 9.4 on the unified tree. The joined wiki is rebalanced to a shape the operators would have produced if everything had been built together originally. Without this phase, the joined wiki would carry the shape of concatenated sources.
8. **generate-indices** — emit `index.md` for every directory in the unified tree.
9. **validation** — full hard-invariant check on the joined tree.
10. **golden-path-union** — run the union of all sources' fixture sets against the joined wiki's router. Every fixture must still return a non-regressive load set. If any source's fixtures regress, the join reports which and halts — the user either accepts the regressions (explicit flag) or aborts.
11. **commit** — atomic move into the target versioned directory, current-pointer set, join report archived.

### Invariants Join preserves

- No source wiki is modified. Byte-identical before and after.
- The joined wiki passes all hard invariants on commit.
- Every source's fixtures still pass on the joined wiki (or the user has explicitly accepted regressions).
- All ids resolve; no dangling references.
- Determinism: same sources plus same seed plus same policy flags produces byte-identical joined output. Re-running Join on the same inputs produces the same `vN+1`.

### Tri-phase for very large joins

If the union tree after `plan-union` exceeds a size threshold, Join automatically splits the operator-convergence phase into sub-passes (one per top-level category branch) so the convergence pass can resume between branches without holding the whole tree in memory. The progress manifest tracks per-branch completion.

### Joining joined wikis

Wikis produced by Join are regular wikis. A subsequent Join can merge a joined wiki with another wiki. The `source_wikis[]` field accumulates full lineage so later operations can trace any entry's provenance through multiple joins.

### Fix and Join together

Not in one invocation. If a source wiki fails `source-validate`, Join halts and the user runs Fix on that source first, then re-runs Join. This separation keeps each operation's failure modes easy to reason about.

---

## 10. Token-Efficiency Argument & Objective Function

This section formalises why the pattern saves tokens and how to measure the savings.

### Scenario analysis

- **Worst case** (all signals match everything): the router loads approximately the same content as a flat all-at-once load, with index overhead (a few KB) added. This is the pathological case where the wiki does not help.
- **Typical case**: index overhead is 2–5% of total corpus; matched load is 10–40% of total corpus; savings 60–88%.
- **Best case** (narrow query into a deeply nested tree): matched load is under 5% of total corpus; savings above 95%.

The deeper and better-shaped the tree, the closer to the best case. The rewrite operators exist to keep real wikis near the best case rather than at the typical case.

### Why the shape rules save tokens

- **DECOMPOSE reduces over-loading.** Before decomposition, a single oversized entry covering N concerns is loaded whenever any one concern matches. After, only the concerns whose activation matched are loaded. An entry covering three concerns where most queries need one saves roughly two-thirds of its per-query load.
- **NEST enables progressive disclosure.** Before nesting, a loaded entry carries its full specialisation set. After, the router can stop descent at the parent when no narrower leaf matches. A narrow-miss becomes an index lookup instead of a full-body read.
- **MERGE and LIFT reduce overhead.** Each collapsed structure is one fewer index entry the router must consider and one fewer cache line. The absolute savings per operator application are small, but they compound.
- **DESCEND concentrates weight at the leaves.** Content at shallow positions is loaded on every descent through the branch; content at leaves is loaded only when the leaf is selected. Every byte pushed from parent to leaf is a byte saved on queries that don't need that leaf.

### Objective function

Rebuild minimises a combined fitness function:

```
tree_weight       = Σ file_body_bytes(f) × depth_penalty(depth(f))
routing_overhead  = Σ index_body_bytes(i)    for all i in the tree
query_cost(q)     = routing_overhead_along_path(q) + matched_leaves_bytes(q) + attached_overlays_bytes(q)
fitness(tree)     = average query_cost over golden-path fixtures
```

Where `depth_penalty` is monotonically decreasing (example: `depth_penalty(d) = max(1, 8 - d)`), so shallow content costs more than deep content. Coverage preservation and the narrowing-chain constraint are hard constraints on the optimisation space.

### Practical metric for any proposed change

A reader of this methodology can evaluate any proposed structural change by asking: "does this reduce fitness?"

- A rename does not change fitness.
- A DESCEND always reduces fitness (weight moves deeper).
- A NEST reduces fitness when the nested leaves have distinct activations (fewer queries load the whole subtree).
- A MERGE reduces fitness when the merged entry is not loaded more often than either original would have been.
- A DECOMPOSE reduces fitness when the resulting peer entries have genuinely disjoint activations.

This gives every automated and manual decision a deterministic yardstick, rather than a bag of heuristics.

---

## 11. Relation Graph: Tags, Domains, Links, Overlays

The tree (section 3) gives each fact a canonical home. On top of the tree, four orthogonal composition mechanisms provide the cross-cutting relations a real knowledge base needs.

### The tree: canonical location

Every primary entry lives at exactly one canonical location on disk — determined by `parents[0]`. The narrowing chain from the root to that location defines the fact's "is-a" hierarchy.

### The DAG: multi-parent belonging

When a fact belongs to more than one parent, `parents[]` holds multiple entries. The first is canonical (filesystem location). Additional soft parents list the entry in their own indices with a `canonical_parent: <path>` marker. The router dedupes by id, so descending multiple parent branches never double-loads the same entry.

Use DAGs for facts whose belonging is genuinely multi-dimensional — for example, a security-hardening note that belongs under both `security/` and `deployment/`. Don't use DAGs to avoid choosing: if one parent is clearly canonical, make it the canonical parent and leave the other out.

### Overlays: many-to-many modifier content

Overlay entries (`type: overlay`) attach to one or more primary entries via `overlay_targets`. When the overlay's activation matches and the primary is loaded, the overlay's body is appended to the primary's assembled context. Overlays are scope modifiers — they add situationally-relevant content without creating new primary homes for the material.

Use overlays when content only makes sense as an augmentation of another entry: framework-specific guidance that applies to a base checklist, jurisdiction-specific clauses that modify a policy template, language-specific notes that enrich a general patterns document.

### Links: typed, directed relations

The `links[]` field on an entry declares arbitrary typed relations to other entries. The vocabulary includes:

- `related-to` — informal association, no directional implication.
- `depends-on` — this entry assumes another is understood first.
- `supersedes` — this entry replaces another (usually after a refactor or policy update).
- `contradicts` — this entry conflicts with another (useful during deprecation or migration).
- `example-of` — this entry is a concrete instance of a more abstract concept.
- `referenced-by` — inverse of the above relations.

Links are the graph layer on top of the tree and the DAG. They do not affect routing. They are used by higher-level tools for navigation, impact analysis, and deprecation tracking.

### Tags and domains: flat filters

Tags cut across the tree for quick filtering: "find everything tagged `security`." Domains are higher-level classifiers: "this entry belongs to the `frontend` domain." Both are orthogonal to the hierarchy — an entry under `installation/linux/debian.md` might carry tags `[package-manager, systemd]` and domains `[infrastructure]`, none of which match its canonical tree position.

### Composition

Queries can use any of these mechanisms orthogonally. A single retrieval can combine tree descent plus overlay attachment plus graph traversal plus tag filter. The methodology does not prescribe a query language — tools above this layer choose their own composition rules. The methodology's job is to make sure the substrate is rich enough that any reasonable composition is possible.

---

## 12. Summary

A correct implementation of this methodology exhibits all of the following characteristics, drawn from the sections above:

- **Frontmatter is the sole source of truth** for all entry metadata. Every `index.md` is derived from its children's frontmatter and never hand-edited in its derived parts.
- **The narrowing chain is a hard invariant.** Every non-root entry's `focus` is strictly narrower than every ancestor's in its canonical parent chain.
- **`parents[]` is required and DAG-first.** First element is canonical (determines filesystem location); additional elements are soft parents cross-referenced from other indices. Cycle detection runs on every validate.
- **A single `index.md` per directory** carries machine routing metadata in frontmatter and human orientation in the body. Parent files hold no leaf content — the parent-file contract is a hard invariant.
- **Activation signals** (file globs, import patterns, keyword matches, structural signals, escalation) drive lazy-load routing. The router reads only index frontmatter at navigation time; leaf bodies are loaded only at the end.
- **Four rewrite operators** (DECOMPOSE, NEST, MERGE/LIFT, DESCEND) shape the tree toward a token-minimal normal form. They are applied in fixed priority order and converge under the information-density and weighted-content metrics.
- **Five top-level operations** — Build, Extend, Validate, Rebuild, Fix, Join — all share one safety envelope: sources are immutable, outputs are sibling-versioned, pipelines are phased and resumable, and commits are atomic.
- **Deterministic replay.** Same inputs plus same seed produces byte-identical output. AI calls are cached by request hash so interrupted runs replay cached responses for free.
- **Script-first with AI fallback.** Scripts handle everything that can be done deterministically; the AI only draft-writes frontmatter from prose and classifies when no taxonomy exists. Token cost is proportional to the prose-intensity of the corpus, not its total size.

A wiki that satisfies all of the above is a correct implementation of the methodology. Any deviation is either a bug or a deliberate specialisation that should be called out explicitly in the wiki's own documentation.

---

## Appendix: Operation Quick Reference

| Operation | Purpose | Input | Output | Can be resumed | Produces new version |
|-----------|---------|-------|--------|----------------|---------------------|
| Build | Create a wiki from source | Raw source(s) | `<name>.llmwiki.v1/` | Yes | Yes (v1) |
| Extend | Add new source to existing wiki | Wiki + new source | New version | Yes | Yes |
| Validate | Report divergences | Wiki | Report | Not needed (read-only) | No |
| Rebuild | Optimise structure for fitness | Wiki | Rewrite plan, then new version | Yes | Yes (on apply) |
| Fix | Repair methodology divergences | Wiki | New version with fixes | Yes | Yes |
| Join | Merge multiple wikis | N wikis | New unified wiki | Yes | Yes |

All operations share the section 9.4 safety envelope. All operations are deterministic given the same inputs and seed. All operations preserve content — no knowledge is lost across any structural change.
