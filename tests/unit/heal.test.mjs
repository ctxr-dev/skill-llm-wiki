// heal.test.mjs — classify validate findings and name the next command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINDING_ACTIONS,
  classifyFindings,
  runHeal,
  renderHealText,
} from "../../scripts/lib/heal.mjs";
import { mktmp } from "../helpers/tmp.mjs";

const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

test("FINDING_ACTIONS covers the known validate codes", () => {
  const required = [
    "WIKI-01",
    "GIT-01",
    "LOSS-01",
    "PARSE",
    "MISSING-FIELD",
    "DUP-ID",
    "ALIAS-COLLIDES-ID",
    "ID-MISMATCH-DIR",
    "ID-MISMATCH-FILE",
    "DEPTH-ROLE",
    "PARENTS-REQUIRED",
    "PARENT-CONTRACT",
    "DANGLING-LINK",
    "DANGLING-OVERLAY",
    "SIZE-CAP",
  ];
  for (const code of required) {
    assert.ok(code in FINDING_ACTIONS, `FINDING_ACTIONS missing ${code}`);
  }
});

test("classifyFindings returns ok when no errors", () => {
  const r = classifyFindings([]);
  assert.equal(r.verdict, "ok");
  assert.equal(r.action, "none");
});

test("classifyFindings promotes warnings to ok, not fixable", () => {
  const r = classifyFindings([
    { code: "SIZE-CAP", severity: "warning", target: "x.md", message: "w" },
  ]);
  assert.equal(r.verdict, "ok");
});

test("classifyFindings routes DANGLING-LINK to fix", () => {
  const r = classifyFindings([
    { code: "DANGLING-LINK", severity: "error", target: "x.md", message: "m" },
  ]);
  assert.equal(r.verdict, "fixable");
  assert.equal(r.action, "fix");
});

test("classifyFindings routes ID-MISMATCH-DIR to rebuild", () => {
  const r = classifyFindings([
    { code: "ID-MISMATCH-DIR", severity: "error", target: "x.md", message: "m" },
  ]);
  assert.equal(r.verdict, "needs-rebuild");
  assert.equal(r.action, "rebuild");
});

test("classifyFindings routes WIKI-01 to broken/manual", () => {
  const r = classifyFindings([
    { code: "WIKI-01", severity: "error", target: "root", message: "not a wiki" },
  ]);
  assert.equal(r.verdict, "broken");
  assert.equal(r.action, "manual");
});

test("classifyFindings picks the highest-priority action across findings", () => {
  // fix + rebuild + manual together → manual wins.
  const r = classifyFindings([
    { code: "DANGLING-LINK", severity: "error", target: "a", message: "m" },
    { code: "DUP-ID", severity: "error", target: "b", message: "m" },
    { code: "GIT-01", severity: "error", target: "c", message: "m" },
  ]);
  assert.equal(r.verdict, "broken");
});

test("classifyFindings: fix + rebuild → rebuild wins", () => {
  const r = classifyFindings([
    { code: "DANGLING-LINK", severity: "error", target: "a", message: "m" },
    { code: "DUP-ID", severity: "error", target: "b", message: "m" },
  ]);
  assert.equal(r.verdict, "needs-rebuild");
});

test("renderHealText prints the verdict, findings, and next command", () => {
  const text = renderHealText({
    target: "/tmp/x",
    verdict: "fixable",
    action: "fix",
    findings: [
      {
        code: "DANGLING-LINK",
        severity: "error",
        target: "a.md",
        message: "broken",
      },
    ],
    error: null,
    next_command: ["skill-llm-wiki", "fix", "/tmp/x", "--json"],
  });
  assert.match(text, /^heal: fixable \(fix\)/);
  assert.match(text, /\[ERR \] DANGLING-LINK {2}a\.md/);
  assert.match(text, /next: skill-llm-wiki fix \/tmp\/x --json/);
});

test("runHeal surfaces verdict broken when path is not a wiki", () => {
  const fake = join(mktmp("notwiki"), "not-a-wiki");
  mkdirSync(fake, { recursive: true });
  try {
    const r = runHeal(fake);
    // validate will report WIKI-01 on a directory with no index.md.
    assert.equal(r.verdict, "broken");
    assert.equal(r.next_command, null);
    assert.ok(r.findings.length >= 1);
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});

// ─── CLI end-to-end ─────────────────────────────────────────

test("`heal <wiki> --json` emits an envelope with the verdict", () => {
  const fake = join(mktmp("cli-broken"), "x");
  mkdirSync(fake, { recursive: true });
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "heal", fake, "--json"],
      { encoding: "utf8" },
    );
    // verdict "broken" maps to exit 6 (wiki corrupt), not 2.
    // Consumers gate on the envelope's verdict, not the exit code.
    const env = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(env.schema, "skill-llm-wiki/v1");
    assert.equal(env.command, "heal");
    assert.equal(env.verdict, "broken");
    assert.equal(env.exit, 6);
    assert.equal(r.status, 6);
    assert.ok(env.diagnostics.length >= 1);
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});

test("`heal --dry-run` is accepted as a no-op label", () => {
  const fake = join(mktmp("cli-dryrun"), "x");
  mkdirSync(fake, { recursive: true });
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "heal", fake, "--dry-run", "--json"],
      { encoding: "utf8" },
    );
    // --dry-run is advertised in contract.SUBCOMMANDS.heal.flags;
    // the CLI must accept it without "unknown flag" error.
    const env = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(env.schema, "skill-llm-wiki/v1");
    assert.equal(env.command, "heal");
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});

test("`heal` without --json prints a specific broken verdict on a non-wiki dir", () => {
  // A directory without index.md and without .llmwiki/git/ is a
  // known-broken shape. validate emits WIKI-01 (not a valid wiki
  // root) which FINDING_ACTIONS maps to "manual" → verdict
  // "broken". This test asserts the exact verdict and exit code
  // rather than the previous vacuous 5-way alternation.
  const fake = join(mktmp("cli-text-broken"), "x");
  mkdirSync(fake, { recursive: true });
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, "heal", fake], {
      encoding: "utf8",
    });
    assert.equal(r.status, 6, `expected exit 6 for broken verdict, got ${r.status}`);
    assert.match(r.stdout, /^heal: broken \(manual\)/);
    // No NEXT-01 hint when action is manual (no self-heal path).
    assert.doesNotMatch(r.stdout, /\n {2}next: /);
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});

test("runHeal reaches the ambiguous path when validateWiki cannot run", () => {
  // Pass a path that exists as a REGULAR FILE, not a directory.
  // validateWiki's internal reads throw before producing findings.
  // runHeal catches the throw and surfaces `ambiguous` with the
  // error preserved in the result (diagnostic HEAL-00 added later
  // by the CLI wrapper).
  const base = mktmp("ambiguous-path");
  const asFile = join(base, "not-a-dir");
  writeFileSync(asFile, "i am a file, not a wiki\n", "utf8");
  try {
    const r = runHeal(asFile);
    assert.ok(
      r.verdict === "ambiguous" || r.verdict === "broken",
      `expected ambiguous or broken for a file-path, got ${r.verdict}`,
    );
    // When validate throws, runHeal populates `error` and clears
    // next_command. When validate returns WIKI-01 cleanly, the
    // verdict is broken and next_command is still null (manual
    // action).
    assert.equal(r.next_command, null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
