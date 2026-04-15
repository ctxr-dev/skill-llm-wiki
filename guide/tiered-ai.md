---
id: tiered-ai
type: primary
depth_role: leaf
focus: "tiered AI ladder — TF-IDF → local embeddings → Claude — with quality modes"
parents:
  - index.md
covers:
  - "Tier 0 is TF-IDF over frontmatter (focus + covers + tags) with fixed thresholds"
  - "Tier 1 is local embeddings via @xenova/transformers (MiniLM, optional dep)"
  - "Tier 2 is Claude, always executed in a dedicated sub-agent per decision — never inline"
  - "default quality mode is tiered-fast; claude-first and tier0-only are opt-in"
  - "similarity-cache at <wiki>/.llmwiki/similarity-cache/ memoises pairwise results"
  - "decision-log at <wiki>/.llmwiki/decisions.yaml records every non-trivial decision"
  - "operator-convergence routes every MERGE similarity check through tiered.decide"
  - "Tier 1 install prompt fires once per wiki in interactive mode; silent in CI/hooks"
  - "Tier 2 model + effort defaults are per-task; user overrides propagate to every sub-agent"
tags:
  - ai-strategy
  - operators
  - similarity
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
---

# Tiered AI ladder

Phase 6 of `skill-llm-wiki` routes every similarity decision through a
three-tier ladder. The **design principle** is crucial:

> Claude is used for deep-understanding decisions (structural
> judgments on semantically ambiguous entries, HUMAN-class Fix
> decisions, prose-heavy draft-frontmatter, user-intent resolution),
> **never for routing, never for lightweight pairwise similarity
> when a local tier is decisive.**

Every pairwise check runs Tier 0 first. If Tier 0 is decisive, the
ladder halts. If it's mid-band, the decision escalates to Tier 1.
If Tier 1 is also mid-band (or unavailable), the decision escalates
to Tier 2. Tier 2 is Claude. In Phase 6 it's a stub that returns
"undecidable"; Phase 7 wires in real Claude review.

## Tier 0 — TF-IDF + cosine (scripts/lib/similarity.mjs)

Pure, deterministic, no dependencies. Runs on frontmatter fields
only: `focus` (weighted 2×), `covers[]`, `tags[]`, `domains[]`.
Never touches entry bodies.

Thresholds:

- `similarity >= 0.85` → **decisive SAME**
- `similarity <= 0.30` → **decisive DIFFERENT**
- otherwise → **escalate to Tier 1**

Tier 0 is *intended* to resolve the bulk of decisions on
well-structured corpora — pairs of near-duplicate entries
should collapse as SAME, obviously unrelated pairs as DIFFERENT
— leaving only genuinely ambiguous pairs to escalate. The actual
Tier 0 hit rate on a given wiki depends on how informative the
frontmatter is; run with `--quality-mode tier0-only` and inspect
`decisions.yaml` to measure the tier distribution for your corpus.

## Tier 1 — local embeddings (scripts/lib/embeddings.mjs)

Backed by `@xenova/transformers` running MiniLM-L6-v2 locally. 384
dimensions. Cached at `<wiki>/.llmwiki/embedding-cache/<sha>.f32`.

**Optional dependency.** If `@xenova/transformers` is not installed:

- In **interactive mode** (TTY, not `--no-prompt`, not CI/hook), the
  skill prompts the user to install it on first need. Declining is
  persistent via a marker in `<wiki>/.llmwiki/tier1.yaml`.
- In **non-interactive mode** the absence is silent and decisions
  fall through from Tier 0 directly to Tier 2.

Thresholds:

- `similarity >= 0.80` → **decisive SAME**
- `similarity <= 0.45` → **decisive DIFFERENT**
- otherwise → **escalate to Tier 2**

The install is always into the skill's own directory — never into
the user's project `node_modules`. The skill runs `npm install
--save-optional @xenova/transformers` in `scripts/lib/..`.

**Mock mode:** set `LLM_WIKI_MOCK_TIER1=1` and the skill substitutes
a deterministic hash-based vector for the real model. CI uses this
by default; it also powers every unit and e2e test in the suite.

## Tier 2 — Claude (scripts/lib/tiered.mjs)

Tier 2 is reserved for decisions that TF-IDF and local embeddings
both declined to resolve. Because every Tier 2 call is a Claude
call, it carries a token cost, a latency cost, and — most
importantly — a **context-window cost** if it runs in the wrong
place. The rule is simple:

> **Every Tier 2 call runs in a dedicated sub-agent.** The main
> session never sees Tier 2 prompts, and the wiki-runner sub-agent
> never holds Tier 2 conversation history in its own window either.
> Each Tier 2 decision gets its own narrowly-scoped sub-agent with
> just the inputs that specific decision needs.

This is the Tier 2 execution model that SKILL.md's "Agent
delegation contract" implements.

### Why dedicated sub-agents per decision

- **Context isolation.** A 10k-entry wiki with 200 mid-band pairs
  would drown the wiki-runner's context if every Claude call
  landed inline. Per-decision sub-agents let the wiki-runner hold
  only the final decision, not the prompt+response.
- **Parallelism where safe.** Non-conflicting Tier 2 decisions
  (different entry pairs, different draft-frontmatter jobs, etc.)
  can fan out to parallel sub-agents. The wiki-runner collects
  results and writes them into the decision log in deterministic
  order.
- **Model choice per task.** Different Tier 2 workloads want
  different models. A draft-frontmatter pass on a short structured
  file needs the cheapest capable model; a rebuild plan review
  needs a strong reasoning model. Sub-agent spawning lets each
  call pick the right tool.
- **Cost attribution.** Each sub-agent's token usage is attributable
  to a specific decision, visible in the session's agent log, and
  traceable via `decisions.yaml`.

### Per-call sub-agent prompt shape

The wiki-runner spawns a Tier 2 sub-agent with a self-contained
prompt that includes:

1. **The question** — "are these two frontmatters the same
   concept? (MERGE candidate)", "draft a concrete `focus` string
   plus 3–5 `covers[]` bullets for this entry", "review this rebuild
   plan and flag any move that would break the narrowing chain",
   etc.
2. **Only the inputs the question needs** — two frontmatter blobs,
   one source file, one plan excerpt. Never the whole wiki, never
   unrelated context.
3. **The decision schema** — a strict JSON shape the sub-agent must
   return (`{decision, reason}` for MERGE, `{focus, covers, tags}`
   for draft-frontmatter, etc.) so the wiki-runner can parse the
   response without further chat.
4. **Any model / effort override** — if the user specified one, it
   propagates through to every Tier 2 sub-agent the operation
   spawns. No sub-agent silently upgrades or downgrades the model.

### Default model + effort matrix

| Tier 2 task | Default model | Default effort | Notes |
|---|---|---|---|
| draft-frontmatter (single entry) | Cheapest capable model for short-form writing | minimal | One sub-agent per entry that needs it; parallel safe. |
| operator-convergence (single pair) | Cost-effective model with strong short-form judgment | minimal | One sub-agent per mid-band pair; parallel safe. |
| rebuild plan review (whole plan) | Strong reasoning model | medium | Single sub-agent; reads the plan + current tree summary. |
| HUMAN-class Fix item | Strong reasoning model | medium | One sub-agent per item; each needs to justify its proposal to the user. |
| Join id-collision resolution | Strong reasoning model | minimal | One sub-agent per collision cluster. |

Unless the user specifies otherwise in the main session ("use
sonnet", "minimal effort everywhere", "use opus 1M"), pick from
this matrix. User overrides pass through verbatim to every Tier 2
spawn under the current operation.

### Caching still short-circuits

The similarity cache (see below) is consulted **before** the
sub-agent spawn. A cache hit never triggers a Tier 2 call at all —
the decision is reused from `.llmwiki/similarity-cache/`. Cache
misses are the only pairs that reach the Tier 2 sub-agent. This
means a 10k-entry wiki that has been rebuilt once amortises almost
all of its Tier 2 cost on subsequent rebuilds.

### What the wiki-runner keeps after a Tier 2 call

- The final decision (`same` / `different` / `undecidable`).
- The tier used, confidence band, similarity score, and one-line
  reason — all written into `decisions.yaml`.
- **Not** the prompt, not the response body, not the sub-agent's
  chain of thought. Those live only in the sub-agent's transcript
  and are dropped when the sub-agent returns.

## Quality modes

Choose via `--quality-mode` or the `LLM_WIKI_QUALITY_MODE` env var.

| Mode | Behaviour | Use when |
|------|-----------|----------|
| **`tiered-fast`** (default) | Full ladder. Tier 0 → Tier 1 → Tier 2 on mid-band escalations. | General-purpose builds. |
| `claude-first` | Tier 0 is still consulted for decisive cases. Mid-band Tier 0 skips Tier 1 and goes directly to Tier 2. | When the user values Claude's judgment over speed/cost. |
| `tier0-only` | Tier 0 only. Mid-band decisions become "undecidable" and the caller must resolve manually. | Air-gapped, hermetic CI, and smoke tests that must not reach out to Claude. |

**Phase 6 caveat:** Tier 2 is a stub in Phase 6 — it always returns
`undecidable`. This means `claude-first` is behaviourally identical
to `tier0-only` for MERGE decisions until Phase 7 wires in real
Claude review. Mid-band pairs under `claude-first` today produce
audit-log entries with `decision: undecidable` and the operator
does not fire. Prefer `tiered-fast` in Phase 6 — Tier 1's mock or
real embeddings carry the decisive-same / decisive-different
weight.

## Similarity cache

Every decision is cached at
`<wiki>/.llmwiki/similarity-cache/<hashA-hashB>.json`, keyed by the
sorted pair of content hashes. Subsequent lookups short-circuit the
entire ladder — the convergence loop can iterate over a pair many
times without re-paying the TF-IDF + embedding cost.

The cache is symmetric: `cacheKey(a, b) === cacheKey(b, a)`.

## Decision log

`<wiki>/.llmwiki/decisions.yaml` records every non-trivial decision
with:

- `op_id` — the operation that triggered the check
- `operator` — MERGE / DECOMPOSE / NEST / DESCEND / LIFT
- `sources[]` — the entry ids involved
- `tier_used` — 0, 1, or 2
- `similarity` — the final similarity value
- `confidence_band` — decisive-same / decisive-different / mid-band
- `decision` — same / different / undecidable
- `reason` — free-form, populated when the decision carries
  explanatory context

Claude-at-session-time reads this log when a user asks "why was
this merged?" — the audit trail answers the question from recorded
history rather than re-running the computation.

## Operators that use the ladder

Phase 6 ships:

- **LIFT** — doesn't use the ladder (structural detection: one leaf
  in a folder)
- **MERGE** — uses the ladder to decide whether sibling pairs are
  the same
- **DESCEND** — doesn't use the ladder (structural detection:
  authored zone byte budget + leaf-content signatures)
- **NEST** and **DECOMPOSE** — detect-only in Phase 6 (they fire
  suggestions for the shape-check log but application is deferred)

The convergence loop applies proposals in the order DESCEND > LIFT >
MERGE > NEST > DECOMPOSE so reducing moves always precede expanding
moves (methodology §3.5 tie-break).

## What this does NOT do

- Invoke Claude during routing. The router walks frontmatter
  deterministically and never consults similarity scores.
- Cache across wikis. Each wiki owns its own `similarity-cache/`
  and `embedding-cache/`.
- Share cache entries across mock / real model boundaries. The
  embedding cache is namespaced by mode: mock-mode vectors live at
  `<wiki>/.llmwiki/embedding-cache/mock/` and real-model vectors at
  `<wiki>/.llmwiki/embedding-cache/model-minilm/`. Switching modes
  is equivalent to a fresh cache — a `LLM_WIKI_MOCK_TIER1=1` run
  cannot pollute a subsequent real-model run and vice versa.
- Fall back to Tier 0 when a Tier 1 real-model call errors. An
  error in the embedder is a hard fail for the current decision —
  the caller re-runs or the user fixes the environment. We don't
  silently lower quality under load.
