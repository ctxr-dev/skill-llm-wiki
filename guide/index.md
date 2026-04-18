---
id: guide
type: index
depth_role: category
depth: 0
focus: skill-llm-wiki operational reference routed by activation signals
parents: []
shared_covers:
  - "every operation must run the Node.js preflight before invoking scripts/cli.mjs"
  - every operation is explicit-invocation only and has no automatic triggers
  - "every operation runs a phase pipeline under the private git at <wiki>/.llmwiki/git/ with per-phase commits and an atomic op/<id> tag at commit-finalize"
  - "sibling (default) and hosted modes keep the source immutable; in-place mode anchors reversibility on the pre-op/<id> snapshot"
orientation: |
  This is a real LLM wiki. Claude routes into it semantically: read each
  entry's one-line `focus` in `entries[]` below and decide whether the
  branch is relevant to the current task. No AND-filter and no activation
  aggregation at this level — parent indices carry only id, file, type,
  focus, and tags per entry. Descend into relevant branches, stopping at
  the narrowest leaf whose focus covers the task. Per-leaf `activation`
  blocks (when present in a loaded leaf) are advisory disambiguation
  hints, not routing gates. Informational queries with no operation
  keyword usually activate nothing here and are answered from SKILL.md
  alone. Note: `bisect` is retained as a hint keyword on the leaf that
  handles git-history questions, even though there is no
  `skill-llm-wiki bisect` subcommand — a user asking "can I bisect the
  wiki history?" should still route there so Claude can explain the
  `log`/`diff`/`history` path (or drive `git bisect` directly against
  the private repo).

generator: "skill-llm-wiki/v1"
rebuild_needed: false
rebuild_reasons: []
rebuild_command: "skill-llm-wiki rebuild <wiki> --plan"
entries:
  - id: cli
    file: cli.md
    type: primary
    focus: "complete CLI subcommand reference for scripts/cli.mjs"
    tags:
      - cli
      - commands
      - reference
  - id: basics
    file: "basics/index.md"
    type: index
    focus: "Core vocabulary, structure rules, and frontmatter/index schema fundamentals."
  - id: correctness
    file: "correctness/index.md"
    type: index
    focus: Hard invariants, validation, and the safety envelope around every mutation.
  - id: history
    file: "history/index.md"
    type: index
    focus: Hidden private git repo backing history, diff, and remote mirroring.
  - id: isolation
    file: "isolation/index.md"
    type: index
    focus: "Coexistence with the user's own git repo and bounded-memory scaling for large corpora."
  - id: layout
    file: "layout/index.md"
    type: index
    focus: Layout modes, hosted-mode contract, and in-place conversion of source folders.
  - id: operations
    file: "operations/index.md"
    type: index
    focus: per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join
  - id: substrate
    file: "substrate/index.md"
    type: index
    focus: Decision machinery — rewrite operators and the tiered AI ladder driving them.
    tags:
      - operators
  - id: ux
    file: "ux/index.md"
    type: index
    focus: User-facing intent resolution and preflight failure messaging.
  - id: consumers
    file: "consumers/index.md"
    type: index
    focus: "Integrating another skill or agent as a consumer of skill-llm-wiki."
    tags:
      - consumers
      - integration
children:
  - "basics/index.md"
  - "correctness/index.md"
  - "history/index.md"
  - "isolation/index.md"
  - "layout/index.md"
  - "operations/index.md"
  - "substrate/index.md"
  - "ux/index.md"
  - "consumers/index.md"
---
<!-- BEGIN AUTO-GENERATED NAVIGATION -->

# Guide.wiki

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
| [basics/index.md](basics/index.md) | 📁 index | Core vocabulary, structure rules, and frontmatter/index schema fundamentals. |
| [correctness/index.md](correctness/index.md) | 📁 index | Hard invariants, validation, and the safety envelope around every mutation. |
| [history/index.md](history/index.md) | 📁 index | Hidden private git repo backing history, diff, and remote mirroring. |
| [isolation/index.md](isolation/index.md) | 📁 index | Coexistence with the user's own git repo and bounded-memory scaling for large corpora. |
| [layout/index.md](layout/index.md) | 📁 index | Layout modes, hosted-mode contract, and in-place conversion of source folders. |
| [operations/index.md](operations/index.md) | 📁 index | per-operation phase pipelines for Build, Extend, Validate, Rebuild, Fix, and Join |
| [substrate/index.md](substrate/index.md) | 📁 index | Decision machinery — rewrite operators and the tiered AI ladder driving them. |
| [ux/index.md](ux/index.md) | 📁 index | User-facing intent resolution and preflight failure messaging. |
| [consumers/index.md](consumers/index.md) | 📁 index | Integrating another skill or agent as a consumer of skill-llm-wiki. |

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
