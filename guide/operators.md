---
id: operators
type: primary
depth_role: leaf
focus: "the four rewrite operators that shape wiki trees toward a token-minimal normal form"
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
---

# Rewrite operators

Reshape trees toward a token-minimal normal form. Applied in fixed priority order: **DESCEND > LIFT > MERGE > NEST > DECOMPOSE**.

## DECOMPOSE (horizontal split)

**Rule:** If a single entry covers N ≥ 2 disjoint concerns, split it into N peer entries under a common parent. The parent holds what they share; each peer holds its specifics.

**Detection:** `covers[]` clusters into ≥2 disjoint groups by tag/keyword similarity; OR `activation.file_globs` contain patterns with no common prefix/suffix; OR body has ≥2 H2 sections each meaningful standalone; OR `covers[]` exceeds 12 items.

**Application:** partition covers into clusters; create sibling entries with narrower focus; hoist shared items to the parent index's `shared_covers[]`; add `aliases[]` entry pointing to the original id so existing references don't break; delete the original file.

## NEST (vertical specialisation)

**Rule:** If an entry's internal structure reveals narrower specialisations of its focus, extract them into leaf files under a new child folder; the entry becomes a parent index.

**Detection:** body has ≥3 H2 sections each a strict narrowing of the focus; OR `nests_into[]` is set; OR size exceeds leaf cap while sections are sequentially derived.

**Application:** create `<entry-id>/` folder; move each narrowing section to `<entry-id>/<specialisation-id>.md`; replace the original with `<entry-id>/index.md` carrying `type: index` and `shared_covers[]` computed from the new leaves; narrowing chain becomes strictly monotonic through the new index.

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
