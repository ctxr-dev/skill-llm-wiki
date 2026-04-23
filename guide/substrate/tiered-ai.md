---
id: tiered-ai
type: primary
depth_role: leaf
focus: tiered AI ladder — TF-IDF → local embeddings → Claude — with quality modes
parents:
  - index.md
covers:
  - "Tier 0 is TF-IDF over frontmatter (focus + covers + tags) with fixed thresholds"
  - "Tier 1 is local embeddings via @xenova/transformers (MiniLM, REQUIRED dep)"
  - "Tier 2 is a sub-agent, executed via the CLI exit-7 handshake (never inline)"
  - default quality mode is tiered-fast; claude-first and deterministic are opt-in
  - "similarity-cache at <wiki>/.llmwiki/similarity-cache/ memoises pairwise results"
  - "decision-log at <wiki>/.llmwiki/decisions.yaml records every non-trivial decision"
  - operator-convergence routes every MERGE similarity check through tiered.decide
  - cluster_name Tier 2 requests name NEST subcategories; never shortcut from tags
  - "exit-7 handshake: CLI writes pending batch to .work/tier2/ and exits 7 so the wiki-runner can spawn sub-agents"
  - Tier 2 model + effort defaults are per-task; user overrides propagate to every sub-agent
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
source:
  origin: file
  path: tiered-ai.md
  hash: "sha256:e7e8f12bc0486b7462350ffb0ff7e8bed34813c779139b49b33608b0346d9bcb"
---

# Tiered AI ladder

`skill-llm-wiki` routes every similarity decision through a
three-tier ladder. The **design principle** is crucial:

> Claude is used for deep-understanding decisions (structural
> judgments on semantically ambiguous entries, HUMAN-class Fix
> decisions, prose-heavy draft-frontmatter, user-intent resolution),
> **never for routing, never for lightweight pairwise similarity
> when a local tier is decisive.**

Every pairwise check runs Tier 0 first. If Tier 0 is decisive, the
ladder halts. If it's mid-band, the decision escalates to Tier 1.
If Tier 1 is also mid-band, the decision escalates to Tier 2.
Tier 2 is a real Claude sub-agent spawned by the wiki-runner via the
**exit-7 handshake** described below. Tier 1 is a REQUIRED dependency
— the optional-install flow was removed in v0.4.0 when the overhaul
discovered Tier 0 alone was too weak to drive the ladder on terse
technical frontmatter.

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
frontmatter is; inspect `decisions.yaml` after a build to measure
the tier distribution for your corpus (grep the `tier:` field on
every decision entry).

## Tier 1 — local embeddings (scripts/lib/embeddings.mjs)

Backed by `@xenova/transformers` running MiniLM-L6-v2 locally. 384
dimensions. Cached at `<wiki>/.llmwiki/embedding-cache/<ns>/<sha>.f32`
(the namespace differs between real-model and mock runs so a
mock-mode test never pollutes a real-model cache).

**Required dependency.** `@xenova/transformers` is listed in the
skill's `dependencies` (not devDependencies, not optional). A
`node_modules/` lacking it means the skill is broken — re-run
`npm install` in the skill directory. There is no install prompt,
no persistent decline marker, no optional-dependency fallback.

The model weights (~23 MB) are downloaded on first use by
`@xenova/transformers` into its HuggingFace cache directory.
Preflight warns when `TRANSFORMERS_CACHE` is set but the model
hasn't been materialised yet, so the operator is aware a first
call will pay the one-time download latency.

Thresholds:

- `similarity >= 0.80` → **decisive SAME**
- `similarity <= 0.45` → **decisive DIFFERENT**
- otherwise → **escalate to Tier 2**

**Mock mode:** set `LLM_WIKI_MOCK_TIER1=1` and the skill substitutes
a deterministic hash-based vector for the real model. **Tests only.**
CI uses this so the test suite stays hermetic; production builds
must never set it, because the mock collapses pairwise distances
to a 384-dim-hash function and is not a real sentence encoder.

## Tier 2 — sub-agent via exit-7 handshake (scripts/lib/tier2-protocol.mjs)

Tier 2 is reserved for decisions that TF-IDF and local embeddings
both declined to resolve, plus every cluster-naming step emitted
by the cluster detector (`cluster_name` requests are NEVER
shortcut from shared tags — a cluster the sub-agent can't name
isn't a cluster). Because every Tier 2 call is a Claude call, it
carries a token cost, a latency cost, and — most importantly — a
**context-window cost** if it runs in the wrong place. The rule
is simple:

> **Every Tier 2 call runs in a dedicated sub-agent, spawned by
> the wiki-runner via the exit-7 handshake.** The CLI never spawns
> sub-agents directly — it can't, it's a Node subprocess with no
> access to Claude Code's `Agent` tool. Instead it writes pending
> requests to `<wiki>/.work/tier2/pending-<batch>.json` and exits
> with code **7** (`NEEDS_TIER2`). Exit 7 is not a failure; it is
> a suspend-and-resume signal.

### The exit-7 handshake, step by step

1. The operator-convergence phase accumulates Tier 2 requests
   (mid-band MERGE checks, cluster-naming requests from NEST
   proposals, rebuild-plan review questions, etc.) on an
   in-memory queue via `tiered.enqueuePending`.
2. When the phase finishes, the orchestrator drains the queue
   via `takePendingRequests`, writes the batch to
   `<wiki>/.work/tier2/pending-<batch-id>.json`, and throws
   `NeedsTier2Error`.
3. The CLI catches it, prints a summary to stderr, and exits 7.
   The working tree is NOT rolled back; the partial-converge
   commits in the private git stay put.
4. The wiki-runner (a Claude Code sub-agent with `Agent` tool
   access) sees exit 7, reads every pending file under
   `<wiki>/.work/tier2/`, and spawns one `Agent` sub-agent per
   request. The sub-agent receives only the request's `prompt`,
   `inputs`, `response_schema`, `model_hint`, and `effort_hint` —
   never the whole wiki.
5. The wiki-runner collects the structured JSON responses and
   writes them to `<wiki>/.work/tier2/responses-<batch-id>.json`
   next to the pending file.
6. The wiki-runner re-invokes the CLI with the same positional
   args. The orchestrator reads every `responses-*.json` at
   startup, seeds the tiered decision cache, and resumes
   convergence from the last committed iteration.
7. If the resumed run emits a new pending batch (sub-clusters
   discovered at the next depth), steps 2–6 repeat. Termination
   is guaranteed by the `nestedParents` exclusion set — a dir
   that was the target of a NEST in the current run is never
   re-clustered.

### Tier 2 request kinds

The protocol defines a fixed set of request kinds. Each kind has
a response schema the sub-agent must match. See
`scripts/lib/tier2-protocol.mjs::TIER2_DEFAULTS` for the source
of truth; the table below is the human summary.

| Kind                  | Purpose                                | Model hint | Effort  |
|-----------------------|----------------------------------------|------------|---------|
| `merge_decision`      | Are these two entries SAME/DIFFERENT?  | sonnet     | low     |
| `nest_decision`       | Should this set nest or stay flat?     | sonnet     | medium  |
| `cluster_name`        | Name a NEST cluster (slug + purpose)   | sonnet     | low     |
| `draft_frontmatter`   | Draft focus/covers for a leaf          | sonnet     | medium  |
| `rebuild_plan_review` | Review a rebuild plan                  | opus       | high    |
| `human_fix_item`      | Decide on a HUMAN-class Fix            | sonnet     | low     |

Every request carries a deterministic `request_id` (sha256 of
the kind + canonical-JSON of the inputs, truncated to 16 hex
chars). Asking the same question twice within a run produces
the same id and the wiki-runner only needs to answer it once.

### Test hermeticity

Set `LLM_WIKI_TIER2_FIXTURE=<path>` to a JSON file containing
`{ "<request_id>": { response body } }` (or an array of
`{request_id, response}` pairs) and the CLI will resolve Tier 2
requests against the fixture INSTEAD OF exiting 7. Used
exclusively by tests; must never be set in production.

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
| `deterministic` | Tier 0 → Tier 1 ladder with a static threshold resolving mid-band Tier 1 pairs. No LLM/sub-agent is ever consulted. Cluster naming comes from `generateDeterministicSlug` + `deterministicPurpose`; Tier 2 escalations are skipped entirely. Repeated runs on the same inputs produce byte-reproducible output. | Air-gapped / hermetic CI; large deterministic corpus builds where reproducibility matters more than Tier 2's naming nuance. |

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
- `operator` — MERGE / DECOMPOSE / NEST / DESCEND / LIFT / METRIC_TRAJECTORY
- `sources[]` — the entry ids involved
- `tier_used` — 0, 1, or 2
- `similarity` — the final similarity value (or metric cost for trajectories)
- `confidence_band` — one of:
  - pairwise ladder: `decisive-same` / `decisive-different` / `mid-band`
  - NEST outcomes: `tier2-proposed` / `math-gated` / `tier2-and-math`
- `decision` — one of:
  - pairwise ladder: `same` / `different` / `undecidable`
  - NEST outcomes: `applied` / `rejected-by-metric` / `rejected-by-gate` / `rejected-stale` / `slug-renamed` / `pending-tier2`
  - metric trajectory: `measured`
- `reason` — free-form, populated when the decision carries
  explanatory context

The `slug-renamed` entry deserves a note: it is audit-trail only,
not a failure. It is written when `resolveNestSlug` pre-empts a
DUP-ID collision by suffixing a proposed slug with `-group` (or
`-group-N`). The rename is only logged if the subsequent NEST
actually commits — see `guide/substrate/operators.md` for the
contract. A reader scanning for `decision: slug-renamed` is looking
at a landed NEST whose directory name does not exactly match the
slug the Tier 2 response proposed.

Claude-at-session-time reads this log when a user asks "why was
this merged?" — the audit trail answers the question from recorded
history rather than re-running the computation.

## Operators that use the ladder

- **LIFT** — doesn't use the ladder (structural detection: one leaf
  in a folder)
- **MERGE** — uses the ladder to decide whether sibling pairs are
  the same
- **DESCEND** — doesn't use the ladder (structural detection:
  authored zone byte budget + leaf-content signatures)
- **NEST** — uses the ladder via the cluster detector and a Tier 2
  `propose_structure` / `cluster_name` / `nest_decision` round-trip.
  Applied with quality-metric gating; see
  `guide/substrate/operators.md`.
- **DECOMPOSE** — detect-only (fires suggestions for the shape-check
  log; application is deferred to a human-supervised pass).

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
