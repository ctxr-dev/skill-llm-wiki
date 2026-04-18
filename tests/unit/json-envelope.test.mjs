// json-envelope.test.mjs — shared JSON stdout shape for
// consumer-facing subcommands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { SKILL_ROOT } from "../../scripts/lib/where.mjs";
import { makeWikiFixture } from "../../scripts/testkit/make-wiki-fixture.mjs";
import { mktmp } from "../helpers/tmp.mjs";
import {
  ENVELOPE_SCHEMA,
  VERDICTS,
  SEVERITIES,
  makeEnvelope,
  makeErrorEnvelope,
  findingToDiagnostic,
  hasJsonFlag,
} from "../../scripts/lib/json-envelope.mjs";

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

test("makeEnvelope accepts a structured `next` field", () => {
  const e = makeEnvelope({
    command: "init",
    verdict: "initialised",
    exit: 0,
    next: { command: "skill-llm-wiki", args: ["build", "/tmp/x", "--json"] },
  });
  assert.deepEqual(e.next, {
    command: "skill-llm-wiki",
    args: ["build", "/tmp/x", "--json"],
  });
});

test("makeEnvelope omits `next` when null", () => {
  const e = makeEnvelope({ command: "validate", verdict: "ok", exit: 0 });
  assert.equal("next" in e, false);
});

test("makeEnvelope rejects malformed `next`", () => {
  assert.throws(
    () =>
      makeEnvelope({
        command: "init",
        verdict: "initialised",
        exit: 0,
        next: { command: "x" }, // missing args
      }),
    /next must be/,
  );
});

test("makeErrorEnvelope builds a canonical error shape", () => {
  const e = makeErrorEnvelope({
    command: "init",
    code: "INIT-07",
    message: "contract exists",
    target: "/abs/topic",
    exit: 2,
  });
  assert.equal(e.schema, ENVELOPE_SCHEMA);
  assert.equal(e.command, "init");
  assert.equal(e.verdict, "ambiguous");
  assert.equal(e.exit, 2);
  assert.equal(e.diagnostics.length, 1);
  assert.equal(e.diagnostics[0].code, "INIT-07");
  assert.equal(e.diagnostics[0].severity, "error");
});

test("makeErrorEnvelope rejects missing code", () => {
  assert.throws(
    () => makeErrorEnvelope({ command: "init", message: "x" }),
    /code is required/,
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

test("hasJsonFlag detects bare --json and --json-errors only", () => {
  assert.equal(hasJsonFlag(["--json"]), true);
  assert.equal(hasJsonFlag(["--json-errors"]), true);
  // Inline-value forms are NOT accepted. parseSubArgv rejects
  // `--json=1` on boolean flags; hasJsonFlag must mirror that or
  // the two code paths disagree on the same token.
  assert.equal(hasJsonFlag(["--json=1"]), false);
  assert.equal(hasJsonFlag(["--json=true"]), false);
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
//
// Use the shipped testkit helper to seed a wiki that isWikiRoot +
// validateWiki actually accept: root index.md with the generator
// marker, id matching the directory basename, depth_role: category,
// and a layout.yaml contract. Without this the test exercises the
// WIKI-01 early-return path, not the happy envelope path.

test("validate --json emits a parseable envelope with correct schema", async () => {
  const wiki = join(mktmp("envelope-validate"), "wiki");
  try {
    await makeWikiFixture({ path: wiki, kind: "dated" });
    const r = spawnSync(process.execPath, [CLI_PATH, "validate", wiki, "--json"], {
      encoding: "utf8",
    });
    // The fixture isn't built through the full orchestrator, so
    // validate may still find issues (LOSS-01 / GIT-01 are common
    // on a fixture with no private-git history). The important
    // thing is that we reach the envelope-emission path, not the
    // WIKI-01 early-return path.
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
    // Crucial: we did NOT take the isWikiRoot=false branch. That
    // branch surfaces WIKI-01. If we got WIKI-01 here, the fixture
    // isn't being recognised as a wiki root.
    const wikiOne = env.diagnostics.find((d) => d.code === "WIKI-01");
    assert.equal(wikiOne, undefined, `unexpected WIKI-01: ${JSON.stringify(wikiOne)}`);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("validate --json emits a JSON envelope on usage errors", () => {
  // --json must affect both success and error paths. Previously
  // validate's usageError emitted plain stderr text even when
  // --json was present, breaking consumer stdout parsers.
  const r = spawnSync(
    process.execPath,
    [CLI_PATH, "validate", "--json", "--not-a-flag"],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  const env = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(env.schema, "skill-llm-wiki/v1");
  assert.equal(env.command, "validate");
  assert.equal(env.verdict, "ambiguous");
  assert.equal(env.diagnostics[0].code, "VALIDATE-USAGE");
});

test("heal --json emits a JSON envelope on missing positional", () => {
  const r = spawnSync(
    process.execPath,
    [CLI_PATH, "heal", "--json"],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  const env = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(env.schema, "skill-llm-wiki/v1");
  assert.equal(env.command, "heal");
  assert.equal(env.verdict, "ambiguous");
  assert.equal(env.diagnostics[0].code, "HEAL-USAGE");
});

test("validate --json-errors is treated as an alias for --json", async () => {
  const wiki = join(mktmp("envelope-validate-alias"), "wiki");
  try {
    await makeWikiFixture({ path: wiki, kind: "dated" });
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
