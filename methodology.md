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

An LLM wiki solves this by encoding each entry's **scope in a one-line `focus` string** plus a small set of optional hint tags, and routing semantically. A router (Claude) reads a tiny index, compares each entry's `focus` against the current task, and descends only into branches whose `focus` is relevant. Leaf files may carry optional per-leaf `activation` hints (glob patterns, keywords, tags) that Claude can consult when the semantic match alone is ambiguous, but the primary routing signal is the `focus` string. The process is cheap, scales with the corpus's organisation rather than its size, and is reproducible because `focus` strings are stable and deterministic to read.

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
- **Primary entry.** A leaf-type entry that the router loads into the assembled context as a top-level content block when its `focus` (and optionally its `activation` hints) make it relevant to the task.
- **Overlay entry.** A leaf-type entry that is appended to one or more primary entries' contexts when the overlay is judged relevant by its own `focus` and `activation` hints. Overlays are scope modifiers — they enrich other entries' context with situationally-relevant content.
- **Index entry.** The per-directory file (`index.md`) itself. It has `type: index` and holds navigation metadata plus shared context for its children.
- **Focus string.** The one-line `focus` field on every entry. Describes the entry's scope in concrete vocabulary. For non-root entries, strictly narrower than every ancestor's `focus` in the canonical chain. This is the primary routing signal: the router reads `focus` semantically and decides whether a branch is worth descending.
- **Activation hint (leaf only).** An optional per-leaf `activation` block carrying file globs, import patterns, keyword matches, tag matches, structural signals, or escalation references. Hints are advisory — they help the router disambiguate when `focus` alone is underdetermined. Leaves without an `activation` block are still routable from `focus` and leaf-level `covers[]`. Parent indices do **not** aggregate activation data from their children; per-leaf hints stay per-leaf.
- **Router.** The component that reads indices and decides what to load. In the current substrate the router is the runtime LLM (Claude) reading each index's frontmatter and choosing branches to descend by reading `focus` and `tags` semantically. A purely mechanical walker can still be bolted on for deterministic fixtures, but the first-class router is semantic.
- **Hook.** A filesystem event handler that keeps derived indices in sync with frontmatter whenever a file is edited.
- **Validator.** A script that enforces structural invariants on the wiki — id matches filename, required fields present, files referenced by indices exist, links resolve, size caps honored, DAG acyclic, etc.
- **Depth.** How many directory levels a file lives beneath the wiki root. Depth 0 is the root; deeper means more specific.
- **Narrowing chain.** The sequence of `focus` strings obtained by walking an entry's canonical `parents[]` chain up to the root. A well-formed wiki has strictly-narrowing chains.
- **Operator.** One of four transformations (DECOMPOSE, NEST, MERGE/LIFT, DESCEND) that reshape the tree toward a normal form.
- **Rewrite plan.** A file listing proposed operator applications — produced by Rebuild, reviewed by a user or AI, applied atomically if approved.
- **Phase-commit audit trail.** Per-phase (and per-operator-convergence-iteration) git commits in the private repo at `<wiki>/.llmwiki/git/` give every long-running operation a durable, introspectable history. The `.work/` directory is ephemeral scratch space for phases that need to stage intermediate artifacts — it is deleted at commit-finalize. See 9.9 for the full lifecycle. (True mid-phase resume is scoped as future work; today an interrupted operation is handled by rollback + re-run.)

---

## 3. Static Structure: The Hierarchical Index Principle

This section defines what a well-formed wiki looks like at rest. Section 3.5 describes how the tree evolves; this section describes the invariants every state must honor.

> **Every directory containing entries carries its own index. Indices deeper in the tree must be less abstract, more specific, and narrower in scope than their parents. A child index must not restate its parent — it must add resolution.**

### Depth-role rules

- **Depth 0 — the root.** Contains a single `index.md` (the root index) and a `.shape/` subdirectory for rewrite plans, suggestions, and history. No primary or overlay entry files live at depth 0. Every top-level category is a subdirectory.

- **Depth 1 — categories.** Each subdirectory of the root is a top-level category. Its `index.md` declares the category's focus, lists its children (either subcategories or leaf entries), and holds shared context for the subtree.

- **Depth 2 and deeper — subcategories.** Each level narrows further. The `focus` string at depth N+1 must be strictly narrower than the `focus` at depth N. The router descends by reading each child's `focus` and deciding whether it is relevant to the current task; there is no AND-filter on subcategory descent. Leaf-level `activation` hints, when present, are consulted only at leaves — they are not aggregated upward into parents and they do not act as a mandatory narrowing gate on the walk.

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

- **Semantic descent.** The router decides whether to descend into a child branch by reading the child's `focus` string and comparing it semantically to the current task. No AND-filter on activation signals is applied during descent; each child is evaluated on its own `focus` (and, for leaves, its `covers[]` and optional `activation` hints). Narrowing compounds down the chain via the focus-narrowing invariant below, not via activation aggregation.

- **Shared context.** A parent index may declare `shared_covers[]` — concerns that all its children have in common. When the router loads any descendant leaf, it prepends the ancestor chain's accumulated `shared_covers[]`, so the leaf body never repeats the common material. This is how the DECOMPOSE operator (section 3.5) can split an entry without duplicating its shared background.

- **Focus narrowing.** Every child's `focus` must be a strict narrowing of every parent's `focus` in the canonical ancestor chain. The validator enforces this textually (the child's focus should mention vocabulary that is a subset or refinement of the parent's scope) and structurally (the parent chain resolves without cycles). Because the router routes on `focus`, a strictly-narrowing chain is exactly what makes progressive disclosure possible.

### Parent file contract

Every directory has exactly one `index.md`. This file's purpose is navigation, orientation, and shared-context inheritance — **not** holding domain knowledge itself. Specifically:

- The frontmatter holds routing metadata — `focus`, `parents`, `type`, `depth_role`, `shared_covers`, and per-entry routing summaries in `entries[]` (each entry carries its own `id`/`file`/`type`/`focus`/`tags`, nothing else). Parent indices do not aggregate child-level activation data.
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

Tags alone cannot provide progressive disclosure. A flat tag system loads the full set of tag-matching entries in one shot, regardless of how specific the match is. A hierarchical index allows the router to read the root index (one file, tiny), descend only into branches whose `focus` strings match the task, and stop at the precise depth where the query's specificity is satisfied. Tags remain useful as a cross-cutting filter (section 11) — they appear alongside `focus` in each entry's summary for the same branch-choice decision — but they complement the tree rather than replace it.

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
- Its `activation.file_globs` contain patterns with no common prefix or suffix — indicating the entry's own leaf-level hints point at unrelated content.
- Its body has ≥2 H2 sections where each section has its own internal cohesion and a distinct set of concerns.
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
3. The original entry file is replaced by `<entry-id>/index.md`: a proper index entry with the same id as the original, `type: index`, and `shared_covers[]` computed from the extracted leaves' common material. The original's per-leaf `activation` rules (if any) stay with whichever extracted leaf carries the matching section's content; they are never promoted onto the new index.
4. Any references to the original entry's id continue to resolve — the id now belongs to the new index entry, and the narrowing chain is strictly monotonic through it.

**Post-condition.** The narrowing chain from root through the new index to each new leaf is strictly monotonic; the original entry's id lives on as the parent index id; no content is lost.

### Operator 3: MERGE / LIFT (redundancy collapse)

Two sub-operators sharing a goal: remove structure that doesn't earn its keep.

**MERGE — detection.** Two sibling entries are MERGE candidates when:

- Their `focus` strings have similarity above a configurable threshold.
- Their `covers[]` overlap by more than a configurable fraction (default 70%).
- Their per-leaf `activation` hints, if both carry them, are compatible (no mutually-exclusive globs or keywords).
- Their `parents[]` lists are compatible (MERGE preserves the union of soft parents).

**MERGE — application.**

1. Compute the merged `covers[]` as the union of both entries' items.
2. Compute the merged `focus` as the more general of the two (the one whose scope includes the other).
3. Compute the merged per-leaf `activation` as the union of both entries' hints (if either side has a block).
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
- **`activation`** (optional on leaves — advisory hint data only). Object with any of:
  - `file_globs[]` — glob patterns that point at file paths Claude might encounter in the task.
  - `import_patterns[]` — strings Claude can look for in imports or dependencies.
  - `tag_matches[]` — tags Claude can look for in the task context.
  - `keyword_matches[]` — keywords Claude can look for in the task text.
  - `structural_signals[]` — semantic patterns Claude can look for in the task.
  - `escalation_from[]` — ids of other entries; when one of those entries is already loaded, this entry is a natural companion.

  The router uses `activation` hints as disambiguation signals when `focus` alone is ambiguous. They are not a mandatory filter — a leaf whose `focus` clearly matches the task is loadable even if it has no `activation` block at all, and a leaf whose `focus` is clearly off-topic is skipped even if one of its keyword hints happens to appear in the task. Hints are never aggregated upward into parent indices.
- **`applies_to`** (optional, `"all"` or string[]). Languages, platforms, or other dimensions this entry applies to.

### Fields specific to overlay entries (`type: overlay`)

- **`overlay_targets`** (required, string[]). Ids or aliases of primary entries this overlay attaches to. When the overlay is deemed relevant (its own `focus` + optional `activation` hints match the task) and one of its targets is loaded, the overlay's body is appended to that target's assembled context.

### Fields specific to index entries (`type: index`)

- **`shared_covers`** (required, string[]). Concerns that all children of this index share. Loaded by the router alongside any matching descendant, implementing DECOMPOSE inheritance. Auto-computed by the hook as the intersection of children's `covers[]`; authors may hand-augment for semantic concerns the heuristic misses.
- **`orientation`** (optional, string). A short paragraph of human and LLM orientation describing what lives under this subtree and how to choose between its children. Authored-preserved across regenerations.
- **`entries`** (auto-generated, array). One summary per direct child entry. Each element carries only `id`, `file`, `type`, `focus`, and `tags` — just enough for Claude to decide whether to descend. Per-leaf `activation` blocks are **not** aggregated into the parent's `entries[]`; they stay on the leaf files and are consulted only when Claude loads a leaf's own frontmatter.
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
entries:
  - id: linux
    file: linux/index.md
    type: index
    focus: "installing on Linux distributions"
    tags: [linux]
  - id: macos
    file: macos.md
    type: primary
    focus: "installing on macOS"
    tags: [macos]
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
- **No richness loss.** Every field that would have been in a machine-only file lives in frontmatter: depth, focus, parents, shared_covers, entries, children. Per-leaf activation hints live on the leaves themselves. Nothing is dropped.
- **Strictly better for readers.** The body renders as a real markdown page with a title, a navigation table, and optional orientation — superior to raw YAML for both humans and LLMs browsing the wiki directly.

### Leaf entries

Leaf entries (`type: primary | overlay`) are regular `<id>.md` files with their own frontmatter and body. They are not `index.md` files. The single-file index convention applies only to directory-level files.

### Self-describing tree

Every `index.md` knows its own depth, its parents, its children, and its focus. A router can walk from any `index.md` upward (via `parents[]`) or downward (via `children[]`) without needing an external catalog or a global manifest. The wiki is its own map.

---

## 6. Semantic Routing Flow

The router walks the tree from the root down, loading only the indices and leaves that its semantic reading of each `focus` string says are relevant. In the current substrate the router is the runtime LLM (Claude) operating the skill — `focus` strings are short natural-language phrases and Claude decides relevance the same way a human would. The walk touches only frontmatter until the final leaf-body-read step; unmatched subtrees are never opened.

### Flow

1. **Read the task.** The router reads the user's current task (command, question, or context). No separate "context profile" is built up front — Claude compares each `focus` string to the task in natural language as it walks.

2. **Load the root `index.md`.** Parse frontmatter only. This is cheap. Check the `rebuild_needed` flag; if set, capture `rebuild_reasons` and `rebuild_command` for inclusion in the final response (see section 9.5). Routing proceeds regardless.

3. **Choose branches to descend.** Walk each record in the root index's `entries[]`. Each record carries `id`, `file`, `type`, `focus`, and `tags` — nothing else. For each child, Claude reads the `focus` string (and tags, if they help) and decides whether the branch is relevant to the task. There is no AND-filter on activation signals; each child is evaluated on its own `focus`. Irrelevant branches are skipped entirely; relevant ones are queued for descent.

4. **Descend matched branches.** For each relevant child that is an index, load its `index.md` frontmatter and repeat step 3 on its `entries[]`. Accumulate ancestor `shared_covers[]` as descent proceeds. Repeat recursively into deeper indices. Focus-narrowing (section 3) guarantees that a child's scope is strictly narrower than its parent's, so each descent step is a real refinement rather than a restatement.

5. **Collect leaf primaries.** When descent reaches a leaf entry in an index's `entries[]`, the leaf is added to the candidate load set iff its own `focus` (and, optionally, its per-leaf `activation` hints — globs, keywords, tag matches, escalation references — when the semantic decision is ambiguous) is relevant to the task. Leaf-level `activation` data stays on the leaf; it is never aggregated upward. Each candidate inherits the accumulated ancestor `shared_covers[]`.

6. **Dedupe across DAG paths.** When a leaf is reached via a non-canonical parent (it is listed with `canonical_parent: <path>` in the non-canonical index), record the id but do not count it twice. The router's load set is deduplicated by `id` — the same entry cannot be loaded twice even when two different ancestor chains reached it. Soft parents affect retrieval only in the sense that descending the soft parent's branch still surfaces the entry; they do not multiply it in the final context.

7. **Collect overlays.** Independently of the primary walk, any overlay entry whose own `focus` + `activation` hints make it relevant to the task resolves its `overlay_targets` (via id or alias) and attaches its body to those targets' contexts at load time. Overlays never load standalone — only attached.

8. **Load file bodies.** Only now are leaf bodies read from disk. Everything up to this point was frontmatter parsing.

9. **Assemble context.** For each loaded primary, prepend the ancestor chain's accumulated `shared_covers[]`, append any attached overlays, and use the result. The caller — the same Claude session that was routing — now has the narrow slice it needs and any `rebuild_needed` banner captured in step 2.

### Token accounting

At every step above, the router has loaded only the minimum needed: indices walked to reach matched leaves, leaf bodies for matched entries, overlay bodies for matched overlays. Unmatched subtrees are never touched. In a well-shaped wiki, most of the corpus is never read for most queries. The token cost of a single routing decision is dominated by the bodies of matched leaves, not the size of the wiki.

### Why `focus`, not aggregated signals

An earlier version of this methodology aggregated per-leaf `activation` signals upward into each parent index's `activation_defaults` block and treated routing as an AND-filter over those aggregations. That design was retired because (a) it made parent indices larger without improving routing precision — the aggregated signals were almost always the union of children's signals, which is what the `focus` string already expresses in natural language, and (b) keyword/glob intersection is strictly weaker than semantic reading of a one-line scope string by an LLM. The substrate now carries `focus` + per-entry `tags` in parents and keeps per-leaf `activation` as optional disambiguation hints on the leaves. Parent indices are smaller, routing is more accurate, and the convergence loop has one fewer thing to keep in sync.

### The router is replayable

The router holds no state between queries; it re-reads `index.md` files from disk each time. Because `focus` strings are stable wiki artifacts and Claude's semantic judgments on them are reproducible under the same prompt, the same task against the same tree produces the same load set on repeat invocations. Stateful caching can be layered on as an optimisation, but the methodology assumes re-walking from the root as the baseline.

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
21. **`GIT-01` — private git integrity.** When the wiki has a private git repository (guarded on the presence of `<wiki>/.llmwiki/git/HEAD`, i.e., an initialised repo), `git fsck --no-dangling --no-reflogs` must succeed under the skill's isolation environment (see 9.9), and — when the op-log is non-empty — the most recent logged operation's `pre-op/<op-id>` tag must exist and be reachable from `HEAD` via `git merge-base --is-ancestor`. This is an **ancestry check**, not a "working-tree matches HEAD" check: an operator who hand-edited the working tree after a clean commit would still pass `GIT-01`. A tighter "working tree matches most recent op" check is scoped as future work; for now, ancestry is the structural trust anchor for every rollback, diff, and `skill-llm-wiki history` query described in 9.9.
22. **`LOSS-01` — byte-range coverage.** When `<wiki>/.llmwiki/provenance.yaml` exists, for every source file recorded in it, the total byte coverage (sum of `sources[].byte_range` lengths on every target that references that source, plus `discarded_ranges[].byte_range` lengths) must equal the source file's size, and no two ranges may overlap on the same source. Source sizes are read from the manifest's `sources[].source_size` field (authoritative at ingest time via `provenance.mjs::recordSource`) so the check does not depend on the original source file still being available at validation time. The invariant is **guarded** on the presence of `.llmwiki/provenance.yaml`; wikis built before provenance tracking was introduced remain valid. Together with `GIT-01`, this is the load-bearing losslessness guarantee described in 9.9.

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

## 9.4. Safety: Sibling Outputs, Phase-Based Pipelines, Never Touching the Source

> **Supersession note.** The original §9.4 described a `.llmwiki.v<N>/` sibling-versioned layout and a hand-rolled `.work/progress.yaml` resumption manifest. Both have been superseded by the Phase 1–7 git-backed substrate documented in §9.4.2 (layout modes) and §9.9 (private git + per-phase commits). Where §9.4 and the later sections disagree, the later sections are authoritative. The text below is retained for historical context and because the core safety pillars (source immutability, phase decomposition, atomic commit) still hold.

This is the safety envelope that makes `skill-llm-wiki` trustworthy. Users must be able to run any operation against a real folder without fearing data loss, and interrupted operations must be safely recoverable. Three pillars: immutability of sources, stable sibling outputs, phase-based pipelines.

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

Every operation (Build, Extend, Rebuild, Fix, Join) runs as a sequence of named phases. Each phase has a precise input (the previous phase's committed state), a precise output, and a durable checkpoint (a git commit). The authoritative pipeline description lives in §9.9 "Operation lifecycle"; the phase names retained below are the same, the checkpoint substrate is the private git.

### Canonical phases (Build; other operations have similar shapes)

1. **pre-op snapshot** — `git add -A && git commit -m "pre-op <op-id>"`, tag `pre-op/<op-id>`. Rollback anchor for the entire operation.
2. **ingest** — walk the source(s), read files, compute content hashes and byte ranges, record per-target provenance to `<wiki>/.llmwiki/provenance.yaml`. Build-only in the current implementation.
3. **draft-frontmatter** — generate frontmatter for each entry. Heuristic extractor for structured sources; escalates to Claude (via `guide/tiered-ai.md`) for prose-heavy entries. Commit at phase end: `phase draft-frontmatter: wrote N leaves`.
4. **operator-convergence** — apply the five operators from §3.5 (DESCEND > LIFT > MERGE > NEST > DECOMPOSE) until no operator reports a change. **One git commit per iteration** so `git log pre-op/<id>..HEAD` reads like a per-iteration audit trail.
5. **review (optional, `rebuild --review` only)** — surface `git diff --stat pre-op/<id>..HEAD` and the per-iteration commit list; accept approve / abort / `drop:<sha>`. Drops land as `git revert --no-edit` commits and the loop re-prompts. Aborts reset to `pre-op/<id>`.
6. **index-generation** — emit a unified `index.md` for every directory. Commit: `phase index-generation: rebuilt N index.md files`.
7. **validation** — run all hard invariants from §8 (including `GIT-01` and `LOSS-01`) against the committed tree. Hard violations trigger `git reset --hard pre-op/<id>` + `git clean -fd`; the failed phase commits survive in the reflog for post-mortem.
8. **commit-finalize** — tag the final commit `op/<op-id>`, append to `<wiki>/.llmwiki/op-log.yaml`.

**Not yet implemented in the orchestrator:** a deterministic "golden-path" phase (fixture load-set comparison) and a `.work/` → `.shape/history/<op-id>/` archive step. Both are scoped as future work; the orchestrator currently just removes the live `.work/` scratch directory at the end of a successful operation.

### Resumption

The Phase 1–7 implementation does **not** persist a standalone `progress.yaml` manifest. Resumability relies on git itself: because every phase's output is a commit, an interrupted operation can be diagnosed with `skill-llm-wiki log --op <id>` (showing which phase commits landed) and either resumed manually (by rerunning the operation, which is currently a full re-build rather than a resume) or rolled back with `skill-llm-wiki rollback <wiki> --to pre-<op-id>`. A true in-place resume ("pick up where the last phase stopped") is scoped as future work.

**Determinism guarantee.** Setting `LLM_WIKI_FIXED_TIMESTAMP=<epoch>` pins `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` on every phase commit so same-input builds produce byte-identical commit SHAs across runs and across machines. Without the env var, commits inherit the ambient wall clock and SHAs drift. The *tree* objects (content-addressed) are still byte-identical either way — only the commit wrapper differs. Additional determinism requirements: sorted file ordering, content-hash-derived ids, no wall-clock-dependent logic, AI-call caching by request hash. See §9.9 "Determinism and resumability" for the implemented pieces.

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

## 9.4.2. Layout Modes: Sibling (Default), In-Place, Hosted

Section 9.4 establishes that sources are immutable and outputs are stable, phase-safe, resumable artifacts. Section 9.4.2 refines *where* those artifacts live. The skill rejects the "invent a new folder next to the source every time the wiki changes" model in favour of a single stable wiki per source with its history recorded in a private git repository (section 9.9). That reshapes the default naming convention and introduces two additional layout modes for situations where a sibling folder is not the right shape.

Every operation (Build, Extend, Rebuild, Fix, Join) accepts `--layout-mode <mode>` with one of three values. Implementations resolve the effective mode via `intent.mjs`; if the mode cannot be uniquely determined from the invocation, the skill refuses to run (see 9.4.3).

### Mode 1 — `sibling` (default)

`<source>.wiki/` lives next to `<source>/`, at the same filesystem level, with no version number in the name. One wiki = one sibling directory, forever. Subsequent Rebuilds update the same sibling in place; every prior state is reachable as a git tag in the private repository (`op/<id>` for the final commit of each operation, `pre-op/<id>` for the snapshot tag taken just before that operation started). The versioned `.llmwiki.v<N>` naming that section 9.4 previously mandated is retired — the private git is the authoritative history substrate, and separate sibling directories are no longer needed to represent prior wiki states.

Sibling mode exists because the user's working mental model is almost always "I want a wiki of this folder, next to this folder" and because the filesystem-local proximity makes discovery trivial for humans and tooling alike. The wiki is a plain directory of plain files the user can commit, tar, rsync, or open in any editor; the only opaque artifact is the private-git metadata under `.llmwiki/`, which the skill hides via an auto-generated `.gitignore` (see "User-repo coexistence" below).

### Mode 2 — `in-place`

The source folder **is** the wiki. `<source>/.llmwiki/git/` is created inside the source itself; the `pre-op/<first-op>` snapshot captures the user's original content byte-for-byte; all subsequent operations mutate the source directory directly. Rollback via `skill-llm-wiki rollback <source> --to pre-op/<first-op>` restores the original tree exactly. The source is still "immutable" in the sense that every change is reversible — but the directory at the source path is the live wiki.

In-place mode only runs when the user explicitly passes `--layout-mode in-place`. It is never chosen by default, never inferred from "the sibling would collide", and never substituted silently. A user who wants to transform a folder into a wiki without adding a sibling has to say so unambiguously.

### Mode 3 — `hosted`

The wiki lives at a user-chosen path that carries an explicit layout contract — a file `.llmwiki.layout.yaml` inside the target directory. The user passes `--layout-mode hosted --target <path>`, and the skill honours that path regardless of whether it is a sibling of the source or not. Hosted mode is the right choice for "my wiki lives at `./memory/knowledge/`, I don't want it next to any source folder", or for shared team wikis assembled from many sources under a central path. The layout contract recognition lives in `scripts/lib/paths.mjs::isWikiRoot`, which accepts both hosted targets and the `.llmwiki/git/` default recognition criterion.

### Collision handling

- `./docs` + `sibling` default → writes to `./docs.wiki/`. If `./docs.wiki/` exists and has `.llmwiki/git/` it is treated as a continuation (extend or rebuild). If it exists and does NOT have `.llmwiki/git/`, the skill refuses and prompts for a disambiguation (pick a new name, convert the foreign directory, or abort). Section 9.4.3 lists the exact scenario under `INT-01`.
- `./docs` where `./docs/.llmwiki/git/` already exists → the target IS in-place, regardless of whether the user asked for sibling. The skill detects this state, stops, and prompts: "this folder is already a managed wiki — did you mean `extend`, `rebuild`, `fix`, or to build a fresh one at a different name?" (`INT-02`).
- Any `<source>.llmwiki.v<N>/` legacy wiki encountered by any operation triggers the migration flow in "Legacy auto-migration" below.

### User-repo coexistence

A wiki's filesystem location often sits inside the user's own git repository (`./docs` under a project, `./memory/knowledge/` under a research notebook). Two gits must coexist without interfering with each other: **the user's project git**, which tracks the wiki content as part of the project, and **the skill's private git** under `<wiki>/.llmwiki/git/`, which records the skill's per-operation history. Three mechanisms keep them apart:

1. **Isolation env block.** Every `git` subprocess the skill spawns runs with `GIT_DIR=<wiki>/.llmwiki/git`, `GIT_WORK_TREE=<wiki>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<null-device>`, `HOME=<tmpdir()>`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and per-invocation `-c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=<null-device> -c core.autocrlf=false -c core.fileMode=false -c core.longpaths=true`. System config, user config, hooks from any source, signing keys, commit templates, and credential prompts from the user's environment are completely ignored. The `<null-device>` is `/dev/null` on POSIX and `NUL` on Windows. See 9.9 for the full block.
2. **Auto-generated wiki-local `.gitignore`.** On first operation, the skill writes `<wiki>/.gitignore` containing `.llmwiki/`, `.work/`, and `.shape/history/*/work/`. This file is a plain tracked wiki file; it hides the skill's internal metadata from any ancestor git repository that tracks the wiki directory. The user is free to edit, extend, or override it; they are encouraged to commit it (and the wiki content it accompanies) into their own project repo as part of the project's history.
3. **Scope discipline.** All `GIT_*` env vars are set only in the per-subprocess `env` option passed to `spawn()`. They never export to the parent Node process, never leak into the user's shell, never appear in `process.env` after the subprocess returns. All skill-owned env vars use the namespaced `LLM_WIKI_*` prefix (`LLM_WIKI_FIXED_TIMESTAMP`, `LLM_WIKI_NO_PROMPT`, `LLM_WIKI_QUALITY_MODE`, `LLM_WIKI_MOCK_TIER1`) so they cannot collide with unrelated tooling. JSON error output is toggled via the `--json-errors` CLI flag, not an env var.

The result: a user can run `skill-llm-wiki build ./docs` inside a project that already has its own `.git/`, with hostile hooks, signing requirements, or pre-commit checks — and the user's git is byte-identical afterwards. The `tests/e2e/coexistence.test.mjs` suite exercises this with deliberately hostile configurations and verifies byte-equality of the user repo.

### Legacy auto-migration

When an operation targets a `<source>.llmwiki.v<N>/` directory (the pre-9.4.2 sibling-versioned naming), the intent resolver halts with an `INT-04` structured prompt: "this wiki uses the legacy versioned layout; migrate to the new sibling format (recommended: `<source>.wiki/`), or stay on legacy?". On migration acceptance (`skill-llm-wiki migrate <legacy-wiki>`), the skill creates the new sibling, `git init`s it under `.llmwiki/git/`, copies the content of the directory the user named (note: `migrate` does not auto-resolve the highest `v<N>` via the legacy current-pointer — the user passes the exact directory to migrate), commits it as the genesis state with the tag `op/<migrate-op-id>`, and appends a migration entry to `<wiki>/.llmwiki/op-log.yaml`. The old `.llmwiki.v<N>/` directory is left untouched; users prune it manually later. Migration is always explicit and always prompted — it is never automatic.

### Choosing a mode

The default is sibling. In-place is for "convert this folder into a wiki, I do not want a sibling next to it". Hosted is for "the wiki should live at this specific path that is not next to any source". If the user's intent is unclear, the skill prompts rather than guesses (9.4.3). The guide leaves `layout-modes.md` and `in-place-mode.md` explain the user-facing UX; this section is the normative source for the behaviours those leaves document.

---

## 9.4.3. Ask, Don't Guess: User Intent Resolution

The 9.4 safety envelope and the 9.4.2 layout modes both rely on the skill knowing which folder to read, which folder to write, and which operation to run. When a user's invocation is ambiguous — two folders would both plausibly match, two modes are both compatible, or an operation would stomp on existing state — the skill must never guess. This section pins that rule as a hard contract and lists every scenario it covers.

### The rule

**The skill never infers user intent from ambiguous inputs, and Claude operating the skill does the same.** Every ambiguity is resolved by prompting the user before any mutation happens. The skill and its runtime orchestrator enforce this at two layers:

1. **Skill layer (CLI).** `intent.mjs` resolves the raw CLI arguments into a structured plan (`operation`, `layoutMode`, `source`, `target`, `flags`). If any ambiguity remains after applying defaults, the CLI exits with code 2 and emits a structured error body that lists every interpretation the resolver considered and the flag that would disambiguate each. The body is machine-parseable (JSON on stderr when `--json-errors` is passed, numbered-options text otherwise). Every ambiguous scenario has an `INT-NN` code so the error is indexable from test code, from the guide, and from Claude's prompt templates.
2. **Session layer (Claude).** The guide leaf `guide/user-intent.md` is activated whenever the user's natural-language request contains ambiguity keywords ("convert", "migrate", "update", "fix", "in place"). It instructs Claude to ask before running the skill — to resolve the ambiguity in conversation rather than to let the CLI error out and then paraphrase the error back to the user. The CLI error is a fallback; the first line of defence is Claude catching the ambiguity upstream.

### Scenarios the CLI refuses to guess

The normative code list lives in the `intent.mjs` header; the one below mirrors it. Each code is a stable identifier referenced by guide leaves, test fixtures, and Claude's prompt templates.

- **`INT-01` — default sibling name collision.** `build ./docs` would produce `./docs.wiki/`. If `./docs.wiki/` already exists and is not a skill-managed wiki (no `.llmwiki/git/`), the resolver refuses. Options surfaced: pick a different name, pass `--layout-mode in-place`, or abort.
- **`INT-01b` — explicit `--target` at a foreign non-empty directory.** `build --target ./some/dir` where the directory exists, is non-empty, and is not a skill-managed wiki. The resolver refuses and asks whether to choose a different target, pass `--accept-foreign-target` to deliberately write into it, or abort.
- **`INT-02` — source is already a managed wiki (implicit in-place).** `build ./docs` where `./docs/.llmwiki/git/` already exists. The resolver refuses. Prompt: "this is already a wiki — did you mean `extend`, `rebuild`, `fix`, or to `build` a fresh one at a different name?"
- **`INT-03` — target wiki exists but `build` was used.** The target is an existing skill-managed wiki but the invocation is `build`, which is reserved for fresh creations. The resolver refuses and suggests `extend` or `rebuild`.
- **`INT-04` — legacy versioned wiki encountered.** Any operation against a `<source>.llmwiki.v<N>/` directory triggers the migration prompt described in 9.4.2 "Legacy auto-migration".
- **`INT-05` — rollback without `--to`.** `rollback ./docs.wiki` with no `--to`. The resolver prints the op-log and asks which op to roll back to.
- **`INT-06` — source is a bare file.** `build ./README.md`. The resolver refuses and asks "do you want to treat this single file as a one-entry wiki, or point me at its parent folder?"
- **`INT-07` — multi-source Build/Extend without explicit canonical.** `build ./docs ./specs` with no canonical-home designation. The resolver refuses and asks which source determines the sibling location and which is being merged in.
- **`INT-08` — source inside a dirty user git repo.** The source is tracked by a user git that has uncommitted changes. The resolver warns and asks the user to commit or stash, or to pass `--accept-dirty` as a deliberate override.
- **`INT-09a` — `--layout-mode in-place` combined with `--target`.** Mutually exclusive flags: in-place uses the source path, a `--target` would contradict it. The resolver refuses and asks which the user actually wants.
- **`INT-09b` — `--layout-mode hosted` invoked without `--target`.** Hosted mode requires an explicit target path. The resolver refuses and asks for one.
- **`INT-10` — unknown `--layout-mode` value.** Anything other than `sibling`, `in-place`, or `hosted`. The resolver refuses, lists the valid values, and exits.
- **`INT-11` — unknown CLI flag.** `parseSubArgv` surfaces unknown flags as an `INT-11` error so every "did you mean…?" case funnels through the same structured-error code and can be caught uniformly by scripts and tests.
- **`INT-12` — ambiguity reached non-TTY interactive resolution.** An earlier ambiguity would normally have been resolved by prompting the user, but stdin is not a TTY (or `LLM_WIKI_NO_PROMPT=1` / `--no-prompt` is set), so the skill refuses to guess. Emitted from `cli.mjs` when `NonInteractiveError` is caught. The resolving "flag" is to re-run the command in an interactive terminal, or to add the disambiguating flag directly.
- **`INT-13` — unknown `--quality-mode` value.** Anything other than `tiered-fast`, `claude-first`, or `deterministic`. The resolver refuses, lists the valid values, and exits.

### Non-interactive fallback

When the skill is invoked from CI or a script — `stdin` is not a TTY, or `LLM_WIKI_NO_PROMPT=1` is set, or `--no-prompt` is passed — every ambiguity is a hard error with exit code 2 and no interactive recovery path. There are no silent defaults. This is the contract that makes scripted `skill-llm-wiki` calls safe: a script that invokes the skill with ambiguous arguments fails loudly rather than quietly producing the wrong wiki.

### The Claude-session obligation

The guide's `user-intent.md` and `hidden-git.md` leaves together tell Claude at routing time to resolve intent in conversation, not in CLI errors. The scenarios Claude must catch before running the skill:

- Verbs like "convert", "migrate", "update" without a clear target — ask which folder.
- Verbs like "fix", "update" without context — ask which wiki and which operation.
- Ambiguous destinations ("put it in my memory folder") — ask hosted vs. sibling.
- "Do it in place" literally — confirm the user means `--layout-mode in-place` and accepts that the source directory is mutated.
- Wiki living inside a user git repo, with the user silent on whether to add `.llmwiki/` to the user's own ignore — ask.

This is the one methodology rule that applies equally to the skill and to the humans (or LLMs) invoking it: when in doubt, ask.

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
- Routing at query time — the runtime LLM (Claude) *is* the router, walking `index.md` frontmatter and reading `focus` strings semantically. This is cheap: the router reads only frontmatter until the final leaf-body-read step, and the semantic walk terminates at the narrowest relevant leaf. Deterministic mechanical walkers remain useful for test fixtures but are not the primary routing substrate.

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

> **Implementation scope note.** The Phase 1–7 orchestrator ships a **minimal forward-port** of the Fix pipeline: it runs preflight, pre-op snapshot, scan, AUTO/AI-ASSIST application, index rebuild, validation, and commit-finalize against the same stable `<source>.wiki/` sibling (or in-place/hosted target). The richer mode surface and the extra phases described below — `--dry-run`, `--batch`, `--interactive`, `--hard-only`, `--with-soft`, a durable `fix-plan.yaml`, a golden-path regression check, and a per-op `.shape/history/<op-id>/` archive — are **scoped as future work** and are not wired through the CLI today. HUMAN-class divergences currently surface as plain validation errors; a dedicated structured-prompt `INT` code is scoped for the full Fix pipeline.

Fix runs through the common safety envelope with these phases (future-scope items marked *):

1. **ingest-wiki** — read the existing wiki state into memory.
2. **scan-divergences** — run all Validate checks; classify each finding by AUTO / AI-ASSIST / HUMAN.
3. **plan-fixes\*** — *(future work)* produce `.work/fix-plan.yaml` listing every proposed repair, its class, and its target.
4. **apply-auto** — execute all AUTO fixes deterministically.
5. **apply-ai-assist** — emit structured requests that Claude-at-session-time fulfils with the repair content.
6. **prompt-human** — for HUMAN-class items, surface the finding as a plain validation error today (a dedicated structured-prompt `INT` code is future work). The user either resolves the upstream cause and re-invokes Fix, or rolls back to `pre-op/<id>`.
7. **regenerate-indices** — rebuild all affected `index.md` files.
8. **validate-again** — run all hard invariants on the projected fixed tree. If any repair introduced a new violation, halt and roll back to `pre-op/<id>`.
9. **golden-path\*** — *(future work)* compare retrieval on the old and fixed trees using stored fixtures.
10. **commit-finalize** — tag `op/<op-id>`, append to the op-log.

### Modes (future work)

A richer mode surface is scoped for a future release: `--dry-run` (plan only, no mutation), `--batch` (apply AUTO + AI-ASSIST, export HUMAN items for later resolution), `--interactive` (inline HUMAN prompts), `--hard-only`, `--with-soft`. None of these are wired today — a current `fix` invocation simply runs the phases above end-to-end, surfacing HUMAN items as plain validation errors.

### What Fix does not touch

- Any file in the source tree itself (source remains immutable in `sibling` and `hosted` modes).
- Golden-path fixtures themselves (when that phase exists).
- Soft signals (soft signals are addressed by Rebuild, not Fix).

### What Fix creates

- New per-phase commits on the same stable `<source>.wiki/` sibling under a fresh `op/<op-id>` tag.
- Updated `<wiki>/.llmwiki/op-log.yaml` appending the fix op.

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

## 9.9. Scale & Precision: Git-Backed History, Chunked Processing, and the LLM's Use of Git

Section 9.4 made the skill safe at the file level by guaranteeing losslessness under interruption. Section 9.4.2 made the layout stable at the directory level by retiring versioned sibling folders in favour of a single wiki plus a private git. This section makes the skill **scalable** — it explains how the private git is organised, how operator-convergence runs against multi-megabyte corpora without running out of context, how the skill exposes git's own tooling to the runtime LLM, and how the `GIT-01` / `LOSS-01` invariants defined in section 8 are anchored in concrete on-disk artifacts.

### The private git layout

Every wiki owns a private, isolated git repository at `<wiki>/.llmwiki/git/`. The repository is initialised lazily — only top-level operations (Build, Extend, Rebuild, Fix, Join) create it, and only on their first invocation against a given wiki. The hook-mode index rebuild path (`scripts/lib/shape-check.mjs` + `scripts/lib/indices.mjs::rebuildIndex`) never calls into `scripts/lib/git.mjs` at all; initialising a private git from within a filesystem hook would be too expensive for the hot path, so the separation is enforced by module boundaries rather than an explicit runtime assertion. A future refactor that added a git call to shape-check.mjs would need to carry that assertion forward.

The on-disk layout under `<wiki>/.llmwiki/`:

```
<wiki>/.llmwiki/
├── git/                          # the bare private repo
├── provenance.yaml               # byte-range traceability (per-target sources and discarded ranges)
├── op-log.yaml                   # append-only map of {op_id → base_commit, final_commit, tags, operation, summary, layout_mode}
├── similarity-cache/<hash>.json  # pairwise similarity memoisation keyed by sorted content-hash pair
├── embedding-cache/<ns>/<sha>.f32  # per-entry MiniLM embeddings (384 floats = 1.5 KB each)
└── decisions.yaml                # every non-trivial operator application, with tier/confidence/decision
```

A wiki-level `config.yaml` for tunable thresholds, remote defaults, and model-revision pinning is **scoped as future work** — it is referenced in §9.10 as a configuration surface but no reader/writer exists yet. All thresholds live in module constants in `scripts/lib/similarity.mjs` / `scripts/lib/tiered.mjs`; the embedding model id is a constant in `scripts/lib/embeddings.mjs`. A future wiki would either ship with the same constants or extend the skill to read the config file.

And at the wiki root (tracked by the private git, visible to the user):

```
<wiki>/.gitignore                 # auto-generated: .llmwiki/, .work/, .shape/history/*/work/
```

### The isolation env block

Every `git` subprocess the skill spawns runs through the single `scripts/lib/git.mjs::gitRun` helper with this environment (redacted from parent `process.env`):

```js
{
  GIT_DIR:            join(wikiRoot, ".llmwiki/git"),
  GIT_WORK_TREE:      wikiRoot,
  GIT_CONFIG_NOSYSTEM: "1",                                // ignore /etc/gitconfig
  GIT_CONFIG_GLOBAL:  isWindows ? "NUL" : "/dev/null",     // ignore ~/.gitconfig
  HOME:               tmpdir(),                            // belt-and-braces
  GIT_TERMINAL_PROMPT: "0",                                // never prompt for credentials
  GIT_OPTIONAL_LOCKS: "0",                                 // no background index refresh race
  GIT_AUTHOR_NAME:    "skill-llm-wiki",
  GIT_AUTHOR_EMAIL:   "noreply@skill-llm-wiki.invalid",
  GIT_COMMITTER_NAME: "skill-llm-wiki",
  GIT_COMMITTER_EMAIL:"noreply@skill-llm-wiki.invalid",
}
```

Plus the per-invocation flags `-c commit.gpgsign=false -c tag.gpgsign=false -c core.hooksPath=<null-device> -c core.autocrlf=false -c core.fileMode=false -c core.longpaths=true`. The `GIT_*` variable names are dictated by git itself and cannot be renamed. The skill-owned variables use the `LLM_WIKI_*` prefix (see 9.4.2). This is the only place in the codebase that spawns `git`; every other module calls into `git.mjs`. If the env block ever needs to change, it changes in one place and propagates uniformly.

### Operation lifecycle: snapshot → phases → commit-finalize

Every operation runs the same phase sequence against the private git:

1. **preflight** — Node ≥18 and git ≥2.25 are checked, and if the wiki already exists, `git fsck` verifies integrity before anything mutates the tree.
2. **intent-check** — `intent.mjs` resolves the layout mode, target path, and operation-specific flags; any ambiguity short-circuits with an `INT-NN` error (9.4.3).
3. **pre-op snapshot** — `git add -A && git commit -m "pre-op <op-id>"`, tag `pre-op/<op-id>`. This commit captures every byte of every tracked wiki file and is the rollback anchor for the entire operation. It exists even for the very first Build on an empty directory; the commit tree is empty, but the tag is there.
4. **phase commits** — draft-frontmatter / operator-convergence / index-generation produce one commit per phase (and one commit per operator-convergence iteration within that phase). Every phase commit's message follows the pattern `phase <name>: <summary>` so `git log pre-op/<id>..HEAD` reads like an audit trail. See "Per-iteration commits" below for why operator-convergence commits per iteration.
5. **review** (optional, `rebuild --review` only) — `runReviewCycle` gates commit-finalize on explicit user approval. See §9.5 and `guide/operations/rebuild.md`.
6. **validation** — runs section 8 invariants against the last committed tree. Hard-invariant failure: `git reset --hard pre-op/<id>` and `git clean -fd`. The phase commits survive in the reflog for post-mortem inspection but the working tree returns to the pre-op state exactly.
7. **commit-finalize** — tag the final commit `op/<op-id>` (no suffix), append `{op_id, base_commit, final_commit, operation, started, finished, summary, layout_mode}` to `<wiki>/.llmwiki/op-log.yaml`, delete the live `.work/` scratch directory.
8. **gc** — `git gc --auto --quiet` (a no-op unless git's heuristics trip; never aggressive).

**Future work** (currently scoped but not implemented): a deterministic "golden-path" phase that compares routing-fixture load sets against the prior op before allowing commit-finalize; and an archive step that moves `.work/` into `<wiki>/.shape/history/<op-id>/` instead of deleting it, for post-mortem inspection of past operations.

**Tag namespace.** Pre-op snapshot tags use the `pre-op/<id>` path; finalised operation tags use `op/<id>`. The two namespaces are kept disjoint so the `<id>` portion never sits at two different levels of the git ref hierarchy, and so `git show-ref | grep ^op/` and `git show-ref | grep ^pre-op/` each produce clean enumerations. Legacy wikis migrated from the pre-9.4.2 versioned layout receive a single `op/migrated-from-v<N>` tag as their genesis anchor.

**Rollback.** `skill-llm-wiki rollback <wiki> --to <ref>` runs `git rev-parse --verify <ref>` first, then `git reset --hard <ref>` + `git clean -fd`. The `<ref>` accepts `<op-id>` (state after that op finished), `pre-<op-id>` (state before that op started — the skill maps this to the `pre-op/<op-id>` tag internally), `genesis` (the very first tracked state), or a raw git expression like `HEAD~2`. Rollback never touches the private git metadata; it only rewrites the working tree.

### Losslessness: `GIT-01` + `LOSS-01` + provenance.yaml

Git already guarantees losslessness at the file level: every commit is content-addressed, every tag is retained, every rollback is byte-exact because git objects are immutable. `GIT-01` (invariant 21 in section 8) pins that guarantee into the validator: the private repo must pass `git fsck --no-dangling --no-reflogs` under the isolation env, and — when the op-log has at least one entry — the most recent logged operation's `pre-op/<op-id>` tag must exist and be reachable from `HEAD`. Failure means something corrupted the repo — the operation halts, the user investigates.

Git does **not** track "which bytes of source file X produced which bytes of output file Y". For that, `<wiki>/.llmwiki/provenance.yaml` records byte ranges per target, per source (keyed by target path so the Build / Extend phases can append one entry per drafted leaf):

```yaml
version: 1
corpus:
  root: /abs/path/to/source
  root_hash: sha256:<...>
  pre_commit: <sha of pre-op/<first-op-id> in the private git>
  ingested_at: <ISO-8601 timestamp>
targets:
  <target-path>:
    sources:
      - source_path: <original source path>
        source_pre_hash: sha256:<...>
        source_size: 4900
        byte_range: [0, 4821]
        disposition: preserved | split | merged | transformed
    discarded_ranges:
      - source_path: <original source path>
        byte_range: [4821, 4900]
        reason: "trailing whitespace"
```

`LOSS-01` (invariant 22) verifies that for every source referenced in `provenance.yaml`, the sum of `sources[].byte_range` lengths on every target plus `discarded_ranges[].byte_range` lengths equals the source size, with no overlapping ranges on the same source. Source sizes come from the manifest's `sources[].source_size` field (recorded at ingest time) so the check runs off the manifest without re-reading the source tree — the source files may have been edited, moved, or deleted since ingest without invalidating the check. This is the *byte-level* losslessness guarantee that sits on top of git's *commit-level* losslessness. Both invariants are guarded on the presence of their underlying artifacts, so free-mode wikis from before this substrate was introduced remain valid under the updated validator.

### Scale: chunked frontmatter iteration

Storage-side scale is handled by git itself: packs, deltas, and `git fsck` are good on hundreds of thousands of files. The orchestrator's memory/context footprint during operator-convergence and draft-frontmatter is the thing that has to shrink to make multi-megabyte corpora feasible. The `scripts/lib/chunk.mjs` module exposes an async generator:

```js
async function* iterEntries(wikiRoot, { frontmatterOnly }) { ... }
```

yielding `{ path, data, loadBody }` tuples sorted by path. `data` is the parsed frontmatter; `loadBody` is a thunk that reads the body only when called. Operator-convergence operates frontmatter-only by design (section 3.5/3.6), so its peak memory footprint is bounded by *per-entry frontmatter* (typically a few hundred bytes) rather than *whole-entry content*. Draft-frontmatter reads one source body at a time, produces the entry, writes, and releases. The iterator streams bytes buffer-first so large files do not allocate string-sized intermediates.

**Per-iteration commits.** Operator-convergence emits one git commit per iteration of its fixed-point loop — not per individual operator application (that would flood the log), not per whole operation (that would lose granularity). `git log pre-op/<id>..HEAD` shows iteration-by-iteration progress. `git diff <iter-1>..<iter-2>` shows exactly what one pass of operators did. The review flow in 9.5/Phase 7 uses this commit granularity to let the user drop individual iterations via `git revert --no-edit` without losing unrelated work.

### Claude's use of the hidden git

The whole point of hosting a per-wiki git is that the runtime LLM operating the skill can treat it as a full-power history system. The skill exposes git plumbing directly as subcommands (all running through the isolation env):

- `skill-llm-wiki log <wiki> [--op <id>] [git-log-args...]` — `git log` passthrough.
- `skill-llm-wiki show <wiki> <ref> [-- <path>]` — `git show` passthrough for historical file content.
- `skill-llm-wiki diff <wiki> [--op <id>] [git-diff-args...]` — `git diff --find-renames --find-copies` by default; arbitrary `git diff` arguments pass through. Added / removed / renamed / moved / changed file output, byte-identical to native git.
- `skill-llm-wiki blame <wiki> <path>` — `git blame` passthrough for line-level attribution.
- `skill-llm-wiki history <wiki> <entry-id>` — higher-level: walks `git log --follow` + the op-log to trace an entry across renames and surface the operator decisions (from commit messages and `decisions.yaml`) that shaped it.
- `skill-llm-wiki reflog <wiki>` — see even aborted operations. Crucial for debugging a Build that crashed mid-convergence.
- `skill-llm-wiki remote <wiki> <add|list|remove> [...]` and `skill-llm-wiki sync <wiki> [--remote <name>] [--push-branch <branch>] [--skip-fetch] [--skip-push]` — optional mirroring to a bare remote the user manages. Never auto-pushes; `sync` is always explicit. The default push refspec is **tag-only** (`refs/tags/op/*` and `refs/tags/pre-op/*`), so history never leaks more than the op anchors unless the user opts in with `--push-branch <branch>`. All remote URLs are redacted when echoed to stdout or surfaced in errors, via `redactUrl` / `redactArgs` helpers in `git.mjs`.

The guide leaves `hidden-git.md`, `diff.md`, and `remote-sync.md` teach Claude how to invoke these subcommands and how to interpret their output. The rule codified there: when the user asks "what changed", "why was this split", "previous state", "when did this break", Claude should reach for git plumbing first — the history is already in the repo; there is no need to re-derive it from the current tree.

**Internal use by the orchestrator.** Rebuild's plan-review phase runs `git log --oneline op/<last-build>..HEAD -- <path>` to see what prior operators did to a file before proposing a new move. Fix reads `git blame` on a problematic entry to decide whether the fault came from ingest or a later operator. Validate runs `git fsck` as part of `GIT-01`. Join uses `git log` across source wikis to de-duplicate entries by provenance rather than by content similarity alone. The private git is not decorative — phase code reads from it as part of normal operation.

### Determinism and resumability

- **Deterministic commit SHAs.** Setting `LLM_WIKI_FIXED_TIMESTAMP=<epoch>` pins commit and tag timestamps (via `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` in `gitCommit`) so a same-input build produces byte-identical commit SHAs across runs and across machines. Without the env var, commits inherit the ambient wall clock and SHAs drift between runs; determinism still holds for the *tree* objects (content-addressed) even though the commit objects differ. Reproducible-build workflows should pin the env var explicitly.
- **AI call cache** (see 9.4) remains the source of determinism for phases that invoke the runtime LLM. Re-runs replay cached responses for zero tokens.
- **Phase-commit audit trail.** The skill does **not** persist a `.work/progress.yaml` resume manifest — the phase commits in the private git are the durable checkpoint. An interrupted operation is recovered by rolling back to `pre-op/<op-id>` and re-running. A true in-place resume is scoped as future work.
- **SIGKILL handling.** If a kill hits between phase file writes and the phase's closing commit, re-running the operation starts from scratch (the `pre-op/<op-id>` tag is still intact); the user's first step is `skill-llm-wiki rollback <wiki> --to pre-<op-id>` to drop any uncommitted tree state. If the kill hits *during* a commit, `git fsck` detects the partial state on the next run and `GIT-01` fires; the operator either rolls back or runs `git reset --hard HEAD` manually to drop it.

### Design principle

Everywhere the skill could invent its own audit log, diff format, integrity check, or content-addressed store, it leans on git instead. Git is the content-addressable store, the history database, the diff engine, the rename detector, and the integrity checker. The skill's code handles the parts git genuinely cannot do — byte-range provenance, semantic similarity, structural invariants — and defers everything else. This is the scale-and-precision trade: storage and history are outsourced to git; the skill's own code budget goes into decisions git cannot make.

---

## 9.10. Tiered AI Strategy

Sections 9.4 through 9.9 describe how the skill makes operations safe, structured, and scalable. This section describes how it decides *when to use the runtime LLM at all*. The goal is simple: make the skill usable against multi-megabyte corpora without a token bill that scales with corpus size, and without losing the LLM's judgment where judgment is actually needed.

### The three tiers

- **Tier 0 — lexical, zero cost.** TF-IDF vectors over title + H1 + `covers[]` + tags + filename, with cosine similarity for pair comparisons. Implemented in `scripts/lib/similarity.mjs` in ~120 lines with no external dependency, using scikit-learn's classic IDF formula (`log((1+N)/(1+df)) + 1`) for stability across corpus sizes. Deterministic, instant, perfect for keyword-overlap decisions. Accuracy is high on *same-vocabulary* similarity (two entries that both talk about "Prisma migrations") and low on *paraphrase* similarity (one says "database schema evolution", the other says "Prisma migrations"). Tier 0 is the decisive top and bottom of the confidence distribution and nothing else.
- **Tier 1 — local semantic embeddings, zero-API cost, ~23 MB one-time model download.** `@xenova/transformers` running `Xenova/all-MiniLM-L6-v2` (384-dimension MiniLM) locally via ONNX runtime. ~50 ms per text on CPU; embeddings are cached by content hash at `<wiki>/.llmwiki/embedding-cache/<ns>/<sha>.f32` (4-byte floats × 384 = 1.5 KB per entry), namespaced by the cache tier so mock and real embeddings never mix. Captures paraphrase similarity. The model id is pinned as a module constant (`MODEL_ID` in `scripts/lib/embeddings.mjs`); a per-wiki `config.yaml` override with pinned revision is scoped as future work — until then, a library upgrade that changes the model behaviour would require a manual cache rebuild. **Tier 1 is an *optional* dependency.** If `@xenova/transformers` is not installed, Tier 1 is skipped and decisions fall through from Tier 0 directly to Tier 2. In an interactive TTY session, first-time fall-through prompts the user "install Tier 1 now? (y/n)". In CI, hook mode, or with `LLM_WIKI_NO_PROMPT=1`, the fall-through is silent.
- **Tier 2 — Claude (the runtime LLM operating the skill).** Used only for decisions where Tier 0 and Tier 1 are both in the mid-band, or for decisions that fundamentally require natural-language judgment (HUMAN-class Fix items, structural decisions where similarity alone is insufficient, prose-heavy `draft-frontmatter` where heuristic extraction and embedding similarity cannot produce a good `focus` string). Token cost is proportional to *ambiguity*, not to corpus size.

### Confidence bands and escalation

```text
Tier 0 (TF-IDF cosine):
  if similarity >= 0.85  → decisive SAME          (no escalation)
  if similarity <= 0.30  → decisive DIFFERENT     (no escalation)
  otherwise              → escalate to Tier 1

Tier 1 (embedding cosine):
  if similarity >= 0.80  → SAME                   (no escalation)
  if similarity <= 0.45  → DIFFERENT              (no escalation)
  otherwise              → escalate to Tier 2

Tier 2 (Claude):
  issue a narrowly-scoped prompt with only the two frontmatters + titles
  (bodies go to Claude only when explicitly required by the phase)
  cache the response at .work/ai-cache/<hash>.json keyed by request content
```

Thresholds live as module constants in `scripts/lib/similarity.mjs` and `scripts/lib/tiered.mjs`. Per-wiki overrides via `<wiki>/.llmwiki/config.yaml` (under `similarity_tiers:`) are scoped as future work. The defaults above are the starting point; the fixture-corpus suite in `tests/unit/similarity.test.mjs` verifies that the defaults produce sane classifications on a representative corpus.

### Per-phase tier assignment

Every phase is explicitly classified. This table is the normative source for implementation and the body of the `guide/tiered-ai.md` leaf.

| Phase                                 | Primary tier            | Escalation path | Why |
|---------------------------------------|-------------------------|-----------------|-----|
| `ingest`                              | None (pure FS)          | —               | Walk, hash, size. No judgment. |
| `classify`                            | Tier 0 → 1 → 2          | Full ladder     | Grouping by similarity is the tier's sweet spot. Claude only for ambiguous edges. |
| `draft-frontmatter`                   | Heuristic → Tier 2      | Skip Tier 1     | Generation, not similarity. Heuristics for structured sources; Claude for prose. |
| `layout`                              | None (mechanical)       | —               | Deterministic placement. |
| `operator-convergence` (all 5)        | Tier 0 → 1 → 2          | Full ladder     | All operators detect via frontmatter similarity. Claude only for mid-band pairs. |
| `index-generation`                    | None (templated)        | —               | Frontmatter aggregation. |
| `validation`                          | None (rule-based)       | —               | Deterministic invariants. |
| `golden-path`                         | None (deterministic)    | —               | Router walks indices; no similarity. |
| `commit`                              | None (FS ops)           | —               | Atomic moves. |
| Rebuild `plan-review`                 | Tier 0 → 1 → 2          | Full ladder     | Comparing trees, proposing moves. Same tiering as operator-convergence. |
| Fix — AUTO class                      | None (script)           | —               | Deterministic repairs. |
| Fix — AI-ASSIST class                 | Tier 2                  | —               | Content generation. Claude only. |
| Fix — HUMAN class                     | User prompt             | —               | Always asks the user. |
| Join — id collision resolution        | Tier 0 → 1 → 2          | Full ladder     | Same-id entries across sources — similarity ladder is perfect. |
| Join — category merging               | Tier 0 → 1 → 2          | Full ladder     | Same. |

For a typical corpus, >90% of operator applications resolve at Tier 0 or Tier 1. Claude recovers the last 10% where judgment genuinely matters.

### Quality modes

The skill ships three modes, selected via `--quality-mode` (flag) or `LLM_WIKI_QUALITY_MODE` (env var, resolved through `tiered.mjs::resolveQualityMode`; the flag wins when both are set):

- **`tiered-fast` (default, recommended).** Full Tier 0 → 1 → 2 ladder. Tier 1 is now a REQUIRED dependency (`@xenova/transformers` in `dependencies`, not optional) — the overhaul discovered Tier 0 alone was too weak on terse technical frontmatter to leave every mid-band pair for Tier 2 to resolve. Tier 2 runs in a dedicated sub-agent per decision via the **exit-7 handshake**: the CLI writes a pending batch to `<wiki>/.work/tier2/` and exits 7; the wiki-runner spawns sub-agents, writes responses, and re-invokes the CLI. Zero Claude tokens for >90% of operator decisions on typical corpora once embeddings are warm.
- **`claude-first`.** Tier 0 is still consulted for decisive cases (saves tokens on the obvious decisions), but anything in the Tier 0 mid-band goes straight to Tier 2 (exit-7 handshake), skipping Tier 1. Useful when the user values sub-agent judgment over speed/cost or when debugging a specific similarity call.
- **`deterministic`.** Tier 0 → Tier 1 ladder only; mid-band Tier 1 pairs are resolved by a static threshold (`TIER1_DETERMINISTIC_THRESHOLD`, the midpoint of Tier 1's decisive bounds) so the ladder terminates without Tier 2. No LLM/sub-agent is ever consulted; cluster naming is produced by `generateDeterministicSlug` + `deterministicPurpose` from member frontmatters. Repeated runs on the same inputs are byte-reproducible. Useful for hermetic CI and large corpus builds where deterministic output matters more than Tier 2's naming nuance. For air-gapped environments, pre-warm the Tier 1 MiniLM model cache (`~/.cache/huggingface`) on a networked machine before the air-gapped run — Tier 1 itself performs a one-time model download on first use through `@xenova/transformers`.

### Similarity cache and decision log

- **Similarity cache** at `<wiki>/.llmwiki/similarity-cache/` holds pairwise results keyed by the sorted pair of content hashes: `{hash(a) ⊕ hash(b) → {tier_used, similarity, decision, computed_at}}`. The cache is consulted before any tier computation. Iterative operator-convergence re-checks the same pair across iterations; the cache makes those checks free after the first.
- **Decision log** at `<wiki>/.llmwiki/decisions.yaml` records every non-trivial operator application: `{op_id, operator, sources, tier_used, similarity, confidence_band, decision, reason}`. Hand-rolled deterministic YAML so the log is stable across reruns. Claude at session-time reads the decision log when a user asks "why was this merged?" and answers from the log rather than re-running the similarity computation. This is the concrete mechanism by which Claude leverages the hidden git + skill metadata together.

### Claude-at-session-time vs. Claude-in-Tier-2

These are different things. **Claude-at-session-time** is the runtime LLM the user is chatting with; it loaded the skill's guide at routing time and is orchestrating the skill, asking clarifying questions, planning Rebuilds, and interpreting diff output. **Claude-in-Tier-2** is when a phase explicitly calls out to a Claude API (or, inside a Claude Code session, emits a structured request the session-level Claude fulfils). Using `tiered-fast` as the default does **not** mean Claude is absent from the workflow — it means Claude is used for user interaction, plan review, and the hard 10% of similarity decisions, not for every pairwise frontmatter comparison in a 10k-entry corpus.

### Claude-in-Tier-2 execution model: dedicated sub-agents at every layer

Neither Claude-at-session-time nor Claude-in-Tier-2 runs wiki operations inline in the user's main chat. The skill's execution model is a strict three-level hierarchy:

1. **Main session (Claude-at-session-time).** Handles user intent resolution (9.4.3), preflight, and the disambiguation of `INT-NN` errors. When the user asks for a wiki operation, the main session **spawns a dedicated wiki-runner sub-agent** to run the CLI. The main session never holds wiki content in its own context window. Ongoing chat with the user remains cheap and lean. This is a hard contract codified in `SKILL.md` under "Agent delegation contract".

2. **Wiki-runner sub-agent.** Owns its own context window for the duration of one operation. Executes the CLI subcommand, streams progress back to the main session in terse summaries, and is responsible for its own context-window hygiene. When remaining budget approaches a safety threshold, the wiki-runner **auto-compacts** between phase boundaries: the most recent phase commit in the private git is the durable checkpoint, so prior-phase conversation history can be summarised and dropped without loss. Auto-compaction is idempotent, runs only at phase boundaries, and verifies state against `skill-llm-wiki log --op <id>` before proceeding. If auto-compaction still cannot fit the remaining work, the wiki-runner either (a) rolls back to `pre-op/<id>` and relaunches itself with a clean context picking up from the last good commit, (b) narrows the Tier 2 fan-out at the cost of a noted quality reduction, or (c) stops and reports to the main session. See `guide/scale.md` "Context-window management in the wiki-runner" for the operational protocol.

3. **Tier 2 per-decision sub-agents.** Every Tier 2 Claude call — whether it's a draft-frontmatter pass for a prose-heavy entry, a mid-band MERGE decision during operator-convergence, a rebuild plan review, a HUMAN-class Fix proposal, or a Join id-collision resolution — spawns its own narrowly-scoped sub-agent. Each such sub-agent receives only the inputs its question needs (two frontmatter blobs, one source file, one plan excerpt) and returns a strict JSON shape the wiki-runner can parse without further chat. The wiki-runner keeps only the final decision; the sub-agent's prompt and response bodies are dropped when the sub-agent returns. Non-conflicting Tier 2 decisions can fan out in parallel. A cache hit at `<wiki>/.llmwiki/similarity-cache/` short-circuits the fan-out entirely — only cache misses reach a Tier 2 sub-agent at all.

This hierarchy means the token and context budgets scale with **ambiguity**, not with **corpus size**. A 10k-entry wiki with 500 mid-band pairs produces 500 Tier 2 sub-agents, but (a) the main session absorbs zero of them, (b) the wiki-runner absorbs 500 one-line decisions plus whatever its phase commits carry, (c) each Tier 2 sub-agent is a short-lived tight-scope request that returns immediately.

**Default model and effort per task** (unless the user overrides):

| Layer | Model class | Effort | Rationale |
|---|---|---|---|
| Wiki-runner sub-agent | Generalist with tool-use; 1M-context variant preferred for very large corpora | medium | Orchestrates CLI, auto-compacts, holds whole-operation state. |
| Tier 2 draft-frontmatter (per entry) | Cheapest capable short-form writing model | minimal | Bounded output, one source file per call. Parallel-safe. |
| Tier 2 operator-convergence (per pair) | Cost-effective model with strong short-form judgment | minimal | Bounded output, frontmatter only. Parallel-safe. |
| Tier 2 rebuild plan review | Strong reasoning model | medium | Needs structural judgment across the full plan. |
| Tier 2 HUMAN-class Fix | Strong reasoning model | medium | Must justify its proposal to the user. |
| Tier 2 Join id-collision | Strong reasoning model | minimal | Semantic-identity judgment on small input. |

**User overrides propagate to every sub-agent the operation spawns.** If the user says "use sonnet for this build" or "minimal effort everywhere", that instruction flows from the main session into the wiki-runner's prompt, and from the wiki-runner into each Tier 2 sub-agent's prompt, unchanged. A sub-agent never silently upgrades to a stronger model, and never silently downgrades. Conflicting overrides (a model that cannot support the requested effort level) are surfaced to the user in the main session for resolution before the operation starts.

**Why this hierarchy and not a single flat context.** A naive implementation would run the whole build in the main session, with Tier 2 calls happening inline via the chat's own model. That approach collapses under three stresses at once for large corpora: (1) the user's conversation context gets consumed by content they never asked to see, leaving no room for chat; (2) the main session's model may not be the best tool for every Tier 2 decision, but there's no way to swap models per-call; (3) context-window limits on the main session become a hard ceiling on corpus size. The three-level hierarchy eliminates all three: main-session context stays lean, each Tier 2 task picks its own model, and the wiki-runner's auto-compaction absorbs any corpus size up to the storage-level bounds of chunked iteration (§9.9).

### Design principle

**Claude is used for deep-understanding decisions — structural judgments on semantically ambiguous entries, HUMAN-class Fix decisions, prose-heavy `draft-frontmatter`, user-intent resolution, and session-time reasoning about history. Claude is never used for routing, and never for lightweight pairwise similarity when a local tier is decisive.** This principle keeps token cost proportional to *ambiguity* rather than *volume* and preserves determinism everywhere a local tier answers the question.

---

## 10. Token-Efficiency Argument & Objective Function

This section formalises why the pattern saves tokens and how to measure the savings.

### Scenario analysis

- **Worst case** (all signals match everything): the router loads approximately the same content as a flat all-at-once load, with index overhead (a few KB) added. This is the pathological case where the wiki does not help.
- **Typical case**: index overhead is 2–5% of total corpus; matched load is 10–40% of total corpus; savings 60–88%.
- **Best case** (narrow query into a deeply nested tree): matched load is under 5% of total corpus; savings above 95%.

The deeper and better-shaped the tree, the closer to the best case. The rewrite operators exist to keep real wikis near the best case rather than at the typical case.

### Why the shape rules save tokens

- **DECOMPOSE reduces over-loading.** Before decomposition, a single oversized entry covering N concerns is loaded whenever any one concern is relevant. After, only the peer entry whose `focus` matches the task is loaded. An entry covering three concerns where most queries need one saves roughly two-thirds of its per-query load.
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
- A NEST reduces fitness when the nested leaves have distinct `focus` strings so the router can stop at the parent for miss-cases (fewer queries load the whole subtree).
- A MERGE reduces fitness when the merged entry is not loaded more often than either original would have been.
- A DECOMPOSE reduces fitness when the resulting peer entries have genuinely disjoint `focus` strings.

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

Overlay entries (`type: overlay`) attach to one or more primary entries via `overlay_targets`. When the overlay is judged relevant (its own `focus` + optional `activation` hints match the task) and the primary is loaded, the overlay's body is appended to the primary's assembled context. Overlays are scope modifiers — they add situationally-relevant content without creating new primary homes for the material.

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
- **Semantic routing on `focus`** drives lazy-load retrieval. Parent indices carry only `id`/`file`/`type`/`focus`/`tags` per entry; Claude reads each `focus` string and descends only into relevant branches. Per-leaf `activation` hints (file globs, import patterns, keyword matches, structural signals, escalation) stay on the leaves as optional disambiguation data and are never aggregated into parents. Leaf bodies are loaded only at the end of the walk.
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
