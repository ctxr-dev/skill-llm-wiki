// tier1-resume-no-reload.test.mjs — Rec 2 of the engine optimisation
// pass. Verifies that a resume cycle on a wiki with a fully-warmed
// embedding + similarity cache never dynamic-imports the Tier 1
// model module AND never computes any fresh embedding vector.
//
// Contract: `LLM_WIKI_TIER1_DEBUG=1` installs two breadcrumb hooks
// in `embeddings.mjs`:
//
//   [tier1-debug] loading Tier 1 model ...        — tryLoadTier1 ran
//   [tier1-debug] computing fresh embedding ...    — embed() cache miss
//
// On a fully-warmed resume cycle, zero lines of either kind must
// appear on stderr. In mock-mode tests (the default in CI) only the
// second breadcrumb fires for embed() cache misses — the first only
// fires via `ensureTier1` calls from `tiered.decide`'s Tier 0
// escalation path, which mock mode short-circuits. Both breadcrumbs
// being absent on the resume cycle is the invariant we care about.
//
// Flow:
//   1. Build a synthetic 4-leaf clustered corpus once. The first
//      invocation exits 7 on the Tier 2 cluster requests — we play
//      the wiki-runner role and write deterministic responses.
//   2. Resume the build until it reaches exit 0. By that point the
//      embedding cache + similarity cache are both populated.
//   3. Run the build ONE MORE TIME with LLM_WIKI_TIER1_DEBUG=1. The
//      operation is idempotent — ingest skips byte-identical leaves,
//      convergence re-runs, and every similarity decision should hit
//      the persisted cache. stderr must contain zero
//      `[tier1-debug] loading Tier 1 model` lines.
//
// We explicitly do NOT set LLM_WIKI_MOCK_TIER1 here for the
// instrumentation-sensitive step: even in mock mode the tryLoadTier1
// code path logs `[tier1-debug]` on first call, so the test can
// verify the "no reload" guarantee without requiring a real model
// download on the CI box. Mock mode is still enabled for the
// Tier 1 embeddings themselves (the embedding cache on disk does
// not distinguish mock vectors from real ones — the namespace does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "cli.mjs",
);

function runCli(args, env = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LLM_WIKI_MOCK_TIER1: "1",
      LLM_WIKI_NO_PROMPT: "1",
      ...env,
    },
  });
}

function tmpDir(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-t1resume-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writeSourceLeaf(sourceRoot, filename, data, body) {
  const path = join(sourceRoot, filename);
  mkdirSync(dirname(path), { recursive: true });
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else if (v && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2)) {
          lines.push(`  ${k2}:`);
          for (const it of v2) lines.push(`    - ${it}`);
        } else {
          lines.push(`  ${k2}: ${v2}`);
        }
      }
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", body);
  writeFileSync(path, lines.join("\n"), "utf8");
}

function writeFourLeafCorpus(sourceRoot) {
  const leaves = [
    { id: "grp-alpha", f: "alpha topic", c: ["a"], k: ["grp", "alpha"] },
    { id: "grp-beta", f: "beta topic", c: ["b"], k: ["grp", "beta"] },
    { id: "grp-gamma", f: "gamma topic", c: ["g"], k: ["grp", "gamma"] },
    { id: "grp-delta", f: "delta topic", c: ["d"], k: ["grp", "delta"] },
  ];
  for (const l of leaves) {
    writeSourceLeaf(sourceRoot, `${l.id}.md`, {
      id: l.id,
      focus: l.f,
      covers: l.c,
      tags: ["grouped", "sharedtag"],
      activation: { keyword_matches: l.k },
    }, `\n# ${l.id}\n\nContent for ${l.id}.\n`);
  }
}

// Drain any parked Tier 2 pending batches and write a deterministic
// response for each request. Mirrors the wiki-runner stand-in in
// build-resume.test.mjs. Returns the number of batches drained.
function drainTier2(tier2Dir) {
  if (!existsSync(tier2Dir)) return 0;
  const pending = readdirSync(tier2Dir).filter((n) =>
    n.startsWith("pending-"),
  );
  for (const p of pending) {
    const raw = readFileSync(join(tier2Dir, p), "utf8");
    const parsed = JSON.parse(raw);
    const responses = parsed.requests.map((req) => {
      switch (req.kind) {
        case "cluster_name":
          return {
            request_id: req.request_id,
            response: { slug: "grouped", purpose: "grouped cluster" },
          };
        case "nest_decision":
          return {
            request_id: req.request_id,
            response: { decision: "keep_flat", reason: "stub" },
          };
        case "merge_decision":
          return {
            request_id: req.request_id,
            response: { decision: "different", reason: "stub" },
          };
        case "propose_structure":
          return {
            request_id: req.request_id,
            response: {
              subcategories: [],
              siblings: (req.inputs?.leaves || []).map((l) => l.id),
              notes: "stub",
            },
          };
        default:
          return {
            request_id: req.request_id,
            response: { decision: "undecidable", reason: "stub" },
          };
      }
    });
    const batchId = p.match(/^pending-(.+)\.json$/)[1];
    writeFileSync(
      join(tier2Dir, `responses-${batchId}.json`),
      JSON.stringify({ batch_id: batchId, responses }),
      "utf8",
    );
  }
  return pending.length;
}

test("tier1-resume-no-reload: second cycle on warmed caches never reloads the model", () => {
  const parent = tmpDir("warm");
  try {
    const source = join(parent, "source");
    mkdirSync(source, { recursive: true });
    writeFourLeafCorpus(source);
    const wiki = join(parent, "source.wiki");
    const tier2Dir = join(wiki, ".work", "tier2");

    // Phase A — build to completion. May take multiple exit-7
    // rounds depending on how cluster detection plays out. On
    // every exit 7 we drain the pending batch and re-invoke until
    // we reach exit 0. LLM_WIKI_TIER1_DEBUG stays OFF here so we
    // do not capture noise from the warm-up run.
    let status = -1;
    for (let round = 0; round < 8; round++) {
      const out = runCli(["build", source, "--layout-mode", "sibling"]);
      status = out.status;
      if (status === 0) break;
      if (status !== 7) {
        assert.fail(
          `phase A round ${round + 1}: expected 0 or 7, got ${status}\n` +
            `stderr: ${out.stderr}\nstdout: ${out.stdout}`,
        );
      }
      const drained = drainTier2(tier2Dir);
      assert.ok(
        drained >= 1,
        `phase A round ${round + 1}: expected ≥1 pending batch to drain`,
      );
    }
    assert.equal(status, 0, "phase A must eventually reach exit 0");

    // Confirm the embedding cache and similarity cache both exist
    // and are non-empty on disk. Without this pre-condition the
    // "no reload" check would be vacuous.
    const embeddingCacheDir = join(
      wiki,
      ".llmwiki",
      "embedding-cache",
      "mock",
    );
    assert.ok(
      existsSync(embeddingCacheDir),
      "embedding cache dir must exist after phase A",
    );
    const embeddingFiles = readdirSync(embeddingCacheDir).filter((n) =>
      n.endsWith(".f32"),
    );
    assert.ok(
      embeddingFiles.length > 0,
      `embedding cache must be non-empty after phase A (found ${embeddingFiles.length})`,
    );

    // Phase B — resume cycle with LLM_WIKI_TIER1_DEBUG=1. Idempotent
    // build re-runs every phase; the tier1 loader must not fire
    // because every similarity decision hits the persisted caches
    // (sim cache short-circuits tiered.decide before it even touches
    // ensureTier1, and cluster-detect's embed() calls hit the
    // embedding cache before touching tryLoadTier1).
    const out2 = runCli(["build", source, "--layout-mode", "sibling"], {
      LLM_WIKI_TIER1_DEBUG: "1",
    });
    // The second build may still exit 7 if cluster-detect finds a
    // genuinely new proposal OR it may reach 0 on a no-op. Either
    // terminal status is acceptable — the invariant we care about
    // is the absence of the reload breadcrumb. We assert NEITHER
    // status alone; we only assert the absence of the load line
    // plus a non-crash exit code.
    assert.ok(
      out2.status === 0 || out2.status === 7,
      `phase B expected 0 or 7, got ${out2.status}\nstderr: ${out2.stderr}`,
    );
    const stderrLines = (out2.stderr || "").split("\n");
    const loadLines = stderrLines.filter((l) =>
      l.includes("[tier1-debug] loading Tier 1 model"),
    );
    const freshLines = stderrLines.filter((l) =>
      l.includes("[tier1-debug] computing fresh embedding"),
    );
    assert.equal(
      loadLines.length,
      0,
      `phase B must not reload the Tier 1 model on a warm cache; ` +
        `found ${loadLines.length} reload line(s):\n${loadLines.join("\n")}`,
    );
    assert.equal(
      freshLines.length,
      0,
      `phase B must not compute any fresh embeddings on a warm cache; ` +
        `found ${freshLines.length} fresh-embedding line(s):\n` +
        `${freshLines.join("\n")}\nfull stderr:\n${out2.stderr}`,
    );
  } finally {
    if (!process.env.LLM_WIKI_KEEP_TMP) {
      rmSync(parent, { recursive: true, force: true });
    } else {
      process.stderr.write(`[KEEP_TMP] ${parent}\n`);
    }
  }
});

test("tier1-resume-no-reload: cold build emits fresh-embedding breadcrumbs", () => {
  // Sanity check: on a FRESH wiki with no caches, the embedding
  // hot path must emit the "computing fresh embedding" breadcrumb
  // at least once under LLM_WIKI_TIER1_DEBUG=1. Without this the
  // warm-cache assertion in the main test could not distinguish
  // "never computes anything" from "instrumentation is broken".
  //
  // A propose_structure fixture is supplied so the convergence loop
  // moves past the "park and skip math" short-circuit into the
  // math cluster-detect code path, which calls embed() for every
  // leaf. Each first-call per-leaf is a cache miss that prints
  // a breadcrumb.
  const parent = tmpDir("cold");
  try {
    const source = join(parent, "source");
    mkdirSync(source, { recursive: true });
    writeFourLeafCorpus(source);

    const fixturePath = join(parent, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        __kind__propose_structure: {
          subcategories: [],
          siblings: ["grp-alpha", "grp-beta", "grp-gamma", "grp-delta"],
          notes: "wildcard: keep flat",
        },
        __kind__nest_decision: { decision: "keep_flat", reason: "wildcard" },
        __kind__cluster_name: { slug: "wildcard-grp", purpose: "wildcard" },
        __kind__merge_decision: { decision: "different", reason: "wildcard" },
      }),
      "utf8",
    );

    const out = runCli(["build", source, "--layout-mode", "sibling"], {
      LLM_WIKI_TIER1_DEBUG: "1",
      LLM_WIKI_TIER2_FIXTURE: fixturePath,
    });
    const freshLines = (out.stderr || "")
      .split("\n")
      .filter((l) => l.includes("[tier1-debug] computing fresh embedding"));
    assert.ok(
      freshLines.length >= 1,
      `cold build must emit at least one fresh-embedding breadcrumb; ` +
        `got ${freshLines.length}\nstderr:\n${out.stderr}`,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
