// where.test.mjs — consumer-facing "where am I installed?" helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  SKILL_ROOT,
  getWhere,
  renderWhereText,
} from "../../scripts/lib/where.mjs";
import { FORMAT_VERSION } from "../../scripts/lib/contract.mjs";

// SKILL_ROOT is re-exported from the module under test — the single
// source of truth for the skill install path. Importing it here
// (rather than re-deriving via dirname^3 + fileURLToPath) means a
// future repo-layout change stays a one-file edit.
const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

test("getWhere() returns absolute, existing paths for the required surface", () => {
  const w = getWhere();
  assert.equal(w.schema, "skill-llm-wiki/where/v1");
  assert.equal(w.skill_root, SKILL_ROOT);
  assert.ok(existsSync(w.skill_md), `SKILL.md should exist at ${w.skill_md}`);
  assert.ok(existsSync(w.cli), `cli should exist at ${w.cli}`);
  assert.ok(existsSync(w.guide_dir), `guide/ should exist at ${w.guide_dir}`);
  assert.equal(w.format_version, FORMAT_VERSION);
  // package_version is a string; `readPackageVersion()` explicitly
  // falls back to "unknown" when package.json can't be read (e.g.
  // stripped installs where kit removed the manifest). Accept that
  // as a supported state; only assert the field is a non-empty
  // string so broken envelopes still fail.
  assert.equal(typeof w.package_version, "string");
  assert.ok(w.package_version.length > 0);
});

test("getWhere() reports templates_dir and testkit_dir as absolute paths", () => {
  const w = getWhere();
  // Both directories are shipped in this repo and in every
  // published tarball (see package.json `files`). `getWhere()`
  // returns null only when the directory is absent — which can
  // happen on a partial/stripped install. Assert the happy
  // invariant for the tests run in this repo, but document the
  // null fallback so consumers reading this know it exists.
  for (const key of ["templates_dir", "testkit_dir"]) {
    assert.notEqual(w[key], null, `${key} should be populated in this repo`);
    assert.ok(existsSync(w[key]), `${key} must exist on disk: ${w[key]}`);
  }
});

test("renderWhereText produces key: value lines and ends with a newline", () => {
  const info = getWhere();
  const text = renderWhereText(info);
  assert.ok(text.endsWith("\n"));
  for (const key of [
    "skill_root:",
    "skill_md:",
    "guide_dir:",
    "package_version:",
    "format_version:",
  ]) {
    assert.ok(text.includes(key), `renderWhereText missing ${key}`);
  }
});

test("`where --json` CLI prints parseable JSON", () => {
  const r = spawnSync(process.execPath, [CLI_PATH, "where", "--json"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `where exited ${r.status}: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, "skill-llm-wiki/where/v1");
  assert.equal(parsed.skill_root, SKILL_ROOT);
  assert.equal(parsed.format_version, FORMAT_VERSION);
});

test("`where` CLI without --json prints human-readable text", () => {
  const r = spawnSync(process.execPath, [CLI_PATH, "where"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `where exited ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes("skill_root:"));
  assert.ok(r.stdout.includes("format_version:"));
});

test("`where` is exempt from the runtime-dep preflight", () => {
  // Force a missing dep via the test-only env override and confirm
  // `where` still exits 0. This is the consumer-use case: probe the
  // install path without requiring `npm install` to have succeeded.
  const r = spawnSync(process.execPath, [CLI_PATH, "where", "--json"], {
    encoding: "utf8",
    env: { ...process.env, LLM_WIKI_TEST_FORCE_DEPS_MISSING: "gray-matter" },
  });
  assert.equal(
    r.status,
    0,
    `where should succeed with forced missing dep, got ${r.status}: ${r.stderr}`,
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.schema, "skill-llm-wiki/where/v1");
});
