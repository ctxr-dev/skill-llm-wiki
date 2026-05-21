// tier2-protocol.test.mjs — schema validation, pollution defense,
// batch round-trip, fixture loading.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TIER2_KINDS,
  TIER2_EXIT_CODE,
  deriveBatchId,
  listBatches,
  loadFixture,
  makeRequest,
  pendingPath,
  readAllResponses,
  readPending,
  readResponses,
  resolveFromFixture,
  responsesPath,
  tier2Dir,
  tier2KindOf,
  validateRequest,
  validateResponse,
  writePending,
  writeResponses,
} from "../../scripts/lib/tier2-protocol.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-t2p-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

test("TIER2_EXIT_CODE is 7", () => {
  assert.equal(TIER2_EXIT_CODE, 7);
});

test("TIER2_KINDS includes all expected kinds", () => {
  for (const k of [
    "merge_decision",
    "nest_decision",
    "cluster_name",
    "propose_structure",
    "draft_frontmatter",
    "rebuild_plan_review",
    "human_fix_item",
  ]) {
    assert.ok(TIER2_KINDS.includes(k), `missing kind ${k}`);
  }
});

test("propose_structure: uses balanced effort with the matching legacy alias", () => {
  const req = makeRequest("propose_structure", {
    prompt: "Propose a structure for this directory.",
    inputs: { directory: ".", leaves: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  });
  // v1-conformant envelope: top-level `kind` is the wire constant; the
  // per-Tier-2-request kind lives on `tier2_kind`.
  assert.equal(req.kind, "subagent.dispatch.v1");
  assert.equal(req.tier2_kind, "propose_structure");
  assert.equal(req.role, "wiki-tier2-propose_structure");
  assert.equal(req.effort, "balanced");
  // Deprecated aliases preserve the EXACT pre-v1 per-kind values for one
  // release: propose_structure was opus + medium (NOT effort-derived sonnet).
  assert.equal(req.model_hint, "opus");
  assert.equal(req.effort_hint, "medium");
  assert.ok(req.response_schema.subcategories);
  assert.ok(req.response_schema.siblings);
});

test("rebuild_plan_review: uses heavy effort (legacy: opus + high)", () => {
  const req = makeRequest("rebuild_plan_review", {
    prompt: "Review this rebuild plan.",
    inputs: { plan: { iterations: [] } },
  });
  assert.equal(req.effort, "heavy");
  assert.equal(req.model_hint, "opus");
  assert.equal(req.effort_hint, "high");
});

test("makeRequest: explicit `model` override is preserved on the envelope", () => {
  const req = makeRequest("merge_decision", {
    prompt: "same?",
    inputs: { a: 1, b: 2 },
    effort: "heavy",
    model: "claude-opus-4-7",
  });
  assert.equal(req.effort, "heavy");
  assert.equal(req.model, "claude-opus-4-7");
});

test("makeRequest: deprecated model_hint alias still works (one-shot warning)", () => {
  const req = makeRequest("merge_decision", {
    prompt: "same?",
    inputs: { a: 1, b: 2 },
    model_hint: "sonnet",
    effort_hint: "low",
  });
  // Deprecated path: aliases pass through unchanged.
  assert.equal(req.model_hint, "sonnet");
  assert.equal(req.effort_hint, "low");
  // The new `effort` field defaults from TIER2_DEFAULTS when not supplied.
  assert.ok(["heavy", "balanced", "light"].includes(req.effort));
});

test("makeRequest: rejects an effort outside {heavy, balanced, light}", () => {
  assert.throws(
    () =>
      makeRequest("merge_decision", {
        prompt: "same?",
        inputs: { a: 1, b: 2 },
        effort: "extreme",
      }),
    /invalid effort "extreme".*heavy.*balanced.*light/,
  );
});

test("makeRequest: every kind emits its exact pre-v1 legacy model_hint/effort_hint pair", () => {
  // Byte-compatible deprecation window: these are the EXACT pre-v1 per-kind
  // values, NOT derived uniformly from effort.
  const expected = {
    merge_decision: ["sonnet", "low"],
    nest_decision: ["sonnet", "medium"],
    cluster_name: ["sonnet", "low"],
    propose_structure: ["opus", "medium"],
    draft_frontmatter: ["sonnet", "medium"],
    rebuild_plan_review: ["opus", "high"],
    human_fix_item: ["sonnet", "low"],
  };
  for (const [kind, [model_hint, effort_hint]] of Object.entries(expected)) {
    const req = makeRequest(kind, { prompt: "p", inputs: { x: 1 } });
    assert.equal(req.model_hint, model_hint, `${kind} model_hint`);
    assert.equal(req.effort_hint, effort_hint, `${kind} effort_hint`);
  }
});

test("nest_decision: schema uses keep_flat (not keep-flat)", () => {
  const req = makeRequest("nest_decision", {
    prompt: "Should these leaves nest?",
    inputs: { leaves: ["a", "b", "c"] },
  });
  assert.equal(req.response_schema.decision, "nest|keep_flat|undecidable");
});

test("makeRequest: fills defaults from kind matrix", () => {
  const req = makeRequest("cluster_name", {
    prompt: "Name the cluster containing these three leaves.",
    inputs: { leaves: [{ id: "a" }, { id: "b" }, { id: "c" }] },
  });
  assert.equal(req.kind, "subagent.dispatch.v1");
  assert.equal(req.tier2_kind, "cluster_name");
  assert.equal(req.model_hint, "sonnet");
  assert.equal(req.effort_hint, "low");
  assert.ok(req.response_schema.slug);
  assert.ok(typeof req.request_id === "string");
  assert.ok(req.request_id.length > 0);
});

test("makeRequest: deterministic request_id for same inputs", () => {
  const a = makeRequest("cluster_name", {
    prompt: "same prompt",
    inputs: { leaves: ["a", "b"] },
  });
  const b = makeRequest("cluster_name", {
    prompt: "same prompt",
    inputs: { leaves: ["a", "b"] },
  });
  assert.equal(a.request_id, b.request_id);
});

test("makeRequest: rejects unknown kind", () => {
  assert.throws(
    () =>
      makeRequest("bogus_kind", {
        prompt: "x",
        inputs: {},
      }),
    /unknown kind/,
  );
});

test("makeRequest: rejects empty prompt", () => {
  assert.throws(
    () =>
      makeRequest("cluster_name", {
        prompt: "",
        inputs: { leaves: [] },
      }),
    /prompt must be a non-empty string/,
  );
});

test("makeRequest: rejects inputs containing __proto__ (JSON-parsed)", () => {
  // JSON.parse creates __proto__ as an own property slot, unlike an
  // object literal where __proto__ is the prototype setter. Use the
  // JSON.parse path so the pollution key lands as an own key.
  const polluted = JSON.parse('{"__proto__": {"evil": true}}');
  assert.throws(
    () =>
      makeRequest("cluster_name", {
        prompt: "x",
        inputs: polluted,
      }),
    /forbidden key/,
  );
});

test("tier2KindOf: prefers a valid tier2_kind", () => {
  assert.equal(
    tier2KindOf({ kind: "subagent.dispatch.v1", tier2_kind: "cluster_name" }),
    "cluster_name",
  );
});

test("tier2KindOf: ignores a bogus tier2_kind, falls back to legacy kind", () => {
  // An unrecognised tier2_kind must NOT be treated as valid; fall through to
  // the legacy `kind` if that one is a real tier-2 kind.
  assert.equal(
    tier2KindOf({ kind: "merge_decision", tier2_kind: "bogus" }),
    "merge_decision",
  );
});

test("tier2KindOf: returns null when neither tier2_kind nor kind names a real kind", () => {
  assert.equal(tier2KindOf({ kind: "subagent.dispatch.v1", tier2_kind: "bogus" }), null);
  assert.equal(tier2KindOf({}), null);
  assert.equal(tier2KindOf(null), null);
});

test("resolveFromFixture: a bogus tier2_kind does not match a wildcard, but legacy kind does", () => {
  const map = new Map([["__kind__merge_decision", { decision: "same", reason: "wild" }]]);
  // Bogus tier2_kind with no legacy kind → no wildcard match.
  assert.equal(
    resolveFromFixture(map, { request_id: "z", tier2_kind: "bogus" }),
    null,
  );
  // Legacy on-disk envelope (kind = the tier-2 kind, no tier2_kind) still
  // resolves via the wildcard — backward compat with the previous release.
  const resp = resolveFromFixture(map, { request_id: "z", kind: "merge_decision" });
  assert.equal(resp.decision, "same");
});

test("validateRequest: rejects a bogus envelope kind, accepts v1 literal and legacy kind", () => {
  const base = { request_id: "r", tier2_kind: "merge_decision", prompt: "p", inputs: {} };
  // Bogus envelope kind (e.g. a future/typo'd version) is rejected.
  assert.throws(
    () => validateRequest({ ...base, kind: "subagent.dispatch.v2" }),
    /request\.kind must be "subagent\.dispatch\.v1"/,
  );
  // The new v1 wire literal is accepted.
  assert.equal(validateRequest({ ...base, kind: "subagent.dispatch.v1" }), true);
  // A legacy bare tier-2 kind (pre-v1 on-disk envelope, no tier2_kind) is accepted.
  assert.equal(
    validateRequest({ request_id: "r", kind: "merge_decision", prompt: "p", inputs: {} }),
    true,
  );
});

test("validateRequest: rejects missing request_id", () => {
  assert.throws(() => validateRequest({ kind: "cluster_name", prompt: "x", inputs: {} }));
});

test("validateRequest: rejects an envelope with no `kind` even when tier2_kind is valid", () => {
  // The v1 envelope `kind` is required. A request carrying only a valid
  // tier2_kind (but no top-level kind) is neither a v1 envelope nor a
  // recognised legacy shape, so it must NOT be writable to a pending file.
  assert.throws(
    () =>
      validateRequest({
        request_id: "r",
        tier2_kind: "merge_decision",
        prompt: "p",
        inputs: {},
      }),
    /request\.kind is required/,
  );
});

test("validateRequest: accepts well-formed request", () => {
  const r = makeRequest("cluster_name", {
    prompt: "Name it",
    inputs: { leaves: ["a"] },
  });
  assert.equal(validateRequest(r), true);
});

test("validateResponse: rejects missing request_id", () => {
  assert.throws(() => validateResponse({ response: { slug: "x" } }));
});

test("validateResponse: rejects pollution in response body (JSON-parsed)", () => {
  const poisoned = JSON.parse('{"request_id": "abc", "response": {"__proto__": {"poison": true}}}');
  assert.throws(() => validateResponse(poisoned), /forbidden key/);
});

test("writePending + readPending: round-trip preserves requests", () => {
  const wiki = tmpWiki("rp");
  try {
    const req = makeRequest("merge_decision", {
      prompt: "are these two the same?",
      inputs: { a: { id: "x" }, b: { id: "y" } },
    });
    writePending(wiki, "batch1", [req]);
    const back = readPending(wiki, "batch1");
    assert.ok(back);
    assert.equal(back.batch_id, "batch1");
    assert.equal(back.requests.length, 1);
    assert.equal(back.requests[0].request_id, req.request_id);
    assert.equal(back.requests[0].kind, "subagent.dispatch.v1");
    assert.equal(back.requests[0].tier2_kind, "merge_decision");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("writeResponses + readResponses: round-trip", () => {
  const wiki = tmpWiki("rr");
  try {
    writeResponses(wiki, "batchX", [
      { request_id: "rid1", response: { decision: "same", reason: "paraphrase" } },
      { request_id: "rid2", response: { slug: "foo", purpose: "bar" } },
    ]);
    const back = readResponses(wiki, "batchX");
    assert.equal(back.responses.length, 2);
    assert.equal(back.responses[0].request_id, "rid1");
    assert.equal(back.responses[0].response.decision, "same");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("listBatches: enumerates pending files and their response paths", () => {
  const wiki = tmpWiki("list");
  try {
    writePending(wiki, "alpha", [
      makeRequest("cluster_name", { prompt: "p", inputs: { x: 1 } }),
    ]);
    writePending(wiki, "beta", [
      makeRequest("cluster_name", { prompt: "p", inputs: { x: 2 } }),
    ]);
    const batches = listBatches(wiki);
    assert.equal(batches.length, 2);
    assert.ok(batches.some((b) => b.batchId === "alpha"));
    assert.ok(batches.some((b) => b.batchId === "beta"));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readAllResponses: merges responses across batches by request id", () => {
  const wiki = tmpWiki("all");
  try {
    writePending(wiki, "b1", [
      makeRequest("cluster_name", { prompt: "p", inputs: { x: 1 } }),
    ]);
    writePending(wiki, "b2", [
      makeRequest("cluster_name", { prompt: "p", inputs: { x: 2 } }),
    ]);
    writeResponses(wiki, "b1", [
      { request_id: "r1", response: { slug: "one", purpose: "first" } },
    ]);
    writeResponses(wiki, "b2", [
      { request_id: "r2", response: { slug: "two", purpose: "second" } },
    ]);
    const map = readAllResponses(wiki);
    assert.equal(map.size, 2);
    assert.equal(map.get("r1").slug, "one");
    assert.equal(map.get("r2").slug, "two");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("deriveBatchId: deterministic for same inputs", () => {
  const a = deriveBatchId("build-1234", "convergence", 3);
  const b = deriveBatchId("build-1234", "convergence", 3);
  assert.equal(a, b);
  const c = deriveBatchId("build-1234", "convergence", 4);
  assert.notEqual(a, c);
});

test("loadFixture: returns null when env var is unset", () => {
  const prev = process.env.LLM_WIKI_TIER2_FIXTURE;
  delete process.env.LLM_WIKI_TIER2_FIXTURE;
  try {
    assert.equal(loadFixture(), null);
  } finally {
    if (prev !== undefined) process.env.LLM_WIKI_TIER2_FIXTURE = prev;
  }
});

test("loadFixture: loads a fixture array", () => {
  const dir = tmpWiki("fix");
  try {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify([
        { request_id: "abc", response: { slug: "cluster-foo", purpose: "bar" } },
      ]),
    );
    const prev = process.env.LLM_WIKI_TIER2_FIXTURE;
    process.env.LLM_WIKI_TIER2_FIXTURE = fixturePath;
    try {
      const map = loadFixture();
      assert.ok(map);
      assert.equal(map.size, 1);
      const resp = resolveFromFixture(map, { request_id: "abc" });
      assert.equal(resp.slug, "cluster-foo");
    } finally {
      if (prev === undefined) delete process.env.LLM_WIKI_TIER2_FIXTURE;
      else process.env.LLM_WIKI_TIER2_FIXTURE = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFixture: rejects fixture with __proto__ key", () => {
  const dir = tmpWiki("fix-poll");
  try {
    const fixturePath = join(dir, "fixture.json");
    // Using a raw string to get __proto__ through JSON.parse into an
    // own property slot; JSON.parse DOES accept "__proto__" as an own
    // key (unlike object literals), so the defense must catch it.
    writeFileSync(fixturePath, '{"__proto__": {"poison": true}}');
    const prev = process.env.LLM_WIKI_TIER2_FIXTURE;
    process.env.LLM_WIKI_TIER2_FIXTURE = fixturePath;
    try {
      assert.throws(() => loadFixture(), /forbidden/);
    } finally {
      if (prev === undefined) delete process.env.LLM_WIKI_TIER2_FIXTURE;
      else process.env.LLM_WIKI_TIER2_FIXTURE = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pendingPath / responsesPath / tier2Dir: use .work/tier2", () => {
  const wiki = join(tmpdir(), "fake");
  const expectedDir = join(wiki, ".work", "tier2");
  assert.equal(tier2Dir(wiki), expectedDir);
  assert.equal(pendingPath(wiki, "b1"), join(expectedDir, "pending-b1.json"));
  assert.equal(responsesPath(wiki, "b1"), join(expectedDir, "responses-b1.json"));
});
