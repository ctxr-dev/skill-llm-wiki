---
id: scale
type: primary
depth_role: leaf
focus: "chunked iteration, bounded memory, context-window hygiene, and how the skill handles multi-megabyte corpora"
parents:
  - index.md
covers:
  - "iterEntries yields one entry at a time with a lazy loadBody() thunk"
  - "frontmatter reads are bounded (max 256 KB per entry) via a streaming fs reader"
  - "operator-convergence reads frontmatter only — no body touches memory during detection"
  - "streaming consumer pattern: load → process → releaseBody → next — keeps peak at 1"
  - "listChildren was rewired to use readFrontmatterStreaming so rebuildAllIndices scales"
  - "per-phase commits plus diff --op <id> let you inspect large operations without loading the whole tree"
  - "the wiki-runner sub-agent auto-compacts its own context between phases; phase commits are the durable checkpoint"
  - "Tier 2 fan-out to per-decision sub-agents keeps the wiki-runner's own window lean"
tags:
  - scale
  - performance
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
---

# Scale-aware processing

The skill's phased operations (Build, Extend, Rebuild, Fix, Join) all
read wiki entries through a single chokepoint: `iterEntries` in
`scripts/lib/chunk.mjs`. That chokepoint enforces two bounded-memory
guarantees:

## 1. Frontmatter reads are bounded

Every entry's frontmatter is read via `readFrontmatterStreaming`,
which opens the file, reads in 4 KB chunks, and stops as soon as it
finds the closing `---\n` fence. It raises a loud error if a fence
is not found within **256 KB** — that's a pathological frontmatter
ceiling, not a normal case. The body of the file is never loaded
during detection phases.

Result: for a wiki with 10,000 leaves × 50 KB average body, the
memory cost of walking every entry's frontmatter is ~40 MB
(4 KB × 10,000) instead of ~500 MB (50 KB × 10,000).

## 2. Body access is lazy and explicit

The iterator yields `{ path, relPath, data, type, loadBody }`. The
`loadBody()` method is a thunk — calling it reads the file fresh
and returns the body string. The iterator never caches bodies, so
the caller controls exactly how long a body stays in memory.

The **streaming consumer pattern** is the load-bearing discipline:

```js
for (const entry of iterEntries(wikiRoot)) {
  const body = await entry.loadBody();
  // ...do work with body...
  releaseBody();                // balances the loadBody discipline counter
}
```

`releaseBody()` decrements a process-global **discipline counter**
that tracks caller hygiene — NOT actual memory residency. V8 has no
cheap JavaScript-side hook for "is this string still alive?", so
the counter measures whether consumers follow the load-process-
release pattern, not whether the body is really reclaimed. A
caller that calls `releaseBody()` while still holding a reference
to `body` does not free the memory; V8 does that when GC runs and
the reference falls out of scope.

The counter catches a specific class of bug: consumers that
accidentally *accumulate* bodies in an array or closure across
iterations. In that case `peakInFlightBodies` grows to N and any
regression test can flag it. For real memory-residency questions
run under `node --expose-gc` and measure `process.memoryUsage()`
directly.

An imbalanced `releaseBody()` (more releases than loads) throws
loudly, so discipline bugs surface at the offending call site
instead of silently muddying the counter.

## 3. Operator-convergence is frontmatter-only by construction

The methodology (sections 3.5, 3.6, 8.5) mandates that operator
detection runs on frontmatter alone. The chunk API enforces this
mechanically: `iterEntries` does not return a body field, only a
thunk. A detection phase that never calls `loadBody()` cannot
accidentally allocate body bytes. Phase 6's tiered AI ladder
(TF-IDF → embeddings → Claude) operates on the same frontmatter-only
surface, so the scale guarantee extends through classify and
rebuild-plan-review as well.

## 4. Index regeneration respects the bound

`scripts/lib/indices.mjs`'s `listChildren` was rewired to use
`readFrontmatterStreaming` directly. A `rebuildAllIndices` call on a
10 k-entry wiki allocates bounded frontmatter bytes per leaf, not
full files. The scale e2e test measures this via the `totalBodyLoads`
metric and asserts it stays at zero during a whole-tree rebuild.

## 5. diff --op at scale

Large operations produce many commits — the orchestrator makes one
commit per phase, so a single build creates ~6 commits regardless of
corpus size. `skill-llm-wiki diff <wiki> --op <id> --stat` reads the
git object database, not the working tree — so the diff cost is
proportional to what *changed* in the operation, not to the total
wiki size. A 10,000-file wiki whose build made three operator
applications renders its diff in tens of milliseconds.

## 6. Context-window management in the wiki-runner

Byte-level memory is not the only bounded resource in a large
build. The wiki-runner sub-agent has its own **context window**, and
a 10k-entry build that fans out Tier 2 calls and stitches
progress back into the main transcript will overflow that window
long before it runs out of heap. The skill handles this with three
rules that together let the wiki-runner survive wikis of any
size.

### Rule 1 — Phase commits are the durable checkpoint

Every phase the orchestrator runs ends with a git commit in
`<wiki>/.llmwiki/git/`. Once `phase draft-frontmatter` has
committed its output, the wiki-runner's in-memory knowledge of
**what each entry's frontmatter looks like right now** is
redundant: `git show HEAD:<path>` can reconstruct it on demand.
The same applies to every operator-convergence iteration commit,
every index-generation commit, and the pre-op snapshot itself.

This means the wiki-runner can treat any phase's conversation
history as discardable once the phase's closing commit lands. A
thousand entries' worth of draft-frontmatter Tier 2 prompts that
lived inside draft-frontmatter never need to be re-read from the
wiki-runner's transcript — they're in the decision log and (for
the chosen frontmatter) in the commit tree.

### Rule 2 — Tier 2 work fans out to per-decision sub-agents

Every Tier 2 call is a separate sub-agent (see
`guide/tiered-ai.md` "Tier 2 execution via dedicated sub-agents").
The wiki-runner sees only the final decision, not the sub-agent's
prompt or response body. A 10k-entry wiki with 500 mid-band pairs
produces 500 Tier 2 sub-agents, but the wiki-runner's own window
absorbs only 500 one-line decisions (plus whatever the
similarity-cache served without a Claude call at all).

### Rule 3 — Self-monitor and auto-compact

The wiki-runner periodically checks its remaining context budget.
When the budget falls below a safety threshold (typically around
20–25% remaining), it performs an **auto-compact** before
starting the next phase:

1. **Cut to the last clean checkpoint.** The most recent phase
   commit is the earliest safe point to resume from. Everything
   in the conversation after that commit is summarisable.
2. **Summarise what remains.** Produce a short paragraph per
   completed phase — what it did, which op-id it committed under,
   any warnings worth carrying forward. This summary lives in
   the compacted transcript instead of the full per-phase chatter.
3. **Re-anchor the plan.** State the current phase, the next
   phase, the remaining work (entries pending / iterations
   remaining), and the pre-op tag. A resume from this compacted
   state must be able to pick up exactly where the pre-compact
   run left off.
4. **Drop Tier 2 transcripts.** Per-decision sub-agent transcripts
   are already not in the wiki-runner's window (Rule 2), but any
   lingering summaries can be replaced by a single line: "Tier 2
   decisions landed: N same, M different, K undecidable (see
   decisions.yaml)."
5. **Verify state against git.** Run `skill-llm-wiki log --op
   <id>` to confirm the expected phase commits are reachable
   from HEAD — this catches the rare case where the auto-compact
   dropped a commit the agent thought had landed.

Steps 1–5 are cheap: they're all reads against the private git,
no mutation happens. Auto-compaction is idempotent — running it
twice in a row is safe.

### What the wiki-runner does NOT do

- **Pre-emptive compaction.** Auto-compact fires only when budget
  pressure is real. Compacting prematurely wastes the headroom
  you'd need to correctly summarise the phases in the first place.
- **Mid-phase compaction.** Auto-compact runs between phase
  boundaries, never in the middle of a phase. A half-committed
  phase is not a resumable state; waiting for the phase commit
  is the right protocol.
- **Main-session compaction.** The main session is not the
  wiki-runner. If the main session's context is under pressure,
  that's a separate concern the main session handles on its own.
  See SKILL.md's "Agent delegation contract" for why the main
  session should never be holding wiki content in its window in
  the first place.

### Budget-driven fallbacks

If auto-compaction still leaves the wiki-runner under budget
pressure — e.g. a pathologically large corpus with thousands of
simultaneously-pending Tier 2 decisions — the wiki-runner should:

1. **Split the remaining operation at a phase boundary.** Roll back
   to the pre-op tag via `skill-llm-wiki rollback`, then launch a
   fresh wiki-runner sub-agent whose prompt picks up from the
   last known-good commit SHA with a clean context.
2. **Narrow the Tier 2 fan-out.** Raise the Tier 1 escalation
   threshold so fewer pairs reach Tier 2, with a note to the
   user that the run was downgraded. This trades quality for
   completability.
3. **Stop and report.** If neither of the above fits, surface the
   situation to the main session and ask the user whether to
   continue with a narrower run or wait for a `--quality-mode
   claude-first` pass on a smaller slice.

The rule is: **never silently drop quality, never silently
abort.** Either the operation completes end-to-end at the
requested quality level, or the wiki-runner returns control to
the user with a clear explanation of what it couldn't finish.

## What this does NOT do

- Tune garbage collection. V8 handles its own heap; the chunk
  iterator just ensures it gets small objects to collect.
- Stream *writes*. The orchestrator still does one `writeFileSync`
  per leaf during build. Phase 6 may revisit this if a prose-heavy
  corpus produces write pressure, but today the read path was the
  dominant cost.
- Cache bodies across iterations. Each convergence pass re-invokes
  `iterEntries` with fresh reads, so frontmatter edits from the
  previous pass land correctly. A caching layer would break this
  and is deliberately omitted.
