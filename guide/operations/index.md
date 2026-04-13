---
id: operations
type: index
depth_role: subcategory
depth: 1
focus: per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join
parents:
  - ../index.md
activation_defaults:
  tag_matches:
    - operation
shared_covers:
  - every operation follows a named phase pipeline tracked in .work/progress.yaml
  - every operation starts with a preflight and ends with an atomic commit
  - every operation honours the safety envelope from guide/safety.md
orientation: |
  One leaf per top-level operation. Exactly one activates per user ask,
  selected by its keyword_matches on the profile's operation keyword.
  Activation here requires the profile to carry the "operation" tag — the
  whole subcategory is short-circuited for informational queries so they
  never descend into operation leaves.
entries:
  - id: build
    file: build.md
    type: primary
    focus: Build operation — create a new wiki from source(s) via the full phase pipeline
    activation:
      keyword_matches:
        - build
        - create wiki
        - new wiki
        - from source
        - build wiki
      tag_matches:
        - operation
        - building
    tags:
      - operations
      - build
  - id: extend
    file: extend.md
    type: primary
    focus: Extend operation — add new sources to an existing wiki without reprocessing existing entries
    activation:
      keyword_matches:
        - extend
        - add source
        - add to wiki
        - new source
        - append
      tag_matches:
        - operation
        - building
    tags:
      - operations
      - extend
  - id: fix
    file: fix.md
    type: primary
    focus: Fix operation — repair methodology divergences in an existing wiki
    activation:
      keyword_matches:
        - fix
        - repair
        - divergence
        - reconcile
      tag_matches:
        - operation
        - fixing
        - mutation
    tags:
      - operations
      - fix
      - repair
  - id: join
    file: join.md
    type: primary
    focus: Join operation — merge N ≥ 2 existing wikis into a single unified wiki
    activation:
      keyword_matches:
        - join
        - merge wikis
        - combine wikis
        - unify
      tag_matches:
        - operation
        - building
        - mutation
    tags:
      - operations
      - join
      - merge
  - id: rebuild
    file: rebuild.md
    type: primary
    focus: Rebuild operation — optimise structure via rewrite operators, produce a rewrite plan then apply
    activation:
      keyword_matches:
        - rebuild
        - optimize
        - optimise
        - restructure
        - rewrite plan
      tag_matches:
        - operation
        - structural-change
        - mutation
    tags:
      - operations
      - rebuild
      - operators
  - id: validate
    file: validate.md
    type: primary
    focus: Validate operation — read-only correctness check against a wiki
    activation:
      keyword_matches:
        - validate
        - check wiki
        - verify wiki
        - correctness
      tag_matches:
        - operation
        - validating
    tags:
      - operations
      - validate
      - read-only
children: []
---
<!-- BEGIN AUTO-GENERATED NAVIGATION -->

# Operations

**Focus:** per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join

**Shared across all children:**

- every operation follows a named phase pipeline tracked in .work/progress.yaml
- every operation starts with a preflight and ends with an atomic commit
- every operation honours the safety envelope from guide/safety.md

## Children

| File | Type | Focus |
|------|------|-------|
| [build.md](build.md) | 📄 primary | Build operation — create a new wiki from source(s) via the full phase pipeline |
| [extend.md](extend.md) | 📄 primary | Extend operation — add new sources to an existing wiki without reprocessing existing entries |
| [fix.md](fix.md) | 📄 primary | Fix operation — repair methodology divergences in an existing wiki |
| [join.md](join.md) | 📄 primary | Join operation — merge N ≥ 2 existing wikis into a single unified wiki |
| [rebuild.md](rebuild.md) | 📄 primary | Rebuild operation — optimise structure via rewrite operators, produce a rewrite plan then apply |
| [validate.md](validate.md) | 📄 primary | Validate operation — read-only correctness check against a wiki |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
One leaf per top-level operation. Claude loads exactly one of these per
invocation, named by SKILL.md's routing table. Each leaf documents the
operation's phases, adaptations for hosted mode where applicable, and
any mode-specific notes. Leaves here never chain into each other.
<!-- END AUTHORED ORIENTATION -->
