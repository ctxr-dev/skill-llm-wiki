---
id: guide
type: index
depth_role: category
depth: 0
focus: skill-llm-wiki operational reference routed by activation signals
parents: []
shared_covers:
  - every operation must run the Node.js preflight before invoking scripts/cli.mjs
  - every operation is explicit-invocation only and has no automatic triggers
  - every mutating operation stages in .work/ and commits atomically
  - free mode keeps the source immutable; hosted mode obeys the layout contract
orientation: |
  This is a real LLM wiki. Claude routes into it via activation signals, not
  via a hand-maintained table. Build a context profile from the user's ask
  (operation keyword, mode, tags) and check each entry below: any entry
  whose activation.keyword_matches, activation.tag_matches, or
  activation.escalation_from matches the profile is in the load set.
  Iterate until escalation stabilises, then read the activated leaves.
  Informational queries with no operation keyword activate nothing and are
  answered from SKILL.md alone.
generator: skill-llm-wiki/v1
mode: hosted
layout_contract_path: .llmwiki.layout.yaml
rebuild_needed: false
rebuild_reasons: []
rebuild_command: skill-llm-wiki rebuild /Users/developer/work/projects/ctxr-dev-skills/skill-llm-wiki/guide --plan
entries:
  - id: cli
    file: cli.md
    type: primary
    focus: complete CLI subcommand reference for scripts/cli.mjs
    activation:
      keyword_matches:
        - cli
        - command
        - subcommand
        - ingest
        - shape-check
        - index-rebuild
        - draft-leaf
        - resolve-wiki
      tag_matches:
        - any-op
      escalation_from:
        - build
        - extend
        - validate
        - rebuild
        - fix
        - join
    tags:
      - cli
      - commands
      - reference
  - id: concepts
    file: concepts.md
    type: primary
    focus: core vocabulary and static structure rules for LLM wikis
    activation:
      keyword_matches:
        - concepts
        - vocabulary
        - structure
        - narrowing chain
        - static structure
      tag_matches:
        - building
        - modifying-structure
      escalation_from:
        - build
        - extend
        - rebuild
        - fix
        - join
    tags:
      - concepts
      - vocabulary
      - structure
  - id: invariants
    file: invariants.md
    type: primary
    focus: hard validation invariants and soft shape signals for LLM wikis
    activation:
      keyword_matches:
        - invariant
        - validate
        - validation
        - errors
        - check
        - verify
      tag_matches:
        - validating
        - fixing
      escalation_from:
        - build
        - extend
        - validate
        - rebuild
        - fix
        - join
    tags:
      - validation
      - invariants
      - shape-check
  - id: layout-contract
    file: layout-contract.md
    type: primary
    focus: hosted-mode layout contract schema, validation, and conflict-resolution rules
    activation:
      keyword_matches:
        - hosted
        - contract
        - layout.yaml
        - llmwiki.layout
        - in-place
      tag_matches:
        - hosted-mode
    tags:
      - hosted-mode
      - layout-contract
      - schema
  - id: operators
    file: operators.md
    type: primary
    focus: the four rewrite operators that shape wiki trees toward a token-minimal normal form
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
    tags:
      - operators
      - rebuild
      - normal-form
  - id: preflight
    file: preflight.md
    type: primary
    focus: user-facing messages for Node.js preflight failures
    activation:
      tag_matches:
        - preflight-failure
      keyword_matches:
        - node missing
        - node too old
        - install node
        - upgrade node
    tags:
      - preflight
      - user-messages
  - id: safety
    file: safety.md
    type: primary
    focus: safety envelope, phased pipeline, and commit semantics for every operation
    activation:
      keyword_matches:
        - safety
        - envelope
        - manifest
        - commit
        - backup
        - resumable
      tag_matches:
        - mutation
        - any-op
      escalation_from:
        - build
        - extend
        - rebuild
        - fix
        - join
    tags:
      - safety
      - pipeline
      - commit
  - id: schema
    file: schema.md
    type: primary
    focus: frontmatter field schema and the unified index.md file format
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
    tags:
      - schema
      - frontmatter
      - index-format
  - id: operations
    file: operations/index.md
    type: index
    focus: per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join
    activation_defaults:
      tag_matches:
        - operation
children:
  - operations/index.md
---
<!-- BEGIN AUTO-GENERATED NAVIGATION -->

# Guide

**Focus:** skill-llm-wiki operational reference routed by activation signals

**Shared across all children:**

- every operation must run the Node.js preflight before invoking scripts/cli.mjs
- every operation is explicit-invocation only and has no automatic triggers
- every mutating operation stages in .work/ and commits atomically
- free mode keeps the source immutable; hosted mode obeys the layout contract

## Children

| File | Type | Focus |
|------|------|-------|
| [cli.md](cli.md) | 📄 primary | complete CLI subcommand reference for scripts/cli.mjs |
| [concepts.md](concepts.md) | 📄 primary | core vocabulary and static structure rules for LLM wikis |
| [invariants.md](invariants.md) | 📄 primary | hard validation invariants and soft shape signals for LLM wikis |
| [layout-contract.md](layout-contract.md) | 📄 primary | hosted-mode layout contract schema, validation, and conflict-resolution rules |
| [operators.md](operators.md) | 📄 primary | the four rewrite operators that shape wiki trees toward a token-minimal normal form |
| [preflight.md](preflight.md) | 📄 primary | user-facing messages for Node.js preflight failures |
| [safety.md](safety.md) | 📄 primary | safety envelope, phased pipeline, and commit semantics for every operation |
| [schema.md](schema.md) | 📄 primary | frontmatter field schema and the unified index.md file format |
| [operations/index.md](operations/index.md) | 📁 index | per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
This wiki holds the skill-llm-wiki operational reference. It is not meant to
be read top-to-bottom. It is loaded slice-by-slice by SKILL.md's routing
table at the skill root — each top-level operation lists the exact set of
leaves to read for that operation. Do not browse this wiki outside the
routing discipline; Claude should only open leaves its current operation
explicitly names.
<!-- END AUTHORED ORIENTATION -->
