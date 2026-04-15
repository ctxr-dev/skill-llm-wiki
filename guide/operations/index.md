---
id: operations
type: index
depth_role: subcategory
depth: 1
focus: per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join
parents:
  - "../index.md"
shared_covers:
  - every operation runs a named phase pipeline with one git commit per phase in the private repo
  - "every operation starts with a preflight and ends with an atomic commit-finalize that tags op/<id>"
  - "every operation honours the safety envelope from guide/safety.md"
activation_defaults:
  tag_matches:
    - operation
orientation: |
  One leaf per top-level operation. Exactly one activates per user ask,
  selected by its keyword_matches on the profile's operation keyword.
  Activation here requires the profile to carry the "operation" tag — the
  whole subcategory is short-circuited for informational queries so they
  never descend into operation leaves.

generator: "skill-llm-wiki/v1"
entries:
  - id: validate
    file: validate.md
    type: primary
    focus: Validate operation — read-only correctness check against a wiki
    tags:
      - operations
      - validate
      - read-only
  - id: ingest
    file: "ingest/index.md"
    type: index
    focus: "Operations that bring external source material into a wiki (create, extend, merge)."
    tags:
      - operations
  - id: maintain
    file: "maintain/index.md"
    type: index
    focus: Mutating maintenance operations on an existing wiki — repair divergences and optimise structure.
    tags:
      - operations
children:
  - "ingest/index.md"
  - "maintain/index.md"
---
<!-- BEGIN AUTO-GENERATED NAVIGATION -->

# Operations

**Focus:** per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join

**Shared across all children:**

- every operation runs a named phase pipeline with one git commit per phase in the private repo
- every operation starts with a preflight and ends with an atomic commit-finalize that tags op/<id>
- every operation honours the safety envelope from guide/safety.md

## Children

| File | Type | Focus |
|------|------|-------|
| [validate.md](validate.md) | 📄 primary | Validate operation — read-only correctness check against a wiki |
| [ingest/index.md](ingest/index.md) | 📁 index | Operations that bring external source material into a wiki (create, extend, merge). |
| [maintain/index.md](maintain/index.md) | 📁 index | Mutating maintenance operations on an existing wiki — repair divergences and optimise structure. |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
One leaf per top-level operation. Claude loads exactly one of these per
invocation, named by SKILL.md's routing table. Each leaf documents the
operation's phases, adaptations for hosted mode where applicable, and
any mode-specific notes. Leaves here never chain into each other.
<!-- END AUTHORED ORIENTATION -->
