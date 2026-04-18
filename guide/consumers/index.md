---
id: consumers
type: index
depth_role: branch
depth: 1
focus: "Integrating another skill or agent as a consumer of skill-llm-wiki"
parents:
  - ../index.md
tags:
  - consumers
  - integration
  - agent
  - skill
  - recipes
activation:
  keyword_matches:
    - consumer
    - consume
    - integrate
    - integration
    - my skill uses
    - my agent uses
    - wrap
    - depend on
    - hard dependency
  tag_matches:
    - consumers
    - integration
  escalation_from:
    - build
    - init
    - heal
    - contract
    - where
orientation: |
  Route here when a user is building another skill, agent, or CI job
  that calls skill-llm-wiki programmatically. The recipes under
  recipes/ cover the canonical patterns: seed a dated or subject
  wiki, run heal after every leaf write, gate CI on validate, handle
  the skill-absent case, and wire up a consumer test suite. Each
  recipe names the exact commands and the envelope fields consumers
  read.

  Not for: end users who are building a wiki for themselves (see
  SKILL.md + guide/operations/ instead).

entries:
  - id: consumers-quickstart
    file: quickstart.md
    type: primary
    focus: "Ten-minute integration path: detect the skill, init a topic, heal after writes"
    tags: [quickstart, integration]
  - id: recipe-dated-wiki
    file: recipes/dated-wiki.md
    type: primary
    focus: "Init a dated topic (reports, sessions, regressions) with one command"
    tags: [dated, init, hosted]
  - id: recipe-subject-wiki
    file: recipes/subject-wiki.md
    type: primary
    focus: "Init a subject topic (runbooks, adrs) with nested categories"
    tags: [subject, init, hosted]
  - id: recipe-post-write-heal
    file: recipes/post-write-heal.md
    type: primary
    focus: "The canonical after-every-leaf-write heal invocation"
    tags: [heal, envelope, post-write]
  - id: recipe-ci-gate
    file: recipes/ci-gate.md
    type: primary
    focus: "Gate CI on skill-llm-wiki validate --json"
    tags: [ci, validate, gate]
  - id: recipe-skill-absent
    file: recipes/skill-absent.md
    type: primary
    focus: "Detect the skill is missing and surface an upgrade path without silently degrading"
    tags: [skill-absent, preflight, install-hint]
  - id: recipe-testing
    file: recipes/testing.md
    type: primary
    focus: "Use the shipped testkit in consumer test suites"
    tags: [testing, testkit, fixtures]
  - id: recipe-format-gate
    file: recipes/format-gate.md
    type: primary
    focus: "Gate consumer CI on skill-llm-wiki contract --json format_version"
    tags: [contract, format-version, compatibility]

generator: "skill-llm-wiki/v1"
---

# Consumers

Every consumer recipe in this subtree follows the same shape:

1. **Trigger** — when a consumer should activate this recipe.
2. **Commands** — the exact CLI invocations with every flag.
3. **Envelope fields** — which fields the consumer reads from the
   `--json` envelope to decide what to do next.
4. **Minimum checked-in code** — the consumer-side shell or script
   that the recipe maps to, kept to the smallest honest example.
5. **Failure modes** — what happens when each step goes wrong and
   how the recipe tells the consumer to react.

Consumers should read [quickstart.md](quickstart.md) first, then
pick the recipes matching their integration shape.
