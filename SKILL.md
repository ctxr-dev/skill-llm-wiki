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
4. **Load the routing slice for this operation** — see the Routing section below. Read the listed `guide/` files in order before executing any phase beyond preflight.
5. **Plan the phases.** Use TodoWrite for long operations so the user can see progress and interrupt if needed.
6. **Start with the lowest-risk phase.** For anything touching an existing wiki, run Validate first and report findings before proceeding to structural changes.
7. **Use the CLI for deterministic phases.** Every subcommand is documented in `guide/cli.md`.
8. **Handle AI-intensive work in your own context.** Drafting `focus` and `covers[]` from prose, classifying with no taxonomy, semantic DECOMPOSE partitioning, AI-ASSIST Fix repairs — these are yours. Read the source files with `Read`, write the frontmatter with `Write`, verify it roundtrips.
9. **Verify before commit.** Always run Validate on the new state before commit. Never leave a wiki in a broken state.
10. **Stop after the requested operation completes.** Do not chain into Rebuild or Fix unless asked. Do not run `shape-check` on wikis the user didn't mention. Do not open sibling wikis for comparison.

## Routing: which `guide/` files to read for each operation

Each operation specifies the ordered list of `guide/` files to read. Read them in order before executing phases. **Do not read files outside your operation's slice.** If you finish an operation and the user asks a follow-up that requires a different operation, re-enter the workflow and load the new operation's slice from scratch.

### Build

1. `guide/concepts.md`
2. `guide/schema.md`
3. `guide/operators.md`
4. `guide/invariants.md`
5. `guide/cli.md`
6. `guide/safety.md`
7. `guide/operations/build.md`
8. **If hosted mode:** also read `guide/layout-contract.md`

### Extend

1. `guide/concepts.md`
2. `guide/schema.md`
3. `guide/invariants.md`
4. `guide/cli.md`
5. `guide/safety.md`
6. `guide/operations/extend.md`
7. **If hosted mode:** also read `guide/layout-contract.md`

### Validate

1. `guide/invariants.md`
2. `guide/cli.md`
3. `guide/operations/validate.md`
4. **If hosted mode:** also read `guide/layout-contract.md`

### Rebuild

1. `guide/concepts.md`
2. `guide/operators.md`
3. `guide/invariants.md`
4. `guide/cli.md`
5. `guide/safety.md`
6. `guide/operations/rebuild.md`
7. **If hosted mode:** also read `guide/layout-contract.md`

### Fix

1. `guide/concepts.md`
2. `guide/schema.md`
3. `guide/invariants.md`
4. `guide/cli.md`
5. `guide/safety.md`
6. `guide/operations/fix.md`
7. **If hosted mode:** also read `guide/layout-contract.md`

### Join

1. `guide/concepts.md`
2. `guide/schema.md`
3. `guide/invariants.md`
4. `guide/cli.md`
5. `guide/safety.md`
6. `guide/operations/join.md`
7. **If hosted mode:** also read `guide/layout-contract.md` (both source contracts must be compatible)

### Informational queries ("what does this skill do?", "explain layout modes", etc.)

Read nothing beyond SKILL.md. Everything needed to answer a question about the skill's capabilities, contract, or workflow is already here. Only load `guide/` files when the user explicitly asks for an operation against a target.

## Common mistakes to avoid

- **Reading files outside your routing slice.** Every byte costs tokens. Stick to the list for your operation.
- **Reading any `guide/` file for an informational query.** Answer from SKILL.md alone.
- **Reading scripts as source.** Never. Use them via `guide/cli.md`.
- **Skipping the Node.js preflight.** Runs before every operation, no exceptions.
- **Attempting to install or upgrade Node.js yourself.** Never. Relay the message from `guide/preflight.md`; the user takes the action.
- **Writing inside the user's source folder (free mode).** Never.
- **Writing outside the layout contract (hosted mode).** The contract is authoritative.
- **Writing leaf content into `index.md`.** Index bodies are navigation only. Leaf content belongs in leaf files.
- **Proposing automation.** No hooks, no watchers, no schedules. Every action is an explicit user request.
- **Running operations the user didn't ask for.** Don't chain Rebuild after Validate unless asked.
- **Mixing hosted and free mode in one operation.** Detected once, honored for the whole operation.
- **Re-reading the same `guide/` file mid-operation.** Once per operation is enough.
