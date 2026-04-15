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
  - "every operation runs a phase pipeline under the private git at <wiki>/.llmwiki/git/ with per-phase commits and an atomic op/<id> tag at commit-finalize"
  - "sibling (default) and hosted modes keep the source immutable; in-place mode anchors reversibility on the pre-op/<id> snapshot"
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
        - build
        - extend
        - rebuild
        - fix
        - join
        - validate
        - rollback
        - migrate
        - diff
        - log
        - show
        - blame
        - reflog
        - history
        - remote
        - sync
        - ingest
        - shape-check
        - index-rebuild
        - draft-leaf
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
  - id: coexistence
    file: coexistence.md
    type: primary
    focus: "coexistence with the user's own git repository — private git stays isolated"
    activation:
      keyword_matches:
        - my repo
        - user repo
        - gitignore
        - project git
        - already in git
        - my git
        - inside a git repository
      tag_matches:
        - coexistence
        - layout
      escalation_from:
        - build
        - extend
        - rebuild
        - fix
    tags:
      - coexistence
      - isolation
      - user-repo
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
  - id: diff
    file: diff.md
    type: primary
    focus: the diff subcommand — git-style file-level changes for any operation
    activation:
      keyword_matches:
        - diff
        - changes
        - what changed
        - renamed
        - moved
        - review
        - "--stat"
        - "--name-status"
      tag_matches:
        - history
      escalation_from:
        - log
        - show
        - rebuild
        - rollback
    tags:
      - history
      - diff
  - id: hidden-git
    file: hidden-git.md
    type: primary
    focus: "how Claude leverages the wiki's private git repo for history, blame, diff, and rollback"
    activation:
      keyword_matches:
        - history
        - what changed
        - previous state
        - why was this split
        - diff
        - log
        - blame
        - bisect
        - reflog
        - prior op
        - show
      tag_matches:
        - history
      escalation_from:
        - build
        - rebuild
        - fix
        - diff
    tags:
      - history
      - git
  - id: in-place-mode
    file: in-place-mode.md
    type: primary
    focus: converting an existing folder into a wiki in place, lossless and reversible
    activation:
      keyword_matches:
        - in place
        - in-place
        - overwrite
        - transform my folder
        - convert this directory
        - make my docs into a wiki
      tag_matches:
        - layout
        - conversion
      escalation_from:
        - build
        - fix
    tags:
      - layout
      - in-place
      - conversion
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
  - id: layout-modes
    file: layout-modes.md
    type: primary
    focus: choosing between sibling (default), in-place, and hosted layout modes
    activation:
      keyword_matches:
        - layout
        - mode
        - sibling
        - in-place
        - in place
        - hosted
        - .wiki
        - target folder
        - default
      tag_matches:
        - layout
        - any-op
      escalation_from:
        - build
        - extend
        - rebuild
        - fix
    tags:
      - layout
      - operation
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
    focus: user-facing messages for preflight failures (node / git / wiki-fsck)
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
  - id: remote-sync
    file: remote-sync.md
    type: primary
    focus: remote mirroring — sharing the private wiki git history across machines
    activation:
      keyword_matches:
        - remote
        - sync
        - share
        - push history
        - backup
        - mirror
        - across machines
      tag_matches:
        - remote
        - collaboration
      escalation_from:
        - build
        - rebuild
        - diff
    tags:
      - remote
      - collaboration
      - sync
  - id: safety
    file: safety.md
    type: primary
    focus: safety envelope, phase-commit pipeline, and commit semantics for every operation
    activation:
      keyword_matches:
        - safety
        - envelope
        - commit
        - backup
        - rollback
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
  - id: scale
    file: scale.md
    type: primary
    focus: chunked iteration, bounded memory, context-window hygiene, and how the skill handles multi-megabyte corpora
    activation:
      keyword_matches:
        - large
        - big
        - megabytes
        - thousands
        - out of memory
        - out of context
        - too big
        - heap
        - bounded
      tag_matches:
        - scale
      escalation_from:
        - build
        - rebuild
        - fix
        - operator-convergence
    tags:
      - scale
      - performance
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
  - id: tiered-ai
    file: tiered-ai.md
    type: primary
    focus: tiered AI ladder — TF-IDF → local embeddings → Claude — with quality modes
    activation:
      keyword_matches:
        - similarity
        - cluster
        - merge
        - decompose
        - tokens
        - speed
        - cost
        - embeddings
        - tfidf
        - quality mode
        - claude
        - tier
      tag_matches:
        - ai-strategy
        - operators
      escalation_from:
        - build
        - rebuild
        - operator-convergence
        - merge
    tags:
      - ai-strategy
      - operators
      - similarity
  - id: user-intent
    file: user-intent.md
    type: primary
    focus: "ask, don't guess — how to resolve ambiguous user requests before running the skill"
    activation:
      keyword_matches:
        - unclear
        - ambiguous
        - convert
        - migrate
        - update
        - fix my wiki
        - what should I do
      tag_matches:
        - ux
      escalation_from:
        - build
        - extend
        - rebuild
        - fix
        - join
        - rollback
    tags:
      - ux
      - intent
      - prompting
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
- every operation runs a phase pipeline under the private git at <wiki>/.llmwiki/git/ with per-phase commits and an atomic op/<id> tag at commit-finalize
- sibling (default) and hosted modes keep the source immutable; in-place mode anchors reversibility on the pre-op/<id> snapshot

## Children

| File | Type | Focus |
|------|------|-------|
| [cli.md](cli.md) | 📄 primary | complete CLI subcommand reference for scripts/cli.mjs |
| [coexistence.md](coexistence.md) | 📄 primary | coexistence with the user's own git repository — private git stays isolated |
| [concepts.md](concepts.md) | 📄 primary | core vocabulary and static structure rules for LLM wikis |
| [diff.md](diff.md) | 📄 primary | the diff subcommand — git-style file-level changes for any operation |
| [hidden-git.md](hidden-git.md) | 📄 primary | how Claude leverages the wiki's private git repo for history, blame, diff, and rollback |
| [in-place-mode.md](in-place-mode.md) | 📄 primary | converting an existing folder into a wiki in place, lossless and reversible |
| [invariants.md](invariants.md) | 📄 primary | hard validation invariants and soft shape signals for LLM wikis |
| [layout-contract.md](layout-contract.md) | 📄 primary | hosted-mode layout contract schema, validation, and conflict-resolution rules |
| [layout-modes.md](layout-modes.md) | 📄 primary | choosing between sibling (default), in-place, and hosted layout modes |
| [operators.md](operators.md) | 📄 primary | the four rewrite operators that shape wiki trees toward a token-minimal normal form |
| [preflight.md](preflight.md) | 📄 primary | user-facing messages for preflight failures (node / git / wiki-fsck) |
| [remote-sync.md](remote-sync.md) | 📄 primary | remote mirroring — sharing the private wiki git history across machines |
| [safety.md](safety.md) | 📄 primary | safety envelope, phase-commit pipeline, and commit semantics for every operation |
| [scale.md](scale.md) | 📄 primary | chunked iteration, bounded memory, context-window hygiene, and how the skill handles multi-megabyte corpora |
| [schema.md](schema.md) | 📄 primary | frontmatter field schema and the unified index.md file format |
| [tiered-ai.md](tiered-ai.md) | 📄 primary | tiered AI ladder — TF-IDF → local embeddings → Claude — with quality modes |
| [user-intent.md](user-intent.md) | 📄 primary | ask, don't guess — how to resolve ambiguous user requests before running the skill |
| [operations/index.md](operations/index.md) | 📁 index | per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join |

<!-- END AUTO-GENERATED NAVIGATION -->

<!-- BEGIN AUTHORED ORIENTATION -->
This wiki holds the skill-llm-wiki operational reference. It is not meant to
be read top-to-bottom. It is loaded slice-by-slice by SKILL.md's routing
table at the skill root — each top-level operation lists the exact set of
leaves to read for that operation. Do not browse this wiki outside the
routing discipline; Claude should only open leaves its current operation
explicitly names.

**Note on `bisect` as a routing keyword.** `guide/hidden-git.md` lists
`bisect` in its `activation.keyword_matches` block even though the skill
does **not** ship a `skill-llm-wiki bisect` subcommand. The keyword is
retained deliberately so that a user asking "can I bisect my wiki
history?" routes into `hidden-git.md`, where Claude can explain how to
use `log` / `diff` / `history` to achieve the same result (or, for
advanced users, how to drive `git bisect` directly against
`<wiki>/.llmwiki/git/` with the skill's isolation env). Removing the
keyword would route such questions nowhere. See the inline note at the
top of `hidden-git.md`'s body.
<!-- END AUTHORED ORIENTATION -->
