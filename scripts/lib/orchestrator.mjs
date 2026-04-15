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
import { renderFrontmatter } from "./frontmatter.mjs";
import {
  provenancePath,
  recordSource,
  startCorpus,
} from "./provenance.mjs";
import { rmSync } from "node:fs";
import { runConvergence } from "./operators.mjs";
import { runReviewCycle } from "../commands/review.mjs";

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
      const candidates = ingestSource(sourcePath);
      writeFileSync(
        join(workDir, "candidates.json"),
        JSON.stringify({ candidates }, null, 2),
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
      // category path and write a fresh leaf .md file. Build is the
      // "no authored content yet" case, so unconditional writes are
      // safe. If a leaf file already exists at the target path we
      // refuse: the user asked for a fresh build into a wiki that
      // already carries prior content, which should not happen on a
      // clean sibling build — and the extend path is disabled until
      // Phase 4 merges frontmatter properly.
      let wrote = 0;
      for (const candidate of candidates) {
        const category = draftCategory(candidate);
        const draft = draftLeafFrontmatter(candidate, {
          categoryPath: category,
        });
        const categoryDir = join(wikiRoot, category);
        mkdirSync(categoryDir, { recursive: true });
        const leafPath = join(categoryDir, `${candidate.id}.md`);
        if (existsSync(leafPath)) {
          throw new Error(
            `build: refusing to overwrite existing leaf ${leafPath} — ` +
              "use `rebuild` or Phase 4's `extend` (not yet shipped) instead",
          );
        }
        const body = readFileSync(candidate.absolute_path, "utf8");
        const rendered = renderFrontmatter(draft.data) + "\n" + body;
        writeFileSync(leafPath, rendered, "utf8");
        // Record the whole source file as preserved into this leaf —
        // Phase 3's draft-frontmatter does not yet split or discard
        // any portion, so the byte range is [0, size] and disposition
        // is `preserved`. Phase 6 operators will record split / merged
        // / transformed dispositions when they start reshaping entries.
        const targetRel = `${category}/${candidate.id}.md`;
        recordSource(wikiRoot, targetRel, {
          source_path: candidate.source_path,
          source_pre_hash: candidate.hash,
          source_size: candidate.size,
          byte_range: [0, candidate.size],
          disposition: "preserved",
        });
        wrote++;
      }
      gitRunChecked(wikiRoot, ["add", "-A"]);
      if (!gitWorkingTreeClean(wikiRoot)) {
        gitCommit(wikiRoot, `phase draft-frontmatter: wrote ${wrote} leaves`);
      }
      record("draft-frontmatter", `wrote ${wrote} leaves`);
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
    // (Tier 0 TF-IDF → Tier 1 local embeddings → Tier 2 Claude stub)
    // through the five operators from methodology §3.5. Each applied
    // proposal produces its own per-iteration commit so `git log`
    // shows the convergence history at file-level granularity.
    const convergence = await runConvergence(wikiRoot, {
      opId,
      qualityMode: plan.flags?.quality_mode || "tiered-fast",
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
    record(
      "operator-convergence",
      `${convergence.applied.length} operator(s) applied across ` +
        `${convergence.iterations} iteration(s); ` +
        `${convergence.suggestions.length} suggestion(s) recorded`,
    );

    // Phase 4.5 — optional interactive review. Fires only when the
    // user passed --review AND convergence actually produced at
    // least one commit. The review flow prints a diff + commit
    // list and lets the user approve, abort, or drop specific
    // iterations before validation runs. Abort throws so the
    // orchestrator's catch block handles the rollback uniformly
    // with any other failure path.
    if (plan.flags?.review && convergence.applied.length > 0) {
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
    const rebuilt = rebuildAllIndices(wikiRoot);
    gitRunChecked(wikiRoot, ["add", "-A"]);
    if (!gitWorkingTreeClean(wikiRoot)) {
      gitCommit(
        wikiRoot,
        `phase index-generation: rebuilt ${rebuilt.length} index.md files`,
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
    // Validation or any phase failure: reset to pre-op.
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
