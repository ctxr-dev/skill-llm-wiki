// templates.test.mjs — shipped layout templates + discovery helper.
//
// Ensures every template bundled under <SKILL_ROOT>/templates/
// parses as a plausible layout contract and is exposed through the
// listTemplates() helper that Feature 2 (init) will consume.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  defaultTemplateForKind,
  getTemplate,
  listTemplates,
  readTemplate,
  templatesDir,
} from "../../scripts/lib/templates.mjs";

const EXPECTED_NAMES = [
  "reports",
  "sessions",
  "regressions",
  "plans",
  "runbooks",
  "adrs",
];

test("templatesDir() points at an existing directory", () => {
  const dir = templatesDir();
  assert.ok(existsSync(dir), `templates/ should ship at ${dir}`);
});

test("listTemplates() returns every expected starter template", () => {
  const templates = listTemplates();
  for (const name of EXPECTED_NAMES) {
    assert.ok(name in templates, `missing starter template: ${name}`);
    assert.ok(
      existsSync(templates[name].path),
      `path for ${name} should exist`,
    );
  }
});

test("each template declares mode: hosted", () => {
  const templates = listTemplates();
  for (const name of EXPECTED_NAMES) {
    const body = readFileSync(templates[name].path, "utf8");
    assert.match(body, /\nmode:\s*hosted\b/, `${name} should declare mode: hosted`);
  }
});

test("each template declares a layout section", () => {
  const templates = listTemplates();
  for (const name of EXPECTED_NAMES) {
    const body = readFileSync(templates[name].path, "utf8");
    assert.match(body, /\nlayout:\s*\n/, `${name} should declare a layout section`);
  }
});

test("dated templates include a dynamic_subdirs.template with date tokens", () => {
  const datedNames = ["reports", "sessions", "regressions", "plans"];
  const templates = listTemplates();
  for (const name of datedNames) {
    const body = readFileSync(templates[name].path, "utf8");
    assert.match(
      body,
      /dynamic_subdirs:\s*\n\s+template:\s*"\{yyyy\}(\/\{mm\})?(\/\{dd\})?"/,
      `${name} should include a {yyyy}… dynamic_subdirs template`,
    );
  }
});

test("subject templates do NOT include dynamic_subdirs", () => {
  const subjectNames = ["runbooks", "adrs"];
  const templates = listTemplates();
  for (const name of subjectNames) {
    const body = readFileSync(templates[name].path, "utf8");
    assert.doesNotMatch(
      body,
      /dynamic_subdirs:/,
      `${name} is a subject template and must not declare dynamic_subdirs`,
    );
  }
});

test("getTemplate('reports') returns metadata with kind: dated", () => {
  const t = getTemplate("reports");
  assert.ok(t);
  assert.equal(t.kind, "dated");
  assert.ok(t.description.length > 0);
});

test("getTemplate('runbooks') returns metadata with kind: subject", () => {
  const t = getTemplate("runbooks");
  assert.ok(t);
  assert.equal(t.kind, "subject");
});

test("getTemplate('does-not-exist') returns null", () => {
  assert.equal(getTemplate("does-not-exist"), null);
});

test("readTemplate returns the file bytes verbatim", () => {
  const t = getTemplate("reports");
  const body = readTemplate("reports");
  assert.equal(body, readFileSync(t.path, "utf8"));
});

test("defaultTemplateForKind maps kinds to concrete templates", () => {
  assert.equal(defaultTemplateForKind("dated"), "reports");
  assert.equal(defaultTemplateForKind("subject"), "runbooks");
  assert.equal(defaultTemplateForKind("bogus"), null);
});

test("where --json reports templates_dir now that templates/ ships", async () => {
  const { getWhere } = await import("../../scripts/lib/where.mjs");
  const w = getWhere();
  assert.notEqual(w.templates_dir, null);
  assert.equal(w.templates_dir, templatesDir());
});
