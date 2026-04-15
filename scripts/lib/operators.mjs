// operators.mjs — the four (plus one) rewrite operators from
// methodology §3.5:
//
//   DESCEND — push leaf-style content out of a parent index down
//             into a new or existing child leaf.
//   LIFT    — flatten a folder that contains exactly one entry by
//             moving the entry up to the parent directory.
//   MERGE   — fuse two siblings whose focus/covers overlap enough
//             that keeping them separate is pure redundancy.
//   NEST    — extract multiple H2 specialisations out of one leaf
//             into a child folder (stubbed in Phase 6 — H2 body
//             reading is not yet wired through the chunked iterator
//             so we detect but do not apply).
//   DECOMPOSE — split one leaf into multiple peer entries when its
//             `covers[]` cluster into disjoint groups (stubbed for
//             the same reason).
//
// Tie-break priority (methodology §3.5): DESCEND > LIFT > MERGE >
// NEST > DECOMPOSE. Reducing moves (DESCEND, LIFT, MERGE) fire
// before expanding moves (NEST, DECOMPOSE) so expansion never
// wastes effort on structure that was going to collapse anyway.
//
// Phase 6 ships: LIFT, MERGE, DESCEND detection + application.
// NEST and DECOMPOSE are detected and reported as suggestions for
// the shape-check audit trail but NOT applied — their application
// requires frontmatter rewrites + folder creation that Phase 6's
// scope deliberately keeps out of the operator loop.
//
// Every similarity decision flows through `tiered.mjs`. Every
// operator application goes through `git add` + `git commit` via
// the orchestrator between iterations.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { collectFrontmatterOnly } from "./chunk.mjs";
import { listChildren } from "./indices.mjs";
import { buildComparisonModel } from "./similarity.mjs";
import { decide } from "./tiered.mjs";

// Max iterations the convergence loop will run before declaring
// termination. The methodology's convergence argument proves it
// halts, but we still cap defensively in case two operators
// interact pathologically.
const MAX_CONVERGENCE_ITERATIONS = 20;

// Each operator returns an array of `Proposal` objects describing
// a change to apply. The loop priority-orders proposals, applies
// the highest-priority one, commits, and re-runs detection.
//
// A proposal has:
//   operator  — "LIFT" | "MERGE" | "DESCEND" | "NEST" | "DECOMPOSE"
//   priority  — numeric: higher = applied first
//   sources   — array of absolute paths affected
//   apply     — function({ wikiRoot, opId, decisionCtx }) → Promise<{ summary }>
//   describe  — short human-readable description for the commit message

const PRIORITY = {
  DESCEND: 5,
  LIFT: 4,
  MERGE: 3,
  NEST: 2,
  DECOMPOSE: 1,
};

// ── LIFT ──────────────────────────────────────────────────────────────
//
// Detection: a non-root directory that contains exactly one leaf
// file and no indexed subdirs. Apply: move the leaf up one level,
// delete the now-empty folder.
export function detectLift(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    if (dir === wikiRoot) continue;
    const { leaves, subdirs } = listChildren(dir);
    if (leaves.length === 1 && subdirs.length === 0) {
      const leaf = leaves[0];
      proposals.push({
        operator: "LIFT",
        priority: PRIORITY.LIFT,
        sources: [leaf.path, dir],
        describe: `LIFT ${basename(leaf.path)} out of ${basename(dir)}/`,
        apply: async () => applyLift(wikiRoot, dir, leaf),
      });
    }
  }
  return proposals;
}

async function applyLift(wikiRoot, dir, leaf) {
  const parentDir = dirname(dir);
  const newPath = join(parentDir, basename(leaf.path));
  if (existsSync(newPath)) {
    throw new Error(
      `LIFT: target ${newPath} already exists; refusing to overwrite`,
    );
  }
  // Update the leaf's parents[] to point at the new parent index.
  // When the new location is the wiki root, the parent path is
  // `index.md` (sibling-form). When the new location is still
  // nested, the parent path is `../index.md`. Writing the canonical
  // form here matches `rebuildIndex.parents` derivation and avoids
  // escape-above-root chains when lifting to depth 0.
  const raw = readFileSync(leaf.path, "utf8");
  const { data, body } = parseFrontmatter(raw, leaf.path);
  if (Array.isArray(data.parents)) {
    const liftedToRoot = parentDir === wikiRoot;
    data.parents = [liftedToRoot ? "index.md" : "../index.md"];
  }
  writeFileSync(newPath, renderFrontmatter(data, body), "utf8");
  rmSync(leaf.path, { force: true });
  // Remove the now-empty folder. If there's a stale index.md in it,
  // remove that too (it was just the category stub).
  const stubIndex = join(dir, "index.md");
  if (existsSync(stubIndex)) rmSync(stubIndex, { force: true });
  // Only remove the directory if it's empty — defensive in case
  // the detector saw 1 leaf but a newer file appeared. We use
  // recursive+force for the remove because `rmSync(..., { recursive:
  // false })` silently no-ops on any non-empty dir (including one
  // with a hidden .DS_Store), which would leave a stale folder
  // behind and break the test and the convergence loop.
  try {
    const remaining = readdirSync(dir);
    if (remaining.length === 0) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
  return { summary: `lifted ${data.id} to ${relative(wikiRoot, newPath)}` };
}

// ── MERGE ─────────────────────────────────────────────────────────────
//
// Detection: pairs of sibling leaves whose tiered similarity check
// says "same". Apply: produce a merged entry carrying the union
// of covers[] (deduped), the more general focus, both source ids as
// aliases, and delete the second source leaf.
export async function detectMerge(wikiRoot, ctx) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const { leaves } = listChildren(dir);
    if (leaves.length < 2) continue;
    // Compute the sibling-corpus IDF model ONCE per directory and
    // reuse it across every pair. This changes detectMerge's inner
    // cost from O(N² × N) tokenise+idf to O(N) tokenise+idf + O(N²)
    // cosine. For a 1000-entry directory that's the difference
    // between 10⁹ and 10⁶ operations.
    const corpus = leaves.map((l) => l.data);
    const model = buildComparisonModel(corpus);
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i];
        const b = leaves[j];
        const r = await decide(a.data, b.data, corpus, {
          wikiRoot,
          opId: ctx.opId,
          operator: "MERGE",
          qualityMode: ctx.qualityMode,
          interactive: ctx.interactive,
          tier2Handler: ctx.tier2Handler,
          precomputedModel: model,
        });
        if (r.decision === "same") {
          proposals.push({
            operator: "MERGE",
            priority: PRIORITY.MERGE,
            sources: [a.path, b.path],
            describe: `MERGE ${a.data.id} + ${b.data.id} (tier ${r.tier}, sim ${r.similarity.toFixed(2)})`,
            apply: async () => applyMerge(wikiRoot, a, b, r),
          });
        }
      }
    }
  }
  return proposals;
}

async function applyMerge(wikiRoot, a, b, decision) {
  // Keep the entry with the longer focus (more specific + usually
  // more authored) as the survivor. The other becomes an alias.
  const [keeper, absorbed] =
    (a.data.focus?.length ?? 0) >= (b.data.focus?.length ?? 0)
      ? [a, b]
      : [b, a];
  const rawKeeper = readFileSync(keeper.path, "utf8");
  const { data, body } = parseFrontmatter(rawKeeper, keeper.path);

  // Refuse to merge if the entries carry incompatible structural
  // metadata — we cannot silently pick one over the other.
  const structuralFields = ["type", "depth_role"];
  for (const field of structuralFields) {
    const kv = data[field];
    const av = absorbed.data[field];
    if (kv !== undefined && av !== undefined && kv !== av) {
      throw new Error(
        `MERGE: cannot merge ${keeper.data.id} and ${absorbed.data.id}: ` +
          `conflicting "${field}" (${kv} vs ${av})`,
      );
    }
  }

  // Union array-valued authored fields (covers, tags, domains)
  // preserving keeper order first, then absorbed's unique entries.
  const unionArray = (keeperField, absorbedField) => {
    const merged = new Set(Array.isArray(keeperField) ? keeperField : []);
    if (Array.isArray(absorbedField)) {
      for (const item of absorbedField) merged.add(item);
    }
    return Array.from(merged);
  };
  data.covers = unionArray(data.covers, absorbed.data.covers);
  if (Array.isArray(data.tags) || Array.isArray(absorbed.data.tags)) {
    data.tags = unionArray(data.tags, absorbed.data.tags);
  }
  if (Array.isArray(data.domains) || Array.isArray(absorbed.data.domains)) {
    data.domains = unionArray(data.domains, absorbed.data.domains);
  }

  // Union parents[] so the absorbed's cross-references survive.
  // The methodology's DAG semantics make `parents[0]` canonical, so
  // the keeper's first parent wins; additional parents from absorbed
  // are appended as soft parents.
  if (Array.isArray(absorbed.data.parents)) {
    const parents = new Set(data.parents ?? []);
    for (const p of absorbed.data.parents) parents.add(p);
    data.parents = Array.from(parents);
  }

  // Aliases: absorbed's id + any aliases it already had, deduped,
  // and we never alias the keeper to itself.
  const aliases = new Set(data.aliases ?? []);
  aliases.add(absorbed.data.id);
  for (const al of absorbed.data.aliases ?? []) aliases.add(al);
  aliases.delete(data.id);
  data.aliases = Array.from(aliases);

  writeFileSync(keeper.path, renderFrontmatter(data, body), "utf8");
  rmSync(absorbed.path, { force: true });
  return {
    summary:
      `merged ${absorbed.data.id} into ${keeper.data.id} ` +
      `(tier ${decision.tier}, sim ${decision.similarity.toFixed(3)})`,
  };
}

// ── DESCEND ───────────────────────────────────────────────────────────
//
// Detection: an index.md whose body authored zone exceeds a byte
// budget OR contains leaf-content signatures (code fences, checklists,
// multi-paragraph domain exposition).
//
// Apply: carve the authored zone into a new leaf file under the same
// directory, clear the authored zone on the index, and link the leaf
// from the parent.
const DESCEND_AUTHORED_BUDGET = 2048;
const LEAF_SIGNATURES = [
  /^\s*```/m,          // code fence
  /^\s*- \[ \]/m,      // checkbox list
  /^\s*\d+\.\s+\S+\n\s*\d+\.\s+\S+/m, // numbered list with 2+ items
];

export function detectDescend(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const indexPath = join(dir, "index.md");
    if (!existsSync(indexPath)) continue;
    const raw = readFileSync(indexPath, "utf8");
    let parsed;
    try {
      parsed = parseFrontmatter(raw, indexPath);
    } catch {
      continue;
    }
    const authored = extractAuthoredZone(parsed.body);
    if (!authored) continue;
    let reason = null;
    if (authored.length > DESCEND_AUTHORED_BUDGET) {
      reason = `authored zone is ${authored.length} bytes (budget ${DESCEND_AUTHORED_BUDGET})`;
    }
    for (const re of LEAF_SIGNATURES) {
      if (re.test(authored)) {
        reason = reason || "authored zone contains leaf-content signature";
        break;
      }
    }
    if (!reason) continue;
    proposals.push({
      operator: "DESCEND",
      priority: PRIORITY.DESCEND,
      sources: [indexPath],
      describe: `DESCEND content from ${relative(wikiRoot, indexPath)}: ${reason}`,
      apply: async () => applyDescend(wikiRoot, indexPath, parsed, authored, reason),
    });
  }
  return proposals;
}

function extractAuthoredZone(body) {
  if (!body) return "";
  const start = body.indexOf("<!-- BEGIN AUTHORED ORIENTATION -->");
  const end = body.indexOf("<!-- END AUTHORED ORIENTATION -->");
  if (start === -1 || end === -1) return "";
  return body.slice(start + "<!-- BEGIN AUTHORED ORIENTATION -->".length, end).trim();
}

async function applyDescend(wikiRoot, indexPath, parsed, authored, reason) {
  const dir = dirname(indexPath);
  // Create a leaf named `descended-content-<N>.md` where N is the
  // lowest free number. Deterministic and stable.
  let n = 1;
  let leafPath;
  while (true) {
    leafPath = join(dir, `descended-content-${n}.md`);
    if (!existsSync(leafPath)) break;
    n++;
  }
  const id = `descended-content-${n}`;
  const leafData = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: `content descended from ${parsed.data.id ?? basename(dir)}`,
    covers: ["content moved from parent index authored zone"],
    parents: ["index.md"],
    tags: ["descended"],
  };
  const leafBody = `\n${authored}\n`;
  writeFileSync(leafPath, renderFrontmatter(leafData, leafBody), "utf8");
  // Clear the authored zone in the parent index, leaving the
  // delimiter comments intact so future rebuilds preserve the
  // contract contract.
  const newBody = parsed.body.replace(
    /<!-- BEGIN AUTHORED ORIENTATION -->[\s\S]*?<!-- END AUTHORED ORIENTATION -->/,
    "<!-- BEGIN AUTHORED ORIENTATION -->\n<!-- END AUTHORED ORIENTATION -->",
  );
  writeFileSync(indexPath, renderFrontmatter(parsed.data, newBody), "utf8");
  return { summary: `descended content from ${relative(wikiRoot, indexPath)} into ${id}.md (${reason})` };
}

// ── NEST + DECOMPOSE (detection only in Phase 6) ─────────────────────

export function detectNestAndDecompose(wikiRoot) {
  const proposals = [];
  const dirs = walkDirs(wikiRoot);
  for (const dir of dirs) {
    const { leaves } = listChildren(dir);
    for (const leaf of leaves) {
      // DECOMPOSE signal: covers[] >= 12 items. Phase 6 reports this
      // as a non-applying proposal so the shape-check log records it
      // but convergence does not rewrite the tree.
      const covers = leaf.data.covers ?? [];
      if (covers.length >= 12) {
        proposals.push({
          operator: "DECOMPOSE",
          priority: PRIORITY.DECOMPOSE,
          sources: [leaf.path],
          describe: `DECOMPOSE candidate ${leaf.data.id} (covers=${covers.length}) — application deferred`,
          apply: async () => ({ summary: "detect-only (Phase 6 defers application)" }),
          detectOnly: true,
        });
      }
      // NEST signal: explicit nests_into[] hint in frontmatter.
      const nestsInto = Array.isArray(leaf.data.nests_into)
        ? leaf.data.nests_into
        : null;
      if (nestsInto && nestsInto.length > 0) {
        proposals.push({
          operator: "NEST",
          priority: PRIORITY.NEST,
          sources: [leaf.path],
          describe: `NEST candidate ${leaf.data.id} (nests_into ${nestsInto.length}) — application deferred`,
          apply: async () => ({ summary: "detect-only (Phase 6 defers application)" }),
          detectOnly: true,
        });
      }
    }
  }
  return proposals;
}

// ── Orchestrator entry point ─────────────────────────────────────────
//
// `runConvergence(wikiRoot, ctx)` — called from orchestrator.mjs's
// operator-convergence phase. Runs detect → highest-priority apply
// → repeat until no applied proposals or the iteration budget is
// exhausted. Returns a summary of what happened for commit messages
// and phase records.

export async function runConvergence(wikiRoot, ctx = {}) {
  const {
    opId,
    qualityMode = "tiered-fast",
    maxIterations = MAX_CONVERGENCE_ITERATIONS,
    interactive = false,
    tier2Handler,
    commitBetweenIterations = async () => {},
  } = ctx;
  const applied = [];
  const suggestions = [];
  let iteration = 0;
  while (iteration < maxIterations) {
    iteration++;
    const proposals = [];
    // Detect in priority order. DESCEND first (reducing), then LIFT,
    // MERGE, and the detect-only NEST / DECOMPOSE at the bottom.
    proposals.push(...detectDescend(wikiRoot));
    proposals.push(...detectLift(wikiRoot));
    proposals.push(
      ...(await detectMerge(wikiRoot, { opId, qualityMode, interactive, tier2Handler })),
    );
    const nestDecompose = detectNestAndDecompose(wikiRoot);
    proposals.push(...nestDecompose);

    // Filter out detect-only proposals from the application queue
    // but keep them in the suggestion audit trail.
    for (const p of nestDecompose) {
      suggestions.push({
        operator: p.operator,
        sources: p.sources,
        reason: p.describe,
      });
    }
    const applicable = proposals.filter((p) => !p.detectOnly);
    if (applicable.length === 0) break;

    // Pick the highest-priority proposal that doesn't conflict with
    // already-applied work this iteration. We apply exactly one per
    // iteration so the per-iteration commit reflects a single
    // deterministic move.
    applicable.sort((a, b) => b.priority - a.priority);
    const chosen = applicable[0];
    let result;
    try {
      result = await chosen.apply({ wikiRoot, opId });
    } catch (err) {
      // A failed apply aborts the loop. The caller's surrounding
      // try/catch (the orchestrator) rolls back via git reset.
      throw new Error(
        `operator-convergence: ${chosen.operator} failed: ${err.message}`,
      );
    }
    applied.push({
      iteration,
      operator: chosen.operator,
      sources: chosen.sources,
      describe: chosen.describe,
      result,
    });
    await commitBetweenIterations({
      iteration,
      operator: chosen.operator,
      summary: result.summary,
    });
  }
  return {
    iterations: iteration,
    applied,
    suggestions,
    converged: applied.length === 0 || iteration < maxIterations,
  };
}

// ── Directory walk helper ────────────────────────────────────────────

function walkDirs(wikiRoot) {
  const out = [wikiRoot];
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (!e.isDirectory()) continue;
        const sub = join(dir, e.name);
        out.push(sub);
        stack.push(sub);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}
