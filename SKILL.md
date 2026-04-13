---
name: skill-llm-wiki
description: Use when the user explicitly asks to build, extend, validate, repair, rebuild, or merge an LLM-optimized knowledge wiki from markdown notes, documentation, source code, or mixed folders. Supports free mode (sibling-versioned outputs) and hosted mode (strict layout contract enforced in-place). SKILL.md is the entry point; detailed operation instructions are loaded on demand from `guide/` per the routing table below.
---

# skill-llm-wiki

## ⚠ Read only SKILL.md and the specific `guide/` files it points to

**Hard rule:** SKILL.md is your entry point. You may additionally read files inside the `guide/` subdirectory of this skill, but **only** those SKILL.md's routing table explicitly names for the current operation. Never read anything else in this skill directory: never open `README.md`, never open files under `scripts/`, never open `LICENSE`, never open `guide/` files the routing table didn't list, never open arbitrary files out of curiosity. Never `cat` / `head` / `tail` / `Read` a file just to see what's in it.

Scripts under `scripts/` are tools, not references. They are invoked via `node scripts/cli.mjs <subcommand>` exactly as documented in `guide/cli.md`. Never read their source. Never import from them. Never inspect their internals — everything a script does that you need to know is in `guide/cli.md`.

**Why this matters.** Every byte you read is a token spent. This skill is deliberately split so you read only the slice you need for the operation at hand. A typical Validate reads ~18 KB; a typical Build reads ~32 KB; a question about what this skill does reads just this file (~12 KB). Respect the budget.

## ⚠ Preflight: verify Node.js is installed

Before the first `node scripts/cli.mjs` invocation of any operation, run this via the Bash tool:

```bash
node --version 2>/dev/null || printf '%s\n' '__NODE_MISSING__'
```

**Interpret the single line of output:**

- **`__NODE_MISSING__`** — Node.js is not installed. Read `guide/preflight.md`, pick the "Case A" message, and relay it verbatim to the user. **Stop the operation.** Do not attempt any `node scripts/cli.mjs` command. Do not try to install Node yourself.
- **`v<N>.x.x` where N < 18** — Node.js is too old. Read `guide/preflight.md`, pick the "Case B" message, substitute the version string, and relay it verbatim. **Stop the operation.**
- **`v<N>.x.x` where N ≥ 18** — preflight passed. Proceed.

Preflight runs at the start of every operation. Never cache, never skip, never wrap in extra logic. `scripts/cli.mjs` also performs a runtime check and exits with code 4 if invoked on an unsupported Node — defense in depth only; always run the Bash preflight first so the user sees the detailed install/upgrade message from `guide/preflight.md`.

## What this skill does

Builds and maintains **LLM wikis**: filesystem-based knowledge stores structured for deterministic, token-efficient retrieval by a language model. Six operations: **Build**, **Extend**, **Validate**, **Rebuild**, **Fix**, **Join**. Two layout modes: **free** (sibling-versioned `.llmwiki.vN/` outputs) and **hosted** (in-place writes under a user-provided layout contract). Everything is explicit-invocation only — no hooks, no watchers, no automation.

## Non-automation contract

This skill has **no hooks, no filesystem watchers, no PostToolUse listeners, no install-time wiring, no background processes**. Every action happens only in direct response to an explicit user request against an explicit target directory. If the user did not ask, do nothing. Do not propose automation. Do not create hooks. Do not schedule anything.

If the user hand-edits a wiki and indices go stale, nothing happens until they explicitly ask you to refresh it — at which point you run the operation they request.

## Layout mode detection

Before any operation, check for a layout contract at the target root:

```bash
test -f <target>/.llmwiki.layout.yaml && echo hosted || echo free
```

- **`free`** — default mode, sibling-versioned outputs (`<source>.llmwiki.vN/`), source is immutable.
- **`hosted`** — contract-driven mode, in-place writes under the contract's rules. The contract is authoritative and suppresses any rewrite operator move that would violate it.

For Build, also check an empty target: the user may have dropped a contract file there before asking you to build into it. Always check.

Mode is determined **once per operation**. Never switch modes partway through.

## How to invoke the skill

When the user asks for an operation:

0. **Run the Node.js preflight.** See above. Stop and relay the user-facing message from `guide/preflight.md` if it fails.
1. **Read the ask carefully.** Which operation? What's the source? What's the target? Confirm uncertain details before mutating anything.
2. **Identify the exact target.** Never infer a target. Ask if unclear or resolve via `node scripts/cli.mjs resolve-wiki <source>`.
3. **Detect mode** (free vs hosted) as described above.
4. **Route into `guide/` via its own indices** — see the Routing section below. Read `guide/index.md`, compute the activation set from the user's ask, then read only the activated leaves. Never hand-pick `guide/` files from outside the wiki.
5. **Plan the phases.** Use TodoWrite for long operations so the user can see progress and interrupt if needed.
6. **Start with the lowest-risk phase.** For anything touching an existing wiki, run Validate first and report findings before proceeding to structural changes.
7. **Use the CLI for deterministic phases.** Every subcommand is documented in `guide/cli.md`.
8. **Handle AI-intensive work in your own context.** Drafting `focus` and `covers[]` from prose, classifying with no taxonomy, semantic DECOMPOSE partitioning, AI-ASSIST Fix repairs — these are yours. Read the source files with `Read`, write the frontmatter with `Write`, verify it roundtrips.
9. **Verify before commit.** Always run Validate on the new state before commit. Never leave a wiki in a broken state.
10. **Stop after the requested operation completes.** Do not chain into Rebuild or Fix unless asked. Do not run `shape-check` on wikis the user didn't mention. Do not open sibling wikis for comparison.

## Routing into `guide/`

`guide/` is a real LLM wiki — the same kind of structure this skill builds for users. Claude routes into it via the methodology's standard **activation procedure**, not via a hand-maintained table. This teaches you the routing discipline once so it generalises to any wiki you later operate on.

### The procedure

1. **Build a context profile** from the user's ask. A profile is a small structured object with three fields Claude constructs in its head:

    - **`keywords`** — tokens from the ask. Include operation names (`build`, `extend`, `validate`, `rebuild`, `fix`, `join`), their common synonyms (`create wiki`, `check wiki`, `repair`, `optimise`, `merge wikis`), subcommand names (`ingest`, `shape-check`), and any other concrete terms the user used.
    - **`tags`** — short categorical labels Claude derives from the ask:
        - `operation` — set whenever the user is requesting any of the six operations (otherwise the operations subcategory stays short-circuited).
        - `hosted-mode` — set when the target is hosted (the mode-detection step decided this).
        - `mutation` — set for any operation except Validate (structural change may happen).
        - `preflight-failure` — set only when the Node.js preflight check actually failed; never by default.
    - **`operation`** — the one operation id the ask is about (`build` / `extend` / `validate` / `rebuild` / `fix` / `join`), or `null` for informational queries. Used as an escalation source.

2. **Read `guide/index.md`.** Parse its frontmatter. The `entries[]` field is a self-sufficient routing table: each record carries the child's `id`, `file`, `type`, `focus`, `tags`, and — most importantly — its full `activation` block (or `activation_defaults` for subcategory indices). You do **not** need to open any leaf's frontmatter separately.

3. **Compute the activation set.** Initialise it to the empty set. For each entry in the root's `entries[]`, activate it when any of these is true:

    - `activation.keyword_matches` has a string that appears (case-insensitively) in the profile `keywords`
    - `activation.tag_matches` has a tag that is in the profile `tags`
    - `activation.escalation_from` contains the profile `operation` (or an id already in the activation set)

    Then **iterate**: re-check every entry against the now-expanded activation set. Escalation can cascade (e.g. `operation = build` activates `operations/build`, which puts `build` in the set, which triggers `cli`, `concepts`, `schema`, `operators`, `invariants`, `safety`). Stop when a full pass makes no new activations.

4. **Descend matched subcategory indices.** For each entry with `type: index` that passed step 3, AND-filter: the subcategory's `activation_defaults.tag_matches` must intersect the profile `tags`. If it does, `Read` the subcategory's own `index.md` and repeat from step 2 at that level. The subcategory's leaves are only considered once the parent activated. For `guide/`, this means `operations/` is entered only when the profile has the `operation` tag — informational queries short-circuit the whole subtree.

5. **Load the activated leaves.** Now (and only now) `Read` each leaf's full file. Do not read leaves that did not activate. Do not re-read index files.

6. **Preflight failures take a dedicated path.** If the Node.js preflight fails, your profile gets `tags: [preflight-failure]` and nothing else — this activates exactly `guide/preflight.md` and no operation leaves. Read it, relay the appropriate Case message to the user verbatim, stop.

7. **Informational queries.** When the user asks "what does this skill do?", "explain hosted mode", "what operations exist?", or any other question that does not demand an operation against a target, the profile has `operation: null` and no `operation` tag. The root `entries[]` produce zero activations. **Read nothing from `guide/`.** Answer from SKILL.md alone.

### Why this is better than a hand-maintained table

- **Self-maintaining.** Adding a new leaf to `guide/` only requires writing its frontmatter with correct activation; the routing picks it up on the next `index-rebuild`. No SKILL.md edit required.
- **Teaches a transferable skill.** The activation procedure you apply to `guide/` is the same one you apply to any LLM wiki — e.g., the user's own `./memory.llmwiki.v1/` or `./docs.llmwiki.v2/`. One procedure, infinite wikis.
- **Short-circuits informational queries.** Zero wiki reads when the user just wants to chat about what the skill is. That's the cheapest path by far.
- **Cross-cutting escalation is automatic.** `cli.md` lists every operation in its `escalation_from`, so any operation automatically pulls it in. You don't have to remember which operations need which supporting leaves.
- **Mode-aware.** `layout-contract.md`'s `activation.tag_matches: [hosted-mode]` means it loads automatically in hosted mode and never loads in free mode, with zero per-operation conditionals.

### Forbidden shortcuts

- Do not read `guide/` files by hardcoded path from SKILL.md. Always walk the activation procedure.
- Do not read leaves without first reading `guide/index.md` to see their activation.
- Do not peek into leaf frontmatter before deciding to activate — the root index already has the activation aggregated.
- Do not skip the informational-query short-circuit and preemptively read everything. Every byte costs tokens.

## Common mistakes to avoid

- **Reading `guide/` files by hardcoded path.** Always walk the activation procedure. The routing is the methodology — don't bypass it.
- **Reading any `guide/` file for an informational query.** Zero-activation profiles produce an empty load set. Answer from SKILL.md alone.
- **Peeking at leaf frontmatter before activating.** `guide/index.md` aggregates activation into `entries[]`; you never need a separate read for activation decisions.
- **Reading scripts as source.** Never. Use them via the CLI subcommands documented in `guide/cli.md` (which itself is activated via the routing procedure).
- **Skipping the Node.js preflight.** Runs before every operation, no exceptions.
- **Attempting to install or upgrade Node.js yourself.** Never. On preflight failure, profile gets `tags: [preflight-failure]`, which activates `guide/preflight.md`; read it and relay verbatim.
- **Writing inside the user's source folder (free mode).** Never.
- **Writing outside the layout contract (hosted mode).** The contract is authoritative.
- **Writing leaf content into `index.md`.** Index bodies are navigation only. Leaf content belongs in leaf files.
- **Proposing automation.** No hooks, no watchers, no schedules. Every action is an explicit user request.
- **Running operations the user didn't ask for.** Don't chain Rebuild after Validate unless asked.
- **Mixing hosted and free mode in one operation.** Detected once, honored for the whole operation.
- **Re-reading the same `guide/` file mid-operation.** Once per operation is enough.
