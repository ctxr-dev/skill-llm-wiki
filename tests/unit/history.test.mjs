// history.test.mjs — op-log append/read round-trip.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendOpLog,
  findOpByRef,
  readOpLog,
} from "../../scripts/lib/history.mjs";

function tmpWiki() {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

const sample = {
  op_id: "build-20260414-001",
  operation: "build",
  layout_mode: "sibling",
  started: "2026-04-14T10:00:00Z",
  finished: "2026-04-14T10:02:17Z",
  base_commit: "abc123",
  final_commit: "def456",
  summary: "Initial build of /tmp/fluffy-docs",
};

test("appendOpLog + readOpLog round-trip single entry", () => {
  const wiki = tmpWiki();
  try {
    appendOpLog(wiki, sample);
    const back = readOpLog(wiki);
    assert.equal(back.length, 1);
    assert.deepEqual(back[0], sample);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendOpLog preserves ordering for multiple entries", () => {
  const wiki = tmpWiki();
  try {
    appendOpLog(wiki, sample);
    appendOpLog(wiki, { ...sample, op_id: "rebuild-20260414-002", operation: "rebuild" });
    appendOpLog(wiki, { ...sample, op_id: "fix-20260414-003", operation: "fix" });
    const back = readOpLog(wiki);
    assert.deepEqual(
      back.map((e) => e.op_id),
      ["build-20260414-001", "rebuild-20260414-002", "fix-20260414-003"],
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("findOpByRef resolves op-id and pre-<op-id> forms", () => {
  const wiki = tmpWiki();
  try {
    appendOpLog(wiki, sample);
    assert.equal(findOpByRef(wiki, "build-20260414-001").op_id, sample.op_id);
    assert.equal(
      findOpByRef(wiki, "pre-build-20260414-001").op_id,
      sample.op_id,
    );
    assert.equal(findOpByRef(wiki, "does-not-exist"), null);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendOpLog rejects entries missing required fields", () => {
  const wiki = tmpWiki();
  try {
    assert.throws(
      () => appendOpLog(wiki, { op_id: "x" }),
      /missing required field/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("hazardous string values round-trip through emit/parse", () => {
  // Covers the number-ish / boolean-ish / null-ish quoting rule. Every
  // one of these values is a legitimate string in the skill's world and
  // MUST come back as the same string, not coerced to a primitive.
  const wiki = tmpWiki();
  try {
    const hazardous = {
      ...sample,
      op_id: "hazardous-strings-001",
      base_commit: "007",          // looks numeric
      final_commit: "true",         // looks boolean
      summary: "null",              // looks null
    };
    appendOpLog(wiki, hazardous);
    const back = readOpLog(wiki);
    assert.equal(back.length, 1);
    assert.strictEqual(back[0].base_commit, "007");
    assert.strictEqual(back[0].final_commit, "true");
    assert.strictEqual(back[0].summary, "null");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("appendOpLog rejects nested-object extras with a clear error", () => {
  const wiki = tmpWiki();
  try {
    assert.throws(
      () => appendOpLog(wiki, { ...sample, nested: { k: "v" } }),
      /nested object extras not supported/,
    );
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

// Property test: randomly generate string values covering the YAML hazard
// surface (number-ish, bool-ish, null-ish, leading/trailing whitespace,
// reserved punctuation, unicode, empty) and prove every one round-trips
// through emitScalar → parseValue as an identical string. This is the
// safety net that stops future edits to `needsQuoting` or `parseValue`
// from silently corrupting a value with no dedicated test.
test("YAML codec: random hazardous strings round-trip as strings", () => {
  const wiki = tmpWiki();
  try {
    // Seeded PRNG so the test is deterministic across runs.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const hazardPool = [
      "",
      "007",
      "00",
      "-1",
      "42",
      "3.14",
      "true",
      "false",
      "null",
      "~",
      "yes",
      "no",
      "on",
      "off",
      ":colon-start",
      "trailing:",
      " leading-space",
      "trailing-space ",
      "a: b",
      "# comment",
      "- dash",
      "? question",
      "{curly}",
      "[square]",
      '"already quoted"',
      "'single'",
      "back\\slash",
      "tab\there",
      "multi\nline",
      "Ω unicode",
      "🦀 emoji",
      "&anchor",
      "*alias",
      "|pipe",
      ">fold",
    ];
    // Cover the full pool plus a handful of random combinations.
    const samples = [...hazardPool];
    for (let i = 0; i < 30; i++) {
      samples.push(pick(hazardPool) + pick(hazardPool));
    }
    // Feed each sample through the codec via appendOpLog/readOpLog.
    // Use the `summary` field as the carrier because it's a required string.
    for (let i = 0; i < samples.length; i++) {
      const wikiI = tmpWiki();
      try {
        const summary = samples[i];
        appendOpLog(wikiI, { ...sample, op_id: `prop-${i}`, summary });
        const back = readOpLog(wikiI);
        assert.strictEqual(
          back[0].summary,
          summary,
          `round-trip failed for sample #${i}: ${JSON.stringify(summary)}`,
        );
      } finally {
        rmSync(wikiI, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
