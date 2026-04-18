// init.test.mjs — seed a topic with a shipped layout contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { runInit, InitError, renderInitText } from "../../scripts/lib/init.mjs";
import { ENVELOPE_SCHEMA } from "../../scripts/lib/json-envelope.mjs";
import { SKILL_ROOT } from "../../scripts/lib/where.mjs";
import { mktmp } from "../helpers/tmp.mjs";

const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

test("runInit seeds a dated wiki via --kind dated default template", () => {
  const topic = join(mktmp("dated"), "reports");
  try {
    const r = runInit({ topic, kind: "dated" });
    assert.equal(r.template, "reports");
    assert.equal(r.kind, "dated");
    assert.ok(existsSync(r.contract_path));
    const body = readFileSync(r.contract_path, "utf8");
    assert.match(body, /mode:\s*hosted/);
    assert.match(body, /dynamic_subdirs:/);
    assert.match(body, /\{yyyy\}/);
    assert.deepEqual(
      r.build_command.slice(0, 2),
      ["skill-llm-wiki", "build"],
    );
    // Structured `next` mirrors build_command.
    assert.equal(r.next.command, "skill-llm-wiki");
    assert.deepEqual(r.next.args, r.build_command.slice(1));
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("renderInitText produces the human-readable summary", () => {
  const topic = join(mktmp("render"), "reports");
  try {
    const r = runInit({ topic, kind: "dated" });
    const text = renderInitText(r);
    assert.match(text, /init: seeded/);
    assert.match(text, /template: reports/);
    assert.match(text, /next: skill-llm-wiki build/);
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit seeds a subject wiki via --kind subject default template", () => {
  const topic = join(mktmp("subject"), "runbooks");
  try {
    const r = runInit({ topic, kind: "subject" });
    assert.equal(r.template, "runbooks");
    assert.equal(r.kind, "subject");
    const body = readFileSync(r.contract_path, "utf8");
    assert.doesNotMatch(body, /dynamic_subdirs:/);
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit honours explicit --template over default", () => {
  const topic = join(mktmp("explicit"), "adrs");
  try {
    const r = runInit({ topic, template: "adrs" });
    assert.equal(r.template, "adrs");
    assert.equal(r.kind, "subject");
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit refuses mismatched --kind and --template", () => {
  const topic = join(mktmp("mismatch"), "wrong");
  try {
    assert.throws(
      () => runInit({ topic, kind: "dated", template: "runbooks" }),
      (err) => err instanceof InitError && err.code === "INIT-05",
    );
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit creates the topic directory if it does not exist", () => {
  const root = mktmp("mkdir");
  const topic = join(root, "nested", "deep", "topic");
  try {
    runInit({ topic, kind: "dated" });
    assert.ok(existsSync(topic));
    assert.ok(existsSync(join(topic, ".llmwiki.layout.yaml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runInit refuses when topic exists as a file", () => {
  const root = mktmp("file-collision");
  const topic = join(root, "filenotdir");
  writeFileSync(topic, "i am a file");
  try {
    assert.throws(
      () => runInit({ topic, kind: "dated" }),
      (err) => err instanceof InitError && err.code === "INIT-06",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runInit refuses to overwrite existing contract without --force", () => {
  const topic = join(mktmp("exists"), "already-inited");
  try {
    runInit({ topic, kind: "dated" });
    assert.throws(
      () => runInit({ topic, kind: "dated" }),
      (err) => err instanceof InitError && err.code === "INIT-07",
    );
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit overwrites existing contract under --force", () => {
  const topic = join(mktmp("force"), "force-inited");
  try {
    runInit({ topic, kind: "dated", template: "reports" });
    const r = runInit({
      topic,
      kind: "subject",
      template: "runbooks",
      force: true,
    });
    assert.equal(r.overwrote, true);
    const body = readFileSync(r.contract_path, "utf8");
    assert.match(body, /runbooks/);
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit rejects unknown --kind", () => {
  const topic = join(mktmp("bad-kind"), "x");
  try {
    assert.throws(
      () => runInit({ topic, kind: "weekly" }),
      (err) => err instanceof InitError && err.code === "INIT-03",
    );
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("runInit refuses to write through a symlink at the topic path", () => {
  const root = mktmp("symlink-topic");
  const realTarget = join(root, "real-target");
  const topic = join(root, "symlinked-topic");
  mkdirSync(realTarget, { recursive: true });
  try {
    symlinkSync(realTarget, topic, "dir");
    assert.throws(
      () => runInit({ topic, kind: "dated" }),
      (err) => err instanceof InitError && err.code === "INIT-08",
    );
    // Confirm the target dir was NOT touched through the symlink.
    assert.equal(
      existsSync(join(realTarget, ".llmwiki.layout.yaml")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runInit refuses to write through a symlink at the contract path", () => {
  const root = mktmp("symlink-contract");
  const topic = join(root, "topic");
  const realTarget = join(root, "real-target.yaml");
  mkdirSync(topic, { recursive: true });
  writeFileSync(realTarget, "some content\n");
  const contractLink = join(topic, ".llmwiki.layout.yaml");
  try {
    symlinkSync(realTarget, contractLink, "file");
    assert.throws(
      () => runInit({ topic, kind: "dated", force: true }),
      (err) => err instanceof InitError && err.code === "INIT-08",
    );
    // Confirm the real target was NOT overwritten.
    assert.equal(readFileSync(realTarget, "utf8"), "some content\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runInit rejects unknown --template", () => {
  const topic = join(mktmp("bad-tmpl"), "x");
  try {
    assert.throws(
      () => runInit({ topic, template: "nope" }),
      (err) => err instanceof InitError && err.code === "INIT-04",
    );
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

// ─── CLI end-to-end ─────────────────────────────────────────

test("`init <topic> --kind dated --json` emits the initialised envelope", () => {
  const topic = join(mktmp("cli-e2e"), "reports");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "init", topic, "--kind", "dated", "--json"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `init exited ${r.status}: ${r.stderr}`);
    const env = JSON.parse(r.stdout);
    assert.equal(env.schema, ENVELOPE_SCHEMA);
    assert.equal(env.command, "init");
    assert.equal(env.verdict, "initialised");
    assert.equal(env.exit, 0);
    assert.equal(env.target, topic);
    assert.equal(env.artifacts.created.length, 1);
    assert.ok(env.artifacts.created[0].endsWith(".llmwiki.layout.yaml"));
    const hint = env.diagnostics.find((d) => d.code === "NEXT-01");
    assert.ok(hint);
    assert.match(hint.message, /skill-llm-wiki build/);
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("`init` without --kind or --template fails with INIT-02 (exit 2)", () => {
  const topic = join(mktmp("no-flags"), "x");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "init", topic, "--json"],
      { encoding: "utf8" },
    );
    // INIT-02 is a validation condition (user asked for init but
    // didn't narrow to a template), so exit is 2 — matches the
    // skill-wide exit code scheme (2 = validation/ambiguity).
    assert.equal(r.status, 2);
    const env = JSON.parse(r.stdout);
    assert.equal(env.verdict, "ambiguous");
    assert.equal(env.exit, 2);
    assert.equal(env.diagnostics[0].code, "INIT-02");
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("`init` with unknown flag fails with INIT-00 (exit 1)", () => {
  const topic = join(mktmp("bad-flag"), "x");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "init", topic, "--not-a-flag", "--json"],
      { encoding: "utf8" },
    );
    // INIT-00 is a CLI usage error (unknown flag) → exit 1.
    assert.equal(r.status, 1);
    const env = JSON.parse(r.stdout);
    assert.equal(env.exit, 1);
    assert.equal(env.diagnostics[0].code, "INIT-00");
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});

test("`init` without --json prints a human-readable summary", () => {
  const topic = join(mktmp("cli-text"), "runbooks");
  try {
    const r = spawnSync(
      process.execPath,
      [CLI_PATH, "init", topic, "--kind", "subject"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, `init exited ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /init: seeded/);
    assert.match(r.stdout, /template: runbooks/);
    assert.match(r.stdout, /next: skill-llm-wiki build/);
  } finally {
    rmSync(dirname(topic), { recursive: true, force: true });
  }
});
