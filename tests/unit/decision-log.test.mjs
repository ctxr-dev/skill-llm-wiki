// decision-log.test.mjs — tiered-AI audit log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendDecision,
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
