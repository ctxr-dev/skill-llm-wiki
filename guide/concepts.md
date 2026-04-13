# Concepts and static structure

## Vocabulary

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
