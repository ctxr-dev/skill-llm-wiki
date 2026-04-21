---
id: operators
type: primary
depth_role: leaf
focus: the four rewrite operators that shape wiki trees toward a token-minimal normal form
parents:
  - index.md
covers:
  - "DECOMPOSE: horizontal split when one entry covers disjoint concerns"
  - "NEST: vertical specialisation when an entry's sections are narrower derivations of its focus"
  - "MERGE: two siblings with compatible covers and activation collapse into one"
  - "LIFT: single-child folder collapses up one level"
  - "DESCEND: gravity toward leaves, push leaf-shaped content out of parent indices"
  - "detection criteria, application procedures, and priority order (DESCEND > LIFT > MERGE > NEST > DECOMPOSE)"
  - "contract-gating: hosted-mode operator applications are rejected when they would violate the layout contract"
tags:
  - operators
  - rebuild
  - normal-form
activation:
  keyword_matches:
    - operator
    - rewrite
    - decompose
    - nest
    - merge
    - lift
    - descend
    - restructure
  tag_matches:
    - structural-change
  escalation_from:
    - build
    - rebuild
source:
  origin: file
  path: operators.md
  hash: "sha256:ef8ac35df32870960806bc1f401168e5993ec3759497bffa3e81dec0552a6ead"
---

# Rewrite operators

Reshape trees toward a token-minimal normal form. Applied in fixed priority order: **DESCEND > LIFT > MERGE > NEST > DECOMPOSE**.

## DECOMPOSE (horizontal split)

**Rule:** If a single entry covers N ≥ 2 disjoint concerns, split it into N peer entries under a common parent. The parent holds what they share; each peer holds its specifics.

**Detection:** `covers[]` clusters into ≥2 disjoint groups by tag/keyword similarity; OR `activation.file_globs` contain patterns with no common prefix/suffix; OR body has ≥2 H2 sections each meaningful standalone; OR `covers[]` exceeds 12 items.

**Application:** partition covers into clusters; create sibling entries with narrower focus; hoist shared items to the parent index's `shared_covers[]`; add `aliases[]` entry pointing to the original id so existing references don't break; delete the original file.

## NEST (vertical specialisation + cluster-based grouping)

**Rule:** If an entry's internal structure reveals narrower specialisations of its focus, OR if multiple sibling leaves form a coherent cluster that deserves a subcategory, extract them into leaf files under a new child folder; the original entries become children of a new parent index.

NEST fires in two modes:

- **Nests-into hint (legacy).** A leaf's frontmatter carries an explicit `nests_into[]` list. Detection is syntactic; application splits the leaf into the hinted children.
- **Cluster-based (corpus-adaptive).** The cluster detector (`scripts/lib/cluster-detect.mjs`) computes an affinity matrix across the siblings of each parent directory using four signals — Tier 0 TF-IDF cosine, Tier 1 embedding cosine on focus/covers/body sample, tag-Jaccard, and activation-keyword-Jaccard. The matrix is fused with default weights (`0.25 / 0.40 / 0.20 / 0.15`) and clustered into connected components under candidate thresholds `[0.30, 0.38, 0.46]`. The threshold whose partition produces the best shape score wins. The detector is corpus-agnostic — it has NO knowledge of the specific wiki being optimised.

**Cluster-based application.** Each accepted cluster is named via a Tier 2 `cluster_name` request (slug + purpose) — or receives a slug directly from a `propose_structure` Tier 2 response. Names are NEVER shortcut from shared tags; if the sub-agent cannot name a cluster, that cluster does not nest. The NEST applier (`scripts/lib/nest-applier.mjs`) then:

1. **Atomic slug resolution.** Before touching the filesystem, `resolveNestSlug(slug, proposal, wikiRoot, opts)` checks whether the proposed slug collides with (a) any member leaf's id, (b) any non-member sibling leaf's id in the same parent, (c) an existing sibling subdirectory name, or (d) any live leaf id or subdirectory basename elsewhere in the tree (full-tree walk, activated whenever `wikiRoot` is provided). On collision the slug is auto-suffixed deterministically (`<slug>-group`, then `<slug>-group-2`, `-group-3`, …) until it's non-colliding. The rename is audited in `decisions.yaml` as `decision: slug-renamed`. This pre-empts the DUP-ID class of validation failure that would otherwise rollback the entire NEST after apply — including cross-depth collisions (e.g. a cluster slug `event-patterns` proposed under `design-patterns-group/` that would collide with an existing `arch/event-patterns/` in a different branch of the tree). The optional `opts.wikiIndex` argument accepts a precomputed `Set` from `buildWikiForbiddenIndex(wikiRoot)` — the convergence loop builds it once per iteration and mutates it with `wikiIndex.add(resolvedSlug)` after each successful apply, dropping per-proposal cost from O(full-tree) to O(parent-dir). `wikiRoot` is itself optional: legacy callers that omit it get the parent-dir-only walk preserved from v1.0.0 (modulo the dot-skip rule described in the module source).
2. Creates `<parent>/<slug>/` (using the resolved slug).
3. Moves each cluster member into the new directory and rewrites its `parents[]` to `["index.md"]`.
4. Writes a minimal `index.md` stub carrying `id` (= resolved slug), `type: index`, `depth_role: subcategory`, a `focus:` line from the cluster purpose, and — when the members share them — `shared_covers[]` (intersection of member covers) and `tags[]` (intersection of member tags). The stub does NOT carry aggregated `activation_defaults`: routing is semantic, and descent decisions are made against the stub's `focus` + `shared_covers`, not against a literal keyword union.
5. Rebuilds all indices so the parent directory's `entries[]` now lists the new subcategory instead of the moved leaves.

**Quality-metric gating.** Every cluster NEST application is scored against the `routing_cost` metric before and after. Metric = sum over a fixed query distribution (`scripts/lib/query-fixture.mjs`) of bytes read during simulated routing, normalised by total leaf bytes. If the post-apply metric is worse than the pre-apply metric, the application is rolled back and the next-best proposal is tried. This is the "let data pick the cluster" discipline — we never apply a cluster just because the affinity matrix liked it, only when the resulting tree routes queries more cheaply. The metric trajectory is logged to `decisions.yaml`.

**Recursive-nest safety.** Directories freshly created by a NEST in the current convergence run are excluded from subsequent cluster detection in the same run. This prevents noise-driven infinite sub-clustering.

**Legacy nests-into path.** The nests-into-hint proposals still emit as detect-only suggestions in the convergence audit trail; they are not auto-applied because the per-leaf hint mechanism predates the cluster detector and is kept for hand-authored hints.

## MERGE / LIFT (redundancy collapse)

**MERGE — two siblings collapse into one.** Detection: `focus` similarity above threshold, `covers[]` overlap > 70%, compatible activation, compatible `parents[]`. Application: union the covers, pick the more general focus, take the union of activation and parents, write the merged entry with both original ids in `aliases[]`, delete the sources, rewire references via alias resolution.

**LIFT — single-child folder collapses up.** Detection: a non-root folder contains exactly one non-index entry. Application: move the child up one level, update its `parents[]` to point at the grandparent, delete the now-empty folder and its `index.md`, preserve the folder's id on the lifted child as an alias.

## DESCEND (gravity toward leaves)

**Rule:** Substantive domain knowledge must live at leaves. Parent indices contain only navigation and shared context. Push leaf-shaped content from parent bodies down into child leaves.

**Detection:** parent index body (authored zone) exceeds 2 KB budget; OR contains leaf-content signatures (checklist items, code fences, multi-paragraph exposition, data tables).

**Application:** create a new leaf (or append to an existing relevant one) to host the extracted content; move the content; leave a short link reference in the parent's orientation if navigation benefits.

## Priority rationale

Information-preserving reductions happen first (DESCEND moves content deeper without losing it; LIFT removes empty structure). Collapses happen next (MERGE reduces byte count). Expansions happen last (NEST and DECOMPOSE add structural surface area). This order prevents operators from creating structure that would immediately be collapsed.

## Contract-gating in hosted mode

Every operator application is checked against the layout contract **before** being accepted. Rejected moves include: NEST that would exceed a directory's `max_depth`; LIFT that would remove a contract-required directory; MERGE across dynamic subdirs where the contract treats them as separate (e.g. two different days in a `daily/` tree); DECOMPOSE that would place peers into a non-existing contract directory. Rejected moves are suppressed; remaining operators still run until convergence.
