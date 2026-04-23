// decision-log.test.mjs — tiered-AI audit log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendDecision,
  appendMetricTrajectory,
  appendNestDecision,
  readDecisions,
} from "../../scripts/lib/decision-log.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-declog-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

const sample = {
  op_id: "rebuild-20260415-120000-abc",
  operator: "MERGE",
  sources: ["entry-a", "entry-b"],
  tier_used: 0,
  similarity: 0.92,
  confidence_band: "decisive-same",
  decision: "same",
  reason: "high covers overlap",
};

test("appendDecision: tolerates a log that doesn't end in a newline (no concat corruption)", () => {
  // Simulate a tampered / torn log: header + one valid entry, but
  // the final byte is a non-newline (a `:` from a half-written
  // `confidence_band:` field, say). A naive appendFileSync would
  // concatenate the next entry's `- op_id:` onto the previous
  // line and produce invalid YAML. The guard pre-checks the last
  // byte and prepends a newline if missing.
  const wiki = tmpWiki("no-trailing-newline");
  try {
    const llmwikiDir = join(wiki, ".llmwiki");
    mkdirSync(llmwikiDir, { recursive: true });
    const path = join(llmwikiDir, "decisions.yaml");
    // Plant a valid log that's been chopped off mid-entry.
    writeFileSync(
      path,
      "# skill-llm-wiki tiered-AI decision log (append-only)\n" +
        "version: 1\n" +
        "entries:\n" +
        "- op_id: old-op\n" +
        "  operator: MERGE\n" +
        "  sources:\n" +
        "    - a\n" +
        "    - b\n" +
        "  tier_used: 0\n" +
        "  similarity: 0.5\n" +
        "  confidence_band:", // <-- truncated mid-line, no \n
      "utf8",
    );
    // Append a normal entry and verify it lands on a fresh line.
    appendDecision(wiki, sample);
    const after = readFileSync(path, "utf8");
    // Must NOT contain the concatenation `confidence_band:- op_id:`
    assert.ok(
      !after.includes("confidence_band:- op_id:"),
      `appended entry must not concatenate onto the truncated line; got tail ${JSON.stringify(
        after.slice(-200),
      )}`,
    );
    // Sanity: the new entry shows up on its own line.
    assert.match(after, /\n- op_id: rebuild-20260415-120000-abc\n/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision + readDecisions: round-trip single entry", () => {
  const wiki = tmpWiki("round-trip");
  try {
    appendDecision(wiki, sample);
    const back = readDecisions(wiki);
    assert.equal(back.length, 1);
    assert.equal(back[0].op_id, sample.op_id);
    assert.equal(back[0].operator, "MERGE");
    assert.deepEqual(back[0].sources, ["entry-a", "entry-b"]);
    assert.equal(back[0].tier_used, 0);
    assert.equal(back[0].similarity, 0.92);
    assert.equal(back[0].confidence_band, "decisive-same");
    assert.equal(back[0].decision, "same");
    assert.equal(back[0].reason, "high covers overlap");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision: multiple entries preserve order", () => {
  const wiki = tmpWiki("order");
  try {
    appendDecision(wiki, { ...sample, op_id: "op-1" });
    appendDecision(wiki, { ...sample, op_id: "op-2", operator: "NEST" });
    appendDecision(wiki, { ...sample, op_id: "op-3", operator: "LIFT" });
    const back = readDecisions(wiki);
    assert.deepEqual(
      back.map((e) => [e.op_id, e.operator]),
      [
        ["op-1", "MERGE"],
        ["op-2", "NEST"],
        ["op-3", "LIFT"],
      ],
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision: rejects missing required fields", () => {
  const wiki = tmpWiki("missing");
  try {
    assert.throws(() => appendDecision(wiki, { op_id: "x" }), /missing required field/);
    assert.throws(
      () =>
        appendDecision(wiki, {
          op_id: "x",
          operator: "MERGE",
          sources: ["a"],
          tier_used: 0,
          similarity: 0.5,
          // missing decision
        }),
      /missing required field "decision"/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision: rejects non-array sources", () => {
  const wiki = tmpWiki("bad-sources");
  try {
    assert.throws(
      () =>
        appendDecision(wiki, {
          ...sample,
          sources: "entry-a",
        }),
      /sources must be an array/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision: rejects NaN similarity", () => {
  const wiki = tmpWiki("nan");
  try {
    assert.throws(
      () => appendDecision(wiki, { ...sample, similarity: NaN }),
      /similarity must be a finite number/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendDecision: rejects non-integer tier_used", () => {
  const wiki = tmpWiki("tier");
  try {
    assert.throws(
      () => appendDecision(wiki, { ...sample, tier_used: 1.5 }),
      /tier_used must be an integer/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("hazardous string values round-trip (quotes, newlines, colons)", () => {
  const wiki = tmpWiki("hazard");
  try {
    appendDecision(wiki, {
      ...sample,
      op_id: "op-hazard",
      operator: "MERGE",
      sources: ["path: with colons", 'quote"inside'],
      reason: "multi\nline reason with \"quotes\"",
    });
    const back = readDecisions(wiki);
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].sources, ["path: with colons", 'quote"inside']);
    assert.equal(back[0].reason, 'multi\nline reason with "quotes"');
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("fractional similarity values round-trip", () => {
  const wiki = tmpWiki("fractional");
  try {
    appendDecision(wiki, { ...sample, similarity: 0.4567891234 });
    const back = readDecisions(wiki);
    assert.ok(Math.abs(back[0].similarity - 0.4567891234) < 1e-9);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("readDecisions: empty when file missing", () => {
  const wiki = tmpWiki("empty");
  try {
    const back = readDecisions(wiki);
    assert.deepEqual(back, []);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("validator rejects Infinity similarity", () => {
  const wiki = tmpWiki("infinity");
  try {
    assert.throws(
      () =>
        appendDecision(wiki, { ...sample, similarity: Infinity }),
      /similarity must be a finite number/,
    );
    assert.throws(
      () =>
        appendDecision(wiki, { ...sample, similarity: -Infinity }),
      /similarity must be a finite number/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser handles scientific-notation similarity (1e-10) round-trip", () => {
  const wiki = tmpWiki("scinot");
  try {
    appendDecision(wiki, { ...sample, similarity: 1e-10 });
    const back = readDecisions(wiki);
    assert.equal(back.length, 1);
    assert.equal(typeof back[0].similarity, "number");
    assert.ok(Math.abs(back[0].similarity - 1e-10) < 1e-20);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser handles negative fractional similarity round-trip", () => {
  const wiki = tmpWiki("neg");
  try {
    // Negative cosine would never occur with non-negative TF-IDF,
    // but the audit log must not silently mistype the value.
    appendDecision(wiki, { ...sample, similarity: -0.5 });
    const back = readDecisions(wiki);
    assert.equal(typeof back[0].similarity, "number");
    assert.equal(back[0].similarity, -0.5);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendMetricTrajectory: writes one entry per trajectory point", () => {
  const wiki = tmpWiki("trajectory");
  try {
    appendMetricTrajectory(wiki, "rebuild-1", [
      { iteration: 0, cost: 1.23, event: "baseline" },
      { iteration: 1, cost: 0.98, event: "NEST" },
      { iteration: 2, cost: 0.85, event: "NEST" },
    ]);
    const back = readDecisions(wiki);
    const traj = back.filter((e) => e.operator === "METRIC_TRAJECTORY");
    assert.equal(traj.length, 3);
    assert.equal(traj[0].op_id, "rebuild-1");
    assert.ok(Math.abs(traj[0].similarity - 1.23) < 1e-9);
    assert.equal(traj[0].confidence_band, "baseline");
    assert.equal(traj[1].confidence_band, "NEST");
    assert.ok(Math.abs(traj[2].similarity - 0.85) < 1e-9);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendMetricTrajectory: single-point baseline writes one entry", () => {
  const wiki = tmpWiki("traj-single");
  try {
    appendMetricTrajectory(wiki, "rebuild-1", [
      { iteration: 0, cost: 0.5, event: "baseline" },
    ]);
    const back = readDecisions(wiki);
    assert.equal(back.length, 1);
    assert.equal(back[0].operator, "METRIC_TRAJECTORY");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendNestDecision: records applied NEST with sources + band", () => {
  const wiki = tmpWiki("nest-dec");
  try {
    appendNestDecision(wiki, {
      op_id: "build-xyz",
      sources: ["leaf-a", "leaf-b", "leaf-c"],
      similarity: 0.72,
      confidence_band: "tier2-proposed",
      decision: "applied",
      reason: "slug=alpha",
    });
    const back = readDecisions(wiki);
    assert.equal(back.length, 1);
    assert.equal(back[0].operator, "NEST");
    assert.equal(back[0].tier_used, 2);
    assert.equal(back[0].confidence_band, "tier2-proposed");
    assert.equal(back[0].decision, "applied");
    assert.deepEqual(back[0].sources, ["leaf-a", "leaf-b", "leaf-c"]);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendNestDecision: records rejected-by-metric with regression reason", () => {
  const wiki = tmpWiki("nest-rej");
  try {
    appendNestDecision(wiki, {
      op_id: "rebuild-abc",
      sources: ["leaf-a", "leaf-b"],
      similarity: 0.5,
      confidence_band: "math-gated",
      decision: "rejected-by-metric",
      reason: "metric 1.0 -> 1.2 regression",
    });
    const back = readDecisions(wiki);
    assert.equal(back[0].decision, "rejected-by-metric");
    assert.equal(back[0].confidence_band, "math-gated");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("parser handles integer-valued similarity (0 and 1) round-trip", () => {
  const wiki = tmpWiki("int-sim");
  try {
    appendDecision(wiki, { ...sample, similarity: 0, op_id: "op-zero" });
    appendDecision(wiki, { ...sample, similarity: 1, op_id: "op-one" });
    const back = readDecisions(wiki);
    assert.equal(back[0].similarity, 0);
    assert.equal(back[1].similarity, 1);
    assert.equal(typeof back[0].similarity, "number");
    assert.equal(typeof back[1].similarity, "number");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
