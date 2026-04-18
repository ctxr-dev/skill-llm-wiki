// json-envelope.test.mjs — shared JSON stdout shape for
// consumer-facing subcommands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  ENVELOPE_SCHEMA,
  VERDICTS,
  SEVERITIES,
  makeEnvelope,
  findingToDiagnostic,
  hasJsonFlag,
} from "../../scripts/lib/json-envelope.mjs";

const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

test("ENVELOPE_SCHEMA is stable", () => {
  assert.equal(ENVELOPE_SCHEMA, "skill-llm-wiki/v1");
});

test("VERDICTS includes the operational verdicts", () => {
  for (const v of ["ok", "fixable", "needs-rebuild", "broken", "healed", "initialised"]) {
    assert.ok(VERDICTS.includes(v), `VERDICTS missing ${v}`);
  }
});

test("SEVERITIES matches consumer CI gates", () => {
  for (const s of ["error", "warning", "info"]) {
    assert.ok(SEVERITIES.includes(s), `SEVERITIES missing ${s}`);
  }
});

test("makeEnvelope fills defaults for optional fields", () => {
  const e = makeEnvelope({ command: "validate", verdict: "ok", exit: 0 });
  assert.equal(e.schema, ENVELOPE_SCHEMA);
  assert.equal(e.command, "validate");
  assert.equal(e.target, null);
  assert.equal(e.verdict, "ok");
  assert.equal(e.exit, 0);
  assert.deepEqual(e.diagnostics, []);
  assert.deepEqual(e.artifacts, { created: [], modified: [], deleted: [] });
  assert.equal(e.timing_ms, 0);
});

test("makeEnvelope rejects unknown verdicts", () => {
  assert.throws(
    () => makeEnvelope({ command: "validate", verdict: "wat", exit: 0 }),
    /unknown verdict/,
  );
});

test("makeEnvelope rejects missing required fields", () => {
  assert.throws(() => makeEnvelope({ verdict: "ok", exit: 0 }), /command/);
  assert.throws(() => makeEnvelope({ command: "x", exit: 0 }), /verdict/);
  assert.throws(
    () => makeEnvelope({ command: "x", verdict: "ok" }),
    /exit must be an integer/,
  );
});

test("makeEnvelope preserves provided artifacts", () => {
  const e = makeEnvelope({
    command: "build",
    verdict: "built",
    exit: 0,
    artifacts: { created: ["a"], modified: ["b"], deleted: ["c"] },
  });
  assert.deepEqual(e.artifacts, { created: ["a"], modified: ["b"], deleted: ["c"] });
});

test("hasJsonFlag detects --json, --json-errors, and --json=1", () => {
  assert.equal(hasJsonFlag(["--json"]), true);
  assert.equal(hasJsonFlag(["--json-errors"]), true);
  assert.equal(hasJsonFlag(["--json=1"]), true);
  assert.equal(hasJsonFlag(["--json=true"]), true);
  assert.equal(hasJsonFlag(["--json=yes"]), true);
  assert.equal(hasJsonFlag(["--json=0"]), false);
  assert.equal(hasJsonFlag(["--json=false"]), false);
  assert.equal(hasJsonFlag([]), false);
  assert.equal(hasJsonFlag(["--other", "value"]), false);
  assert.equal(hasJsonFlag(null), false);
});

test("findingToDiagnostic maps validate findings to diagnostic shape", () => {
  const d = findingToDiagnostic({
    code: "IDX-01",
    severity: "warning",
    target: "a/b.md",
    message: "stale index",
  });
  assert.deepEqual(d, {
    code: "IDX-01",
    severity: "warning",
    path: "a/b.md",
    message: "stale index",
  });
});

test("findingToDiagnostic fills gaps with defaults", () => {
  const d = findingToDiagnostic({});
  assert.equal(d.code, "UNKNOWN");
  assert.equal(d.severity, "info");
  assert.equal(d.path, null);
  assert.equal(d.message, "");
});

// ─── End-to-end: validate --json emits the envelope ────────────

function makeMinimalWiki(dir) {
  mkdirSync(dir, { recursive: true });
  // Empty wiki — validate should run without errors and return exit 0.
  // We don't care about the detailed findings here, only the envelope shape.
  writeFileSync(
    join(dir, "index.md"),
    `---
id: index
type: index
depth_role: root
focus: "test wiki"
covers: []
parents: []
tags: []
---

# test wiki
`,
    "utf8",
  );
  // Private git metadata expected by some validation paths.
  mkdirSync(join(dir, ".llmwiki"), { recursive: true });
}

test("validate --json emits a parseable envelope with correct schema", () => {
  const wiki = join(tmpdir(), `envelope-validate-${process.pid}-${Date.now()}`);
  try {
    makeMinimalWiki(wiki);
    const r = spawnSync(process.execPath, [CLI_PATH, "validate", wiki, "--json"], {
      encoding: "utf8",
    });
    // validate may exit 0 or 2 depending on whether the minimal
    // wiki passes all invariants; either is fine for this test.
    // We only care about the envelope shape on stdout.
    const lines = r.stdout.trim().split("\n");
    const last = lines[lines.length - 1];
    const env = JSON.parse(last);
    assert.equal(env.schema, ENVELOPE_SCHEMA);
    assert.equal(env.command, "validate");
    assert.equal(env.target, wiki);
    assert.ok(VERDICTS.includes(env.verdict), `bad verdict: ${env.verdict}`);
    assert.ok(Number.isInteger(env.exit));
    assert.ok(Array.isArray(env.diagnostics));
    assert.ok(Number.isInteger(env.timing_ms));
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("validate --json-errors is treated as an alias for --json", () => {
  const wiki = join(
    tmpdir(),
    `envelope-validate-alias-${process.pid}-${Date.now()}`,
  );
  try {
    makeMinimalWiki(wiki);
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "validate", wiki, "--json-errors"],
      { encoding: "utf8" },
    );
    const lines = r.stdout.trim().split("\n");
    const last = lines[lines.length - 1];
    const env = JSON.parse(last);
    assert.equal(env.schema, ENVELOPE_SCHEMA);
    assert.equal(env.command, "validate");
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
