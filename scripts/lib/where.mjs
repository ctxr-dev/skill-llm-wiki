// where.mjs — canonical "where am I installed?" report.
//
// Consumers need a reliable way to resolve the skill's install path
// without hard-coding `~/.claude/skills/...` or duplicating the
// @ctxr/kit path list. `skill-llm-wiki where` answers:
//   - where is the skill root?
//   - where is SKILL.md?
//   - where is the templates/ directory?
//   - where is the scripts/testkit/ directory?
//   - what are the current package and format versions?
//
// Safe to invoke before the runtime-dep preflight resolves; uses
// only node:fs + node:path + node:url. No gray-matter, no transformers.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FORMAT_VERSION } from "./contract.mjs";

// `where.mjs` lives at <SKILL_ROOT>/scripts/lib/where.mjs. The skill
// root is two directories up. Exported so other lib / testkit
// modules that need the skill root import this single source of
// truth (contract.mjs, templates.mjs, cli-run.mjs).
export const SKILL_ROOT = dirname(
  dirname(dirname(fileURLToPath(import.meta.url))),
);

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(SKILL_ROOT, "package.json"), "utf8"),
    );
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function pathIfExists(p) {
  return existsSync(p) ? p : null;
}

export function getWhere() {
  return {
    schema: "skill-llm-wiki/where/v1",
    skill_root: SKILL_ROOT,
    skill_md: join(SKILL_ROOT, "SKILL.md"),
    cli: join(SKILL_ROOT, "scripts", "cli.mjs"),
    guide_dir: join(SKILL_ROOT, "guide"),
    templates_dir: pathIfExists(join(SKILL_ROOT, "templates")),
    testkit_dir: pathIfExists(join(SKILL_ROOT, "scripts", "testkit")),
    package_version: readPackageVersion(),
    format_version: FORMAT_VERSION,
  };
}

// Human-readable summary. Absolute paths, one per line, aligned so
// operators can eyeball things without parsing JSON.
export function renderWhereText(info) {
  const lines = [
    `skill_root:       ${info.skill_root}`,
    `skill_md:         ${info.skill_md}`,
    `cli:              ${info.cli}`,
    `guide_dir:        ${info.guide_dir}`,
    `templates_dir:    ${info.templates_dir ?? "<not shipped>"}`,
    `testkit_dir:      ${info.testkit_dir ?? "<not shipped>"}`,
    `package_version:  ${info.package_version}`,
    `format_version:   ${info.format_version}`,
  ];
  return lines.join("\n") + "\n";
}
