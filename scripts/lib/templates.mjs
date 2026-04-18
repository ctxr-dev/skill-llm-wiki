// templates.mjs — discovery + metadata for the shipped layout
// templates under <SKILL_ROOT>/templates/*.llmwiki.layout.yaml.
//
// Feature 1 (this module) exposes the list and paths. Feature 2
// (init) uses them to seed a consumer's topic wiki with one command.
// Consumers can also copy templates by hand via `skill-llm-wiki
// where --json` + templates_dir.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ROOT } from "./where.mjs";

const TEMPLATES_DIR = join(SKILL_ROOT, "templates");
const TEMPLATE_SUFFIX = ".llmwiki.layout.yaml";

// Metadata layer ON TOP of the template files. Keeps the per-template
// YAML focused on the layout contract itself while the "what kind of
// topic am I?" mapping lives in code. A template whose name isn't
// listed here is still usable, just not recommended via the CLI's
// `--kind` short-hand.
const TEMPLATE_META = {
  reports: { kind: "dated", description: "Generated reports filed by day." },
  sessions: { kind: "dated", description: "Daily session logs filed by day." },
  regressions: { kind: "dated", description: "Regression notes filed by month." },
  plans: { kind: "dated", description: "Plans filed by day, with subject subfolders for families." },
  runbooks: { kind: "subject", description: "Runbooks grouped by subject." },
  adrs: { kind: "subject", description: "Architecture decision records, numbered by subject." },
};

export function templatesDir() {
  return TEMPLATES_DIR;
}

// Return a map of template name (e.g. "reports") -> { path, kind,
// description }. Only templates that actually exist on disk are
// returned — package.json `files` ships the templates/ dir, but a
// broken install or an older skill version may lack a given file.
export function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return {};
  const out = {};
  for (const entry of readdirSync(TEMPLATES_DIR)) {
    if (!entry.endsWith(TEMPLATE_SUFFIX)) continue;
    const name = entry.slice(0, -TEMPLATE_SUFFIX.length);
    const abs = join(TEMPLATES_DIR, entry);
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    const meta = TEMPLATE_META[name] ?? {
      kind: "unknown",
      description: "",
    };
    out[name] = { path: abs, kind: meta.kind, description: meta.description };
  }
  return out;
}

export function getTemplate(name) {
  const all = listTemplates();
  return all[name] ?? null;
}

export function readTemplate(name) {
  const t = getTemplate(name);
  if (!t) return null;
  return readFileSync(t.path, "utf8");
}

// Returns the canonical default template name for a given --kind.
// Consumers who don't want to name a specific template can pass
// --kind and get a sensible default (dated -> reports, subject ->
// runbooks).
export function defaultTemplateForKind(kind) {
  if (kind === "dated") return "reports";
  if (kind === "subject") return "runbooks";
  return null;
}
