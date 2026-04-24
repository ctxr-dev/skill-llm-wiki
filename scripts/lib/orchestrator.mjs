// orchestrator.mjs — glue a top-level operation (build / extend / rebuild
// / fix / join) to the phased execution model defined in methodology
// section 9.4. Every phase commits to the private git repo between phases,
// giving `git log pre-op/<id>..op/<id>` a granular view of what the
// operation did.
//
// Phase 3 ships with a minimum-viable set of phases that make `build`
// produce a real wiki from a source folder:
//
//   preflight  →  pre-op snapshot  →  ingest  →  draft-frontmatter  →
//   index-generation  →  validation  →  commit-finalize
//
// Operator-convergence is a stub here — it lands properly in Phase 5
// (chunked iteration) + Phase 6 (tiered AI). For Build against a
// well-shaped source, the tree is usable without it; for Rebuild the
// stub is a no-op and a warning is printed so Claude surfaces it.
//
// On validation failure, the orchestrator runs `git reset --hard
// pre-op/<id> && git clean -fd`, restoring the working tree to its
// pre-op state byte-exact. Phase commits since the pre-tag remain in
// the reflog for post-mortem inspection.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { ingestSource } from "./ingest.mjs";
import { draftCategory, draftLeafFrontmatter } from "./draft.mjs";
import { rebuildAllIndices } from "./indices.mjs";
import { validateWiki, summariseFindings } from "./validate.mjs";
import {
  gitClean,
  gitCommit,
  gitResetHard,
  gitRunChecked,
  gitTag,
  gitHeadSha,
  gitWorkingTreeClean,
} from "./git.mjs";
import { preOpSnapshot } from "./snapshot.mjs";
import { appendOpLog } from "./history.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import {
  provenancePath,
  recordSource,
  startCorpus,
} from "./provenance.mjs";
import { MAX_BALANCE_ITERATIONS, runBalance } from "./balance.mjs";
import {
  FANOUT_TARGET_MAX,
  FANOUT_TARGET_MIN,
  MAX_DEPTH_MAX,
  MAX_DEPTH_MIN,
} from "./intent.mjs";
import { applySoftParentEntries, runSoftDagParents } from "./soft-dag.mjs";
import { runConvergence } from "./operators.mjs";
import { runJoin } from "./join.mjs";
import { runRootContainment } from "./root-containment.mjs";
import { runReviewCycle } from "../commands/review.mjs";
import {
  deriveBatchId,
  listBatches,
  readAllResponses,
  writePending,
} from "./tier2-protocol.mjs";
import {
  clearTier2Responses,
  resolveQualityMode,
  seedTier2Responses,
  takePendingRequests,
} from "./tiered.mjs";

// Public entry. `plan` comes from intent.mjs and carries
// { operation, layout_mode, source, target, is_new_wiki, flags }.
// Returns { op_id, final_sha, phases: [...] } on success; throws on
// validation failure (after rolling the working tree back to pre-op).
export async function runOperation(plan, { opId, source, startedIso } = {}) {
  if (!plan || !plan.target) {
    throw new Error("runOperation requires a resolved plan with a target");
  }
  if (!opId || typeof opId !== "string") {
    throw new Error("runOperation requires an opId");
  }
  const wikiRoot = plan.target;
  const workDir = join(wikiRoot, ".work", opId);
  mkdirSync(workDir, { recursive: true });

  const phases = [];
  const record = (name, summary) => phases.push({ name, summary });

  // `join` is the one top-level operation whose pipeline shape does
  // not match the build/rebuild/fix family. Instead of threading
  // an "ingest from N wikis" path through the build-shaped phase
  // cascade, we delegate to `scripts/lib/join.mjs::runJoin` which
  // implements all 11 phases from `guide/operations/ingest/join.md`
  // end-to-end on an already-prepared empty target. The caller
  // (intent → CLI) is responsible for ensuring `plan.target` is a
  // fresh empty directory before runOperation fires; runJoin writes
  // the unified tree there and then runs the same
  // convergence / indices / validation tail the build path would.
  // Per-phase commits are routed through runJoin's onPhaseCommit
  // callback so the private git log shows join progression at the
  // same granularity a build does.
  if (plan.operation === "join") {
    if (!Array.isArray(plan.sources) || plan.sources.length < 2) {
      throw new Error("join requires at least 2 resolved source wiki paths");
    }
    const snap = preOpSnapshot(wikiRoot, opId);
    record(
      "snapshot",
      `tag ${snap.tag} sha=${(snap.sha ?? "n/a").slice(0, 12)}`,
    );
    try {
      const result = await runJoin(plan.sources, wikiRoot, {
        opId,
        qualityMode: resolveQualityMode(plan.flags || {}),
        idCollisionPolicy: plan.flags?.id_collision,
        onPhaseCommit: async ({ phase, summary }) => {
          gitRunChecked(wikiRoot, ["add", "-A"]);
          if (!gitWorkingTreeClean(wikiRoot)) {
            gitCommit(wikiRoot, `phase ${phase}: ${summary}`);
          }
        },
      });
      for (const p of result.phases) record(p.name, p.summary);
      // Tier 2 suspend: convergence parked decisions that can't be
      // resolved without a sub-agent. Drain the pending queue,
      // write the batch, and throw NeedsTier2Error — the caller
      // catches it via the same path the build/rebuild uses, exits
      // 7, and the wiki-runner spawns sub-agents, writes responses,
      // and re-invokes the CLI. Must happen BEFORE the op tag so a
      // resume picks up at the same pre-op/... anchor.
      if (result.needs_tier2) {
        const requests = takePendingRequests(wikiRoot);
        if (requests.length > 0) {
          const batchId = deriveBatchId(
            opId,
            "join-convergence",
            result.convergence.iterations,
          );
          const path = writePending(wikiRoot, batchId, requests);
          throw new NeedsTier2Error(
            `join: operator-convergence parked ${requests.length} Tier 2 request(s) ` +
              `(batch ${batchId}); wiki-runner must resolve and re-invoke`,
            opId,
            path,
          );
        }
      }
      // Finalise — tag the op and emit the op-log entry.
      const finalTag = `op/${opId}`;
      gitTag(wikiRoot, finalTag);
      const finalSha = gitHeadSha(wikiRoot);
      appendOpLog(wikiRoot, {
        op_id: opId,
        operation: "join",
        layout_mode: plan.layout_mode,
        started: startedIso || new Date().toISOString(),
        finished: new Date().toISOString(),
        base_commit: snap.sha || "",
        final_commit: finalSha || "",
        summary:
          `join target=${plan.target} sources=${plan.sources.length} ` +
          `mode=${plan.layout_mode} phases=${phases.length}`,
      });
      record("commit-finalize", `tagged ${finalTag}`);
      return { op_id: opId, final_sha: finalSha, phases };
    } catch (err) {
      // NeedsTier2Error is NOT a failure — it's a suspend signal.
      // Don't roll back the working tree; the wiki-runner will
      // resume on re-invoke. Matches the build-path semantics.
      if (err instanceof NeedsTier2Error) {
        throw err;
      }
      // Roll working tree back to the pre-op snapshot, matching the
      // build path's failure semantics.
      try {
        gitResetHard(wikiRoot, snap.tag);
        gitClean(wikiRoot);
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }
  }

  // Map of authored index hints keyed by POSIX-relative directory
  // path from the wiki root. Populated in the ingest phase for Build
  // and consumed by rebuildAllIndices in the index-generation phase,
  // so fields like shared_covers / orientation / activation_defaults
  // survive from the source `index.md` into the synthesised target.
  const indexInputs = {};

  // Phase 1 — pre-op snapshot (always, even on empty wikis).
  const snap = preOpSnapshot(wikiRoot, opId);
  record("snapshot", `tag ${snap.tag} sha=${(snap.sha ?? "n/a").slice(0, 12)}`);

  try {
    // Phase 2 — ingest + draft-frontmatter. Phase 3 only supports the
    // BUILD path. Extend is structurally disabled here because the
    // naive overwrite of authored leaves is destructive; Phase 4 lands
    // a merge-preserving extend that respects user edits. Rebuild/Fix/
    // Join read from the wiki's frontmatter rather than raw sources —
    // also Phase 4+ scope.
    if (plan.operation === "build") {
      const sourcePath = plan.source;
      if (!sourcePath) {
        throw new Error("build requires a resolved source path");
      }
      const { leaves: candidates, indexSources } = ingestSource(sourcePath);
      writeFileSync(
        join(workDir, "candidates.json"),
        JSON.stringify({ candidates, indexSources }, null, 2),
        "utf8",
      );
      // Start the provenance manifest. `pre_commit` pins source sizes
      // to the private git's pre-op snapshot — but for Build the
      // private repo's working tree snapshot does NOT contain the
      // user's source files (source lives outside the wiki). Source
      // sizes are authoritative from `candidates[].size` at ingest
      // time and we verify against that on LOSS-01.
      startCorpus(wikiRoot, {
        root: sourcePath,
        root_hash: null,
        pre_commit: snap.sha,
        ingested_at: startedIso || new Date().toISOString(),
      });
      gitRunChecked(wikiRoot, ["add", "-A"]);
      record("ingest", `${candidates.length} candidate(s) from ${sourcePath}`);

      // Draft-frontmatter + layout. For each candidate, compute its
      // category path and write a fresh leaf .md file.
      //
      // Resume-safe (idempotent) ingest: a build that exited 7 mid-way
      // already wrote leaves — and operator-convergence may have moved
      // them under subdirectories. Re-running the loop blindly would
      // either overwrite authored frontmatter at the original path or
      // duplicate the leaf at root. Instead we:
      //
      //   1. Walk the wiki once and build a map keyed by the
      //      `source.path` field carried in each existing leaf's
      //      frontmatter → `{ absLeafPath, hash, dataKeys }`.
      //   2. For each candidate:
      //        a. If the source path is in the map AND the recorded
      //           hash matches the freshly-ingested hash, SKIP the
      //           write (the existing leaf is already correct, and any
      //           frontmatter authored by convergence is preserved).
      //        b. If the source path is in the map but the hash
      //           differs, REWRITE in place at the existing location
      //           (the source has changed and a re-draft is correct).
      //        c. If the source path is NOT in the map, write a fresh
      //           leaf at the computed category path. Initial-build
      //           runs hit this branch for every candidate.
      //
      // The first build still writes everything; resume runs skip the
      // unchanged majority and never touch leaves moved by convergence.
      const existingLeavesBySource = collectExistingLeavesBySource(wikiRoot);
      let wrote = 0;
      let skipped = 0;
      let updated = 0;
      for (const candidate of candidates) {
        const existing = existingLeavesBySource.get(candidate.source_path);
        if (existing) {
          if (existing.hash === candidate.hash) {
            // Byte-identical source → no-op. Provenance is still re-
            // recorded so the manifest reflects this op-id's view of
            // the world (startCorpus cleared the file at the top of
            // this phase).
            recordSource(wikiRoot, existing.targetRel, {
              source_path: candidate.source_path,
              source_pre_hash: candidate.hash,
              source_size: candidate.size,
              byte_range: [0, candidate.size],
              disposition: "preserved",
            });
            skipped++;
            continue;
          }
          // Hash mismatch: re-draft at the existing location so any
          // post-convergence reshape is preserved.
          const draft = draftLeafFrontmatter(candidate, {
            categoryPath: existing.relCategory,
          });
          const body =
            typeof candidate.body === "string"
              ? candidate.body
              : readFileSync(candidate.absolute_path, "utf8");
          const rendered = renderFrontmatter(draft.data) + "\n" + body;
          writeFileSync(existing.absLeafPath, rendered, "utf8");
          recordSource(wikiRoot, existing.targetRel, {
            source_path: candidate.source_path,
            source_pre_hash: candidate.hash,
            source_size: candidate.size,
            byte_range: [0, candidate.size],
            disposition: "preserved",
          });
          updated++;
          continue;
        }
        // Fresh leaf: compute the draft category and write at
        // <wiki>/<category>/<basename>.md.
        const category = draftCategory(candidate);
        const draft = draftLeafFrontmatter(candidate, {
          categoryPath: category,
        });
        const categoryDir = category ? join(wikiRoot, category) : wikiRoot;
        mkdirSync(categoryDir, { recursive: true });
        // Leaf filename on disk = final path segment of the SOURCE
        // (e.g. `operations/build.md` → `build.md`). The candidate
        // `id` stays globally unique for routing — see
        // `scripts/lib/ingest.mjs::deriveId` — but the awkward flat-
        // slug filename (`operations-build.md`) is a routing
        // distraction, so we store the plain name on disk.
        const sourceSegments = candidate.source_path.split(/[\/\\]/).filter(Boolean);
        const leafFilename = sourceSegments[sourceSegments.length - 1] || `${candidate.id}.md`;
        const leafPath = join(categoryDir, leafFilename);
        if (existsSync(leafPath)) {
          // A leaf already lives at this path but it does not carry a
          // matching `source.path`. This is the "stale collision"
          // case: a previous candidate wrote to the same filename
          // from a different source. Refuse loudly — the collision
          // means the source layout changed in a way the orchestrator
          // cannot reconcile without operator help.
          throw new Error(
            `build: leaf ${leafPath} exists but its frontmatter does ` +
              `not reference ${candidate.source_path} — refusing to ` +
              "clobber. Run `rebuild` to reconcile.",
          );
        }
        // `candidate.body` carries the source content WITH its
        // frontmatter fence already stripped by ingest.mjs (via
        // gray-matter). Prefer it over re-reading the file so we do
        // not double-stack fences in the leaf output.
        const body =
          typeof candidate.body === "string"
            ? candidate.body
            : readFileSync(candidate.absolute_path, "utf8");
        const rendered = renderFrontmatter(draft.data) + "\n" + body;
        writeFileSync(leafPath, rendered, "utf8");
        // Record the whole source file as preserved into this leaf —
        // Phase 3's draft-frontmatter does not yet split or discard
        // any portion, so the byte range is [0, size] and disposition
        // is `preserved`. Phase 6 operators will record split / merged
        // / transformed dispositions when they start reshaping entries.
        const targetRel = category
          ? `${category}/${leafFilename}`
          : leafFilename;
        recordSource(wikiRoot, targetRel, {
          source_path: candidate.source_path,
          source_pre_hash: candidate.hash,
          source_size: candidate.size,
          byte_range: [0, candidate.size],
          disposition: "preserved",
        });
        wrote++;
      }

      // Index-source inputs: source files named `index.md` (or
      // carrying `type: index` in their frontmatter) are not leaves —
      // they carry authored hints (shared_covers / orientation /
      // activation_defaults) for the SYNTHESISED target index at the
      // matching directory. Stash them under `.work/<opId>/` where the
      // index-generation phase below can pick them up and forward
      // their fields into the rebuilt `index.md` files.
      //
      // Note: index-source bodies are also provenance-recorded so
      // LOSS-01 stays satisfied. The target they map to is the
      // synthesised `<dir>/index.md` (or the root `index.md`).
      if (indexSources.length > 0) {
        const indexInputsPath = join(workDir, "index-inputs.json");
        const serialisable = indexSources.map((ix) => ({
          source_path: ix.source_path,
          dir: ix.dir,
          authored_frontmatter: ix.authored_frontmatter || {},
          body: ix.body || "",
          hash: ix.hash,
          size: ix.size,
        }));
        for (const ix of serialisable) {
          // Key by POSIX-normalised directory, "" for root. Matches
          // the key space rebuildAllIndices expects.
          indexInputs[ix.dir || ""] = ix;
        }
        writeFileSync(
          indexInputsPath,
          JSON.stringify({ indexSources: serialisable }, null, 2),
          "utf8",
        );
        for (const ix of indexSources) {
          const targetDir = ix.dir || "";
          const targetRel = targetDir
            ? `${targetDir}/index.md`
            : "index.md";
          recordSource(wikiRoot, targetRel, {
            source_path: ix.source_path,
            source_pre_hash: ix.hash,
            source_size: ix.size,
            byte_range: [0, ix.size],
            disposition: "preserved",
          });
        }
      }

      gitRunChecked(wikiRoot, ["add", "-A"]);
      if (!gitWorkingTreeClean(wikiRoot)) {
        gitCommit(
          wikiRoot,
          `phase draft-frontmatter: wrote ${wrote}` +
            (updated > 0 ? ` updated ${updated}` : "") +
            (skipped > 0 ? ` skipped ${skipped}` : "") +
            ` leaves` +
            (indexSources.length > 0
              ? ` (+${indexSources.length} index source(s))`
              : ""),
        );
      }
      record(
        "draft-frontmatter",
        `wrote ${wrote}` +
          (updated > 0 ? `, updated ${updated}` : "") +
          (skipped > 0 ? `, skipped ${skipped}` : "") +
          " leaves" +
          (indexSources.length > 0
            ? ` (+${indexSources.length} index source(s))`
            : ""),
      );
    } else if (plan.operation === "extend") {
      throw new Error(
        "extend: not yet implemented in Phase 3 — Phase 4 will add " +
          "frontmatter-preserving merge. For now, rebuild the wiki from " +
          "its source, or wait for Phase 4.",
      );
    } else {
      record(
        "ingest",
        `skipped for ${plan.operation} (phase 4+ reads from frontmatter)`,
      );
    }

    // Phase 4 — operator-convergence. Runs the tiered ladder
    // (Tier 0 TF-IDF → Tier 1 MiniLM embeddings → Tier 2 sub-agent
    // via exit-7 handshake) through the five operators from
    // methodology §3.5 PLUS the cluster-based NEST applier from
    // cluster-detect.mjs. Each applied proposal produces its own
    // per-iteration commit so `git log` shows the convergence
    // history at file-level granularity.
    //
    // On resume (after a previous exit-7 wrote responses), we
    // seed tiered.mjs's runtime-resolved-response map with the
    // answers collected by the wiki-runner so the next call to
    // runConvergence finds them inline instead of re-enqueuing.
    clearTier2Responses(wikiRoot);
    const priorResponses = readAllResponses(wikiRoot);
    if (priorResponses.size > 0) {
      seedTier2Responses(wikiRoot, priorResponses);
    }
    const convergence = await runConvergence(wikiRoot, {
      opId,
      // Resolve through tiered.mjs::resolveQualityMode so the
      // `LLM_WIKI_QUALITY_MODE` env var is actually consulted (the
      // prior `plan.flags?.quality_mode || "tiered-fast"` shortcut
      // silently dropped the env-var path documented in
      // methodology.md). Intent-layer INT-13 already catches an
      // invalid flag value before we reach here; an invalid env
      // var surfaces from `resolveQualityMode` as a plain throw.
      qualityMode: resolveQualityMode(plan.flags || {}),
      interactive: false, // orchestrator runs non-interactive
      commitBetweenIterations: async ({ iteration, operator, summary }) => {
        gitRunChecked(wikiRoot, ["add", "-A"]);
        if (!gitWorkingTreeClean(wikiRoot)) {
          gitCommit(
            wikiRoot,
            `phase operator-convergence: iteration ${iteration} ${operator} — ${summary}`,
          );
        }
      },
    });

    // If convergence parked any Tier 2 requests, drain them into a
    // pending batch and raise NeedsTier2 so the CLI exits with
    // code 7. The wiki-runner will write responses and re-invoke.
    if (convergence.needs_tier2) {
      const requests = takePendingRequests(wikiRoot);
      if (requests.length > 0) {
        const batchId = deriveBatchId(opId, "convergence", convergence.iterations);
        const path = writePending(wikiRoot, batchId, requests);
        throw new NeedsTier2Error(
          `operator-convergence parked ${requests.length} Tier 2 request(s) ` +
            `(batch ${batchId}); wiki-runner must resolve and re-invoke`,
          opId,
          path,
        );
      }
    }
    record(
      "operator-convergence",
      `${convergence.applied.length} operator(s) applied across ` +
        `${convergence.iterations} iteration(s); ` +
        `${convergence.suggestions.length} suggestion(s) recorded`,
    );

    // Phase 4.3 — balance enforcement. Runs only when at least one
    // of `--fanout-target` / `--max-depth` is set on the plan (both
    // validated at intent time). No-op otherwise. Iterates until
    // fixed point applying two transform classes:
    //   - Sub-cluster an overfull directory (movable leaf count >
    //     target × 1.5 — subdirs are structurally cemented and can't
    //     be carved by the math cluster detector, so a dir overfull
    //     *only* due to subdirs is un-actionable and is skipped) via
    //     the math cluster detector + deterministic naming, reusing
    //     the same helpers Phase X.3 built for the deterministic
    //     quality mode so two runs on the same tree produce identical
    //     sub-clusters.
    //   - Flatten an overdeep single-child passthrough by promoting
    //     its only subdir up one level. Descendants' `parents[]`
    //     paths are left unchanged — they are relative to the direct
    //     parent's `index.md`, so promoting an entire subtree up one
    //     level preserves every relative path by construction. Only
    //     pure passthroughs qualify; multi-child subcategories would
    //     lose structure.
    // The phase has its own commit cadence (one commit per apply);
    // the same git-add + git-commit callback convergence uses wires
    // into the private-git machinery. A no-op run (no overfull /
    // overdeep candidates) leaves the working tree byte-identical.
    // Balance-enforcement is build/rebuild-only per contract.mjs and
    // `--help`. Intent-resolution already rejects the flags on other
    // subcommands (INT-14a / INT-15a) and rejects non-integer values
    // (INT-14 / INT-15), but gate here as well in defense-in-depth —
    // any future code path that constructs a plan with balance flags
    // outside of build/rebuild (or with garbage values) would otherwise
    // trigger structural mutations outside the documented surface.
    // `Number.isFinite` rejects NaN from a non-numeric string: a NaN
    // maxDepth would make `detectDepthOverage` treat every depth as
    // over (NaN comparisons are false), potentially flattening the
    // wiki root and moving directories outside the wiki.
    // Single source of truth for the set of operations that can
    // reach the post-convergence hooks (balance enforcement + soft-
    // DAG synthesis). Named for the actual invariant (operation
    // membership), not a specific feature, so adding a third
    // post-convergence phase in the future doesn't demand another
    // one-purpose constant.
    const BUILD_REBUILD_OPS = new Set(["build", "rebuild"]);
    // Strict parse: must be a canonical base-10 integer string (no
    // leading `+`/`-`, no trailing garbage, no decimal parts, no
    // scientific notation), and must fall inside the intent-validated
    // range for its flag. `Number.parseInt` would accept `"3.5"` as
    // `3` and `"5xyz"` as `5`, which an adversarial or faulty caller
    // could use to bypass the range bounds. `/^\d+$/` + explicit
    // bounds keep orchestrator behaviour aligned with what intent
    // resolution already enforces (INT-14 / INT-15).
    const parseBalanceInt = (raw, min, max) => {
      if (raw == null) return null;
      const s = String(raw);
      if (!/^\d+$/.test(s)) return null;
      const n = Number.parseInt(s, 10);
      if (!Number.isFinite(n)) return null;
      if (n < min || n > max) return null;
      return n;
    };
    const opSupportsBalance = BUILD_REBUILD_OPS.has(plan.operation);
    const fanoutTarget = opSupportsBalance
      ? parseBalanceInt(plan.flags?.fanout_target, FANOUT_TARGET_MIN, FANOUT_TARGET_MAX)
      : null;
    const maxDepth = opSupportsBalance
      ? parseBalanceInt(plan.flags?.max_depth, MAX_DEPTH_MIN, MAX_DEPTH_MAX)
      : null;
    let balance = null;
    if (fanoutTarget != null || maxDepth != null) {
      balance = await runBalance(wikiRoot, {
        opId,
        // Same resolveQualityMode indirection as the convergence
        // phase above — keeps the env-var path working on builds
        // that use the balance-enforcement flags.
        qualityMode: resolveQualityMode(plan.flags || {}),
        fanoutTarget,
        maxDepth,
        commitBetweenIterations: async ({ iteration, operator, summary }) => {
          gitRunChecked(wikiRoot, ["add", "-A"]);
          if (!gitWorkingTreeClean(wikiRoot)) {
            gitCommit(
              wikiRoot,
              `phase balance-enforcement: iteration ${iteration} ${operator} — ${summary}`,
            );
          }
        },
      });
      record(
        "balance-enforcement",
        `${balance.applied.length} operation(s) applied across ` +
          `${balance.iterations} iteration(s); converged=${balance.converged}`,
      );
      if (!balance.converged) {
        // Enforcement contract: a user who asked for a balanced tree
        // expects the post-convergence shape to honour `--fanout-target`
        // / `--max-depth`. Hitting the 20-iteration cap means the
        // rebalance didn't reach a fixed point — any downstream
        // assumption "the tree is now balanced" would silently be
        // wrong. Fail loud here so the orchestrator's pre-op snapshot
        // restores and the user sees the problem, instead of shipping
        // a half-balanced wiki with no error.
        throw new Error(
          `balance enforcement did not converge after ${balance.iterations} ` +
            `iteration(s) (cap=${MAX_BALANCE_ITERATIONS}); applied ` +
            `${balance.applied.length} op(s). Inspect the private git ` +
            `history via the skill's hidden-git passthrough (e.g. ` +
            `\`node scripts/cli.mjs log ${wikiRoot}\`) — the private repo ` +
            `lives under \`<wiki>/.llmwiki/git\` and requires the skill's ` +
            `isolation env, which the passthrough wraps. Reduce ` +
            `--fanout-target / --max-depth strictness, or file a ` +
            `ping-pong repro.`,
        );
      }
    }

    // Phase 4.4 — optional soft-DAG parent synthesis. Runs only when
    // the user passed `--soft-dag-parents` on build / rebuild (intent
    // rejects the flag everywhere else via INT-16a). Writes soft
    // parents into each routable leaf's `parents[]` frontmatter based
    // on TF-IDF cosine similarity against candidate category
    // directories. The downstream `applySoftParentEntries` pass, which
    // runs in Phase 5 AFTER `rebuildAllIndices`, propagates each
    // leaf's soft claims into the corresponding index `entries[]`
    // arrays so a Claude navigator arriving at any claimed parent
    // sees the leaf in that parent's entries.
    //
    // Fan-in control is via `SOFT_PARENT_MAX_PER_LEAF` (default 3) and
    // `SOFT_PARENT_AFFINITY_THRESHOLD` (default 0.35). Both exported
    // from `soft-dag.mjs` — tests that want boundary behaviour can
    // pass overrides, but the CLI flag is a pure boolean.
    const softDagRequested =
      plan.flags?.soft_dag_parents === true && BUILD_REBUILD_OPS.has(plan.operation);
    let softDag = null;
    // Tracks whether the soft-DAG phase actually created a commit
    // (not just whether it found soft parents). A run with zero
    // softParentsAdded can still dirty the tree — e.g., a rerun
    // that removes previously-synthesised soft parents now below
    // threshold, or a canonical-order frontmatter rewrite that
    // leaves no net soft-parent change but still alters bytes. The
    // `--review` gate below consumes this flag to decide whether
    // Phase 4.4 contributed to the diff.
    let softDagDidCommit = false;
    if (softDagRequested) {
      softDag = await runSoftDagParents(wikiRoot);
      record(
        "soft-dag-parents",
        `${softDag.leavesProcessed} leaf/leaves scanned; ` +
          `${softDag.softParentsAdded} soft-parent pointer(s) selected`,
      );
      // Commit the frontmatter rewrites as a single iteration so the
      // private-git history preserves the DAG synthesis as a
      // distinguishable artefact. Review cycle picks up this commit
      // via the anyMutation gate below.
      gitRunChecked(wikiRoot, ["add", "-A"]);
      if (!gitWorkingTreeClean(wikiRoot)) {
        // Commit subject stays generic over the leaf count alone.
        // A per-run delta (added / removed / reordered) against the
        // pre-run parents[] would be the ideal audit trail, but the
        // orchestrator doesn't snapshot pre-run frontmatter state
        // and wiring that plumbing adds cost for a diagnostic
        // message; the per-phase record() call above already surfaces
        // `softParentsAdded` (the count of selected pointers this
        // run, which equals the "pointers present after synthesis"
        // since runSoftDagParents rewrites parents[] top-to-bottom
        // from scratch each pass). The private-git diff on the
        // commit itself is the byte-exact source of truth.
        gitCommit(
          wikiRoot,
          `phase soft-dag-parents: parents[] synthesis across ` +
            `${softDag.leavesProcessed} leaf/leaves`,
        );
        softDagDidCommit = true;
      }
    }

    // Phase 4.4.5 — root-leaf containment (X.11). Invariant: the wiki
    // root holds only `index.md` plus subdirectories — never a direct
    // `.md` leaf. Any outlier leaf that survived convergence + balance
    // (because its affinity to every other leaf fell below clustering
    // thresholds) is moved into its own semantically-named
    // subcategory derived from its own TF-IDF distinguishing tokens.
    // Runs BEFORE Phase 4.5 review so the containment commit is part
    // of the reviewable diff — users can drop/abort it like any
    // other tree-mutating phase. Runs BEFORE Phase 5 so
    // `rebuildAllIndices` sees the final tree shape (and the new
    // `<slug>/index.md` stubs get their `entries[]` populated as part
    // of the regular pass, not a separate write).
    let containmentDidCommit = false;
    const containment = await runRootContainment(wikiRoot);
    if (containment.moved > 0) {
      record(
        "root-containment",
        `moved ${containment.moved} outlier leaf/leaves into per-slug subcategories`,
      );
      gitRunChecked(wikiRoot, ["add", "-A"]);
      if (!gitWorkingTreeClean(wikiRoot)) {
        gitCommit(
          wikiRoot,
          `phase root-containment: moved ${containment.moved} outlier(s) into subcategories`,
        );
        containmentDidCommit = true;
      }
    }

    // Phase 4.5 — optional interactive review. Fires only when the
    // user passed --review AND at least one tree-mutating phase
    // actually produced commits. That's ANY of convergence, the
    // balance-enforcement phase, the soft-DAG parent phase above, or
    // the root-containment phase — each commits separately via its
    // own git callback. Pre-round-6 the gate only checked
    // convergence, which meant a no-op-convergence + active-balance
    // op (e.g. a hand-authored corpus that's already operator-clean
    // but violates the fanout/depth targets) would silently skip
    // review. The review flow prints a diff + commit list and lets
    // the user approve, abort, or drop specific iterations before
    // validation runs. Abort throws so the orchestrator's catch
    // block handles the rollback uniformly with any other failure
    // path.
    const balanceApplied = balance?.applied?.length ?? 0;
    // Use the commit-did-fire flag for soft-DAG and root-containment,
    // not their planned-work counters: a rerun that removes
    // previously-synthesised soft parents below threshold, or a
    // canonical-order frontmatter rewrite that preserves logical
    // content while altering bytes, produces the planned-work
    // counter = 0 but still dirties the tree and commits.
    const anyMutation =
      convergence.applied.length > 0 ||
      balanceApplied > 0 ||
      softDagDidCommit ||
      containmentDidCommit;
    if (plan.flags?.review && anyMutation) {
      const reviewResult = await runReviewCycle(wikiRoot, opId, {
        forceInteractive: plan.flags?.force_interactive === true,
      });
      if (reviewResult.outcome === "abort") {
        throw new ReviewAbortedError(
          `user aborted review for op ${opId} — working tree rolled back`,
          opId,
        );
      }
      // `applyDrop` uses `git revert --no-edit`, which produces its
      // own inverse commit directly in history — so by the time we
      // see `outcome: "approve"` (possibly with a non-empty
      // `dropped[]`), there is nothing left to stage or commit here.
      // We just surface the drop count in the phase summary so the
      // op-log records that drops happened.
      const dropCount = Array.isArray(reviewResult.dropped)
        ? reviewResult.dropped.length
        : 0;
      record(
        "review",
        `outcome=${reviewResult.outcome}${dropCount ? ` (dropped ${dropCount})` : ""}`,
      );
    }

    // Phase 5 — index-generation. `rebuildAllIndices` only visits
    // directories that ALREADY contain an `index.md` (plus the wiki
    // root once at least one child index exists). For a fresh Build,
    // no such stubs exist yet — we create minimal ones bottom-up so
    // the rebuild pass can fill them in with frontmatter.
    bootstrapIndexStubs(wikiRoot);
    const rebuilt = rebuildAllIndices(wikiRoot, { indexInputs });
    // Phase 5.1 — soft-DAG propagation. When Phase 4.4 synthesised
    // soft-parent pointers, `rebuildAllIndices` has just placed every
    // leaf in its DIRECT parent's `entries[]` (the primary parent) —
    // but the DAG view requires leaves to also show up under every
    // parent they claim. `applySoftParentEntries` walks each leaf's
    // `parents[]` and appends its record into each claimed non-primary
    // parent's index. Idempotent: records are deduped by id, so
    // re-running the pass produces byte-identical output.
    let softDagAppends = null;
    if (softDagRequested) {
      softDagAppends = applySoftParentEntries(wikiRoot);
      record(
        "soft-dag-propagate",
        `${softDagAppends.indicesTouched} index(es) updated; ` +
          `${softDagAppends.softEntriesAdded} soft-entry record(s) added`,
      );
    }
    gitRunChecked(wikiRoot, ["add", "-A"]);
    if (!gitWorkingTreeClean(wikiRoot)) {
      gitCommit(
        wikiRoot,
        softDagRequested
          ? `phase index-generation: rebuilt ${rebuilt.length} index.md files + soft-DAG propagation`
          : `phase index-generation: rebuilt ${rebuilt.length} index.md files`,
      );
    }
    record("index-generation", `rebuilt ${rebuilt.length} indices`);

    // Phase 6 — validation. Any hard-invariant failure halts the pipeline
    // and triggers the rollback below.
    const findings = validateWiki(wikiRoot);
    const summary = summariseFindings(findings);
    writeFileSync(
      join(workDir, "validation-report.json"),
      JSON.stringify({ findings, summary }, null, 2),
      "utf8",
    );
    if (summary.errors > 0) {
      const preview = findings
        .filter((f) => f.severity === "error")
        .slice(0, 5)
        .map((f) => `  ${f.code}: ${f.message} (${f.target})`)
        .join("\n");
      throw new ValidationError(
        `validation failed with ${summary.errors} error(s) for op ${opId} ` +
          `(rolled back to pre-op/${opId}):\n${preview}`,
        opId,
      );
    }
    record("validation", `${summary.errors} errors, ${summary.warnings} warnings`);

    // Phase 7 — commit-finalize. Tag the final commit, append op-log.
    // The tag + op-log + record() calls are the "finalise" atoms: once
    // they have run, the op is considered complete and the
    // failure-rollback path must not fire.
    const finalSha = gitHeadSha(wikiRoot);
    gitTag(wikiRoot, `op/${opId}`, "HEAD");
    appendOpLog(wikiRoot, {
      op_id: opId,
      operation: plan.operation,
      layout_mode: plan.layout_mode,
      started: startedIso || new Date().toISOString(),
      finished: new Date().toISOString(),
      base_commit: snap.sha || "",
      final_commit: finalSha || "",
      summary:
        `${plan.operation} target=${plan.target} ` +
        `source=${plan.source ?? "n/a"} mode=${plan.layout_mode} ` +
        `phases=${phases.length}`,
    });
    record("commit-finalize", `tagged op/${opId}`);

    return {
      op_id: opId,
      final_sha: finalSha,
      phases,
    };
  } catch (err) {
    // NeedsTier2 is NOT a failure path — it's the suspend-and-
    // resume signal the exit-7 handshake uses. The convergence
    // phase committed its partial work; we leave the working tree
    // as-is and let the CLI propagate the exit code. The op-log
    // is not finalised because the op isn't done.
    if (err instanceof NeedsTier2Error) {
      throw err;
    }
    // Validation or any other phase failure: reset to pre-op.
    //
    // `.llmwiki/provenance.yaml` is wiped ONLY when the current op
    // wrote it (`build`), because it lives outside the git working
    // tree and `git reset --hard` cannot undo the write. For
    // non-build operations (rebuild, fix, join) the provenance
    // file is pre-existing from an earlier build; wiping it on
    // review abort or validation failure would be unrecoverable
    // data loss.
    try {
      gitResetHard(wikiRoot, snap.tag);
      gitClean(wikiRoot);
    } catch (resetErr) {
      err.rollback_error = resetErr.message;
    }
    if (plan.operation === "build") {
      try {
        rmSync(provenancePath(wikiRoot), { force: true });
      } catch {
        /* best effort — the next operation's startCorpus will
           overwrite it anyway */
      }
    }
    throw err;
  } finally {
    // Housekeeping: run `git gc --auto` AFTER the try/catch so a gc
    // failure cannot rollback a successful op. Best-effort; log and
    // move on if gc fails.
    try {
      gitRunChecked(wikiRoot, ["gc", "--auto", "--quiet"]);
    } catch (gcErr) {
      process.stderr.write(
        `skill-llm-wiki: git gc --auto failed (non-fatal): ${gcErr.message}\n`,
      );
    }
  }
}

export class ValidationError extends Error {
  constructor(msg, opId = null) {
    super(msg);
    this.name = "ValidationError";
    this.opId = opId;
  }
}

// Thrown when a phase has accumulated Tier 2 requests and needs
// the wiki-runner to resolve them before the operation can
// continue. The CLI catches this and exits with code 7
// (NEEDS_TIER2) — exit-7 is NOT a failure path; it's a normal
// suspend-and-resume signal. The orchestrator does NOT roll back
// to the pre-op snapshot; the partial-convergence commits remain
// in the private git and the wiki is left in an intermediate
// shape for the resume to pick up.
export class NeedsTier2Error extends Error {
  constructor(msg, opId = null, pendingPath = null) {
    super(msg);
    this.name = "NeedsTier2Error";
    this.opId = opId;
    this.pendingPath = pendingPath;
  }
}

// Thrown when the user aborts an interactive review. Signals the
// orchestrator's catch-block to roll back to pre-op. The caller in
// cli.mjs recognises this class and prints a friendly "review
// aborted" message instead of a generic stack trace. Carries the
// op-id so programmatic callers can correlate without regex-
// parsing the error message.
export class ReviewAbortedError extends Error {
  constructor(msg, opId = null) {
    super(msg);
    this.name = "ReviewAbortedError";
    this.opId = opId;
  }
}

// Walk the wiki tree and ensure every directory containing `.md` leaf
// files (AND every ancestor of such a directory up to the root) has a
// minimal `index.md` stub. The stubs carry the `generator:
// skill-llm-wiki/v1` marker (required by `isWikiRoot`) and placeholder
// identity fields that `rebuildIndex` will overwrite with derived
// data. Idempotent: pre-existing indices are left alone.
//
// Stubbing ancestors is essential for depth ≥ 2: without it,
// `collectDirs` in indices.mjs cannot reach the deeper dirs because
// it walks via `listChildren.subdirs` which only counts dirs that
// already have `index.md`.
//
// This is the ONE place the orchestrator writes stub frontmatter
// directly, and only for indices. Leaves always carry their own
// drafted frontmatter from `draft-frontmatter`.
function bootstrapIndexStubs(wikiRoot) {
  const dirs = new Set();
  dirs.add(wikiRoot);
  collectLeafBearingDirs(wikiRoot, wikiRoot, dirs);
  for (const dir of dirs) {
    const indexPath = join(dir, "index.md");
    if (existsSync(indexPath)) continue;
    const isRoot = dir === wikiRoot;
    const id = isRoot ? basename(wikiRoot) : basename(dir);
    // NOTE: we deliberately omit `parents:` from the stub. `rebuildIndex`
    // knows how to derive the immediate-parent path from the directory
    // position (see indices.mjs), and previous stub code got this wrong
    // for depth ≥ 2 by pointing straight at the root. Leaving the field
    // off lets `rebuildIndex` compute it correctly for every depth.
    const stub =
      "---\n" +
      `id: ${id}\n` +
      "type: index\n" +
      (isRoot ? "depth_role: category\n" : "depth_role: subcategory\n") +
      `focus: "subtree under ${id}"\n` +
      "generator: skill-llm-wiki/v1\n" +
      "---\n\n";
    writeFileSync(indexPath, stub, "utf8");
  }
}

// Walk the wiki tree once and build a map keyed by the
// `source.path` field carried in each existing leaf's frontmatter.
// Leaves without a `source.path` are skipped silently — they belong
// to other operations (rebuild/extend) which do not participate in
// build's resume protocol.
//
// Returned shape: Map<sourceRelPath, {
//   absLeafPath:  absolute path on disk
//   targetRel:    POSIX-relative path from wikiRoot (no leading "./")
//   relCategory:  POSIX-relative category dir from wikiRoot, "" for root
//   hash:         the source.hash recorded at the last write
// }>
//
// Used by the build phase to detect "this candidate was already
// drafted, possibly at a non-default location, and is byte-identical
// to the source on disk → skip the write" without losing authored
// frontmatter or doubling up after operator-convergence reshapes.
export function collectExistingLeavesBySource(wikiRoot) {
  const map = new Map();
  walkLeafFiles(wikiRoot, wikiRoot, (absPath) => {
    let raw;
    try {
      raw = readFileSync(absPath, "utf8");
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = parseFrontmatter(raw, absPath);
    } catch {
      return;
    }
    const data = parsed?.data;
    if (!data || typeof data !== "object") return;
    const src = data.source;
    if (!src || typeof src !== "object") return;
    const sourcePath = typeof src.path === "string" ? src.path : null;
    if (!sourcePath) return;
    const hash = typeof src.hash === "string" ? src.hash : null;
    const rel = relative(wikiRoot, absPath).split(/[\\\/]/).join("/");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    map.set(sourcePath, {
      absLeafPath: absPath,
      targetRel: rel,
      relCategory: dir,
      hash,
    });
  });
  return map;
}

function walkLeafFiles(dir, wikiRoot, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkLeafFiles(full, wikiRoot, visit);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name === "index.md") continue;
    visit(full);
  }
}

// Walk the wiki tree (skipping dot-dirs like .llmwiki/.work/.shape)
// and add every directory that either (a) contains a leaf `.md` file
// or (b) contains a descendant directory that does. Adding
// intermediate ancestors is essential for depth ≥ 2 wikis: otherwise
// `collectDirs` in indices.mjs cannot reach them via its
// subdirs-with-index traversal, and the intermediate dirs never get
// an index.md at all.
function collectLeafBearingDirs(dir, wikiRoot, acc) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  let hasLeaf = false;
  let hasIndexedDescendant = false;
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isFile() && e.name.endsWith(".md") && e.name !== "index.md") {
      hasLeaf = true;
      continue;
    }
    if (e.isDirectory()) {
      const before = acc.size;
      collectLeafBearingDirs(join(dir, e.name), wikiRoot, acc);
      if (acc.size > before) hasIndexedDescendant = true;
    }
  }
  if (hasLeaf || hasIndexedDescendant) acc.add(dir);
}
