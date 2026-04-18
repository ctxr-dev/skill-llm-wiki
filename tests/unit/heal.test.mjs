// heal.test.mjs — classify validate findings and name the next command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  FINDING_ACTIONS,
  classifyFindings,
  runHeal,
} from "../../scripts/lib/heal.mjs";

const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

function mktmp(tag) {
  const p = join(tmpdir(), `heal-${tag}-${process.pid}-${Date.now()}`);
  mkdirSync(p, { recursive: true });
  return p;
}

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
    // Exit 2 for broken; schema should still be valid.
    const env = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(env.schema, "skill-llm-wiki/v1");
    assert.equal(env.command, "heal");
    assert.equal(env.verdict, "broken");
    assert.equal(env.exit, 2);
    assert.ok(env.diagnostics.length >= 1);
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});

test("`heal` without --json prints a text summary with next command", () => {
  const fake = join(mktmp("cli-text"), "x");
  // Create a well-formed but empty-ish wiki body that will have a
  // non-broken-but-not-ok outcome. Minimal shape: index.md that
  // validate can parse but that fails a lesser check.
  mkdirSync(fake, { recursive: true });
  writeFileSync(
    join(fake, "index.md"),
    `---
id: xyz
type: index
depth_role: root
focus: "x"
---
`,
    "utf8",
  );
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, "heal", fake], {
      encoding: "utf8",
    });
    // Whatever the verdict, the text output should start with "heal:"
    assert.match(r.stdout, /^heal: (ok|fixable|needs-rebuild|broken|ambiguous)/);
  } finally {
    rmSync(dirname(fake), { recursive: true, force: true });
  }
});
