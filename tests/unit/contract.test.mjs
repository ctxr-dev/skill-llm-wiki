// contract.test.mjs — the machine-readable format + CLI surface
// contract consumers gate on. Asserts the constants stay in sync
// with SKILL.md frontmatter and that the shape has the fields
// documented in guide/consumers/recipes/format-gate.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  FORMAT_VERSION,
  MIN_CONSUMER_FORMAT_VERSION,
  getContract,
  renderContractText,
} from "../../scripts/lib/contract.mjs";

const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");
const SKILL_MD_PATH = join(SKILL_ROOT, "SKILL.md");

test("FORMAT_VERSION is a positive integer", () => {
  assert.equal(typeof FORMAT_VERSION, "number");
  assert.ok(Number.isInteger(FORMAT_VERSION));
  assert.ok(FORMAT_VERSION >= 1);
});

test("MIN_CONSUMER_FORMAT_VERSION is at or below FORMAT_VERSION", () => {
  assert.ok(Number.isInteger(MIN_CONSUMER_FORMAT_VERSION));
  assert.ok(MIN_CONSUMER_FORMAT_VERSION >= 1);
  assert.ok(MIN_CONSUMER_FORMAT_VERSION <= FORMAT_VERSION);
});

test("SKILL.md frontmatter format_version matches the constant", () => {
  const raw = readFileSync(SKILL_MD_PATH, "utf8");
  // Tolerate CRLF — on Windows runners git checks the repo out with
  // native line endings by default, so the regex has to accept both.
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  assert.ok(match, "SKILL.md must have a frontmatter block");
  const block = match[1];
  const fmLine = block
    .split(/\r?\n/)
    .find((line) => /^format_version:/.test(line));
  assert.ok(
    fmLine,
    "SKILL.md frontmatter must declare format_version so consumers can gate on it",
  );
  const declared = Number(fmLine.split(":")[1].trim());
  assert.equal(
    declared,
    FORMAT_VERSION,
    `SKILL.md frontmatter format_version (${declared}) must match scripts/lib/contract.mjs FORMAT_VERSION (${FORMAT_VERSION}).`,
  );
});

test("getContract() returns the expected top-level keys", () => {
  const c = getContract();
  const expected = [
    "schema",
    "format_version",
    "min_consumer_format_version",
    "package_version",
    "frontmatter_schema",
    "layout_tokens",
    "subcommands",
    "envelope_schema",
    "exit_codes",
  ];
  for (const key of expected) {
    assert.ok(key in c, `contract missing key: ${key}`);
  }
  assert.equal(c.format_version, FORMAT_VERSION);
  assert.equal(c.min_consumer_format_version, MIN_CONSUMER_FORMAT_VERSION);
  assert.equal(c.schema, "skill-llm-wiki/contract/v1");
});

test("contract declares every top-level operation consumers use", () => {
  const c = getContract();
  for (const op of ["build", "extend", "validate", "rebuild", "fix", "join"]) {
    assert.ok(op in c.subcommands, `contract.subcommands missing ${op}`);
  }
  for (const op of ["init", "heal", "where", "contract"]) {
    assert.ok(op in c.subcommands, `contract.subcommands missing new op ${op}`);
  }
});

test("layout_tokens include the date tokens consumers template on", () => {
  const c = getContract();
  const tokens = c.layout_tokens.map((t) => t.token);
  for (const t of ["{yyyy}", "{mm}", "{dd}"]) {
    assert.ok(tokens.includes(t), `layout_tokens missing ${t}`);
  }
});

test("frontmatter_schema declares leaf required fields", () => {
  const c = getContract();
  const leaf = c.frontmatter_schema.leaf;
  for (const f of ["id", "type", "depth_role", "focus", "parents", "source"]) {
    assert.ok(leaf.required.includes(f), `leaf.required missing ${f}`);
  }
});

test("renderContractText produces human-readable output", () => {
  const c = getContract();
  const text = renderContractText(c);
  assert.ok(text.includes("skill-llm-wiki contract"));
  assert.ok(text.includes(`format_version: ${FORMAT_VERSION}`));
  assert.ok(text.includes("subcommands:"));
});

test("`contract --json` CLI prints a parseable envelope", () => {
  const r = spawnSync(process.execPath, [CLI_PATH, "contract", "--json"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `cli exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, "skill-llm-wiki/contract/v1");
  assert.equal(parsed.format_version, FORMAT_VERSION);
});

test("`contract` CLI without --json prints human text", () => {
  const r = spawnSync(process.execPath, [CLI_PATH, "contract"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `cli exited ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.startsWith("skill-llm-wiki contract"));
  assert.ok(r.stdout.includes(`format_version: ${FORMAT_VERSION}`));
});

// ─── Drift guard: every flag listed in SUBCOMMANDS must actually be
// accepted by the CLI (and vice versa for consumer-facing flags) ──

test("every flag in SUBCOMMANDS is accepted by the CLI's shared parser", () => {
  const c = getContract();
  const cliSource = readFileSync(CLI_PATH, "utf8");

  // Extract FLAG_WITH_VALUE and FLAG_BOOLEAN from cli.mjs so the test
  // observes the same flag universe the parser does. These are
  // hand-maintained Sets near the top of cli.mjs.
  const valueFlags = extractFlagSet(cliSource, "FLAG_WITH_VALUE");
  const booleanFlags = extractFlagSet(cliSource, "FLAG_BOOLEAN");
  const knownFlags = new Set([...valueFlags, ...booleanFlags]);

  // Some flags are parsed ad-hoc by individual subcommand handlers
  // (init, heal, testkit-stub) rather than the shared parser. List
  // those here so the drift test doesn't false-positive.
  const handlerParsed = new Set([
    "--kind",
    "--template",
    "--force",
    "--dry-run",
    "--at",
    "--layout",
    "--json", // handled by hasJsonFlag across all subcommands
  ]);

  for (const [cmd, spec] of Object.entries(c.subcommands)) {
    for (const flag of spec.flags) {
      if (handlerParsed.has(flag)) continue;
      assert.ok(
        knownFlags.has(flag),
        `contract.subcommands.${cmd} lists ${flag} but it is not in FLAG_WITH_VALUE / FLAG_BOOLEAN`,
      );
    }
  }
});

function extractFlagSet(source, name) {
  // Matches `const FLAG_WITH_VALUE = new Set([ ... ]);`
  const re = new RegExp(
    `const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`,
    "m",
  );
  const m = re.exec(source);
  if (!m) throw new Error(`could not locate ${name} in cli.mjs`);
  const flags = [];
  for (const raw of m[1].split(/,|\n/)) {
    const s = raw.trim().replace(/^"|"$/g, "");
    if (s.startsWith("--")) flags.push(s);
  }
  return new Set(flags);
}

test("contract covers every top-level consumer-facing subcommand", () => {
  const c = getContract();
  // These are the canonical top-level ops + consumer probes. If any
  // is missing from the contract, consumers gating on
  // `c.subcommands[cmd]` will crash.
  const required = [
    "build",
    "extend",
    "validate",
    "rebuild",
    "fix",
    "join",
    "rollback",
    "init",
    "heal",
    "where",
    "contract",
    "testkit-stub",
  ];
  for (const cmd of required) {
    assert.ok(cmd in c.subcommands, `contract missing subcommand: ${cmd}`);
  }
});
