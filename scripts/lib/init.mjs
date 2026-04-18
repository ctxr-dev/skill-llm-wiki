// init.mjs — seed a topic directory with a shipped layout contract.
//
// `skill-llm-wiki init <topic> --kind dated|subject [--template <name>] [--force]`
//
// Removes the cp + edit + build-flag dance every consumer reinvents.
// Seeds the contract file and returns a structured envelope telling
// the consumer the exact build command to run next. Auto-build is
// intentionally not included here: running build internally pulls in
// the full orchestrator error surface (Tier 2 exits, validation
// rollback, non-interactive refusal). A follow-up can add a --build
// flag once the error-mapping story is proven out.
//
// Behaviour:
//   1. Resolve topic path relative to cwd; create parent dirs if needed.
//   2. Refuse if topic exists as a file, not a directory.
//   3. Select template: explicit --template wins; otherwise
//      defaultTemplateForKind.
//   4. Refuse if <topic>/.llmwiki.layout.yaml already exists, unless
//      --force.
//   5. Copy the template's body to <topic>/.llmwiki.layout.yaml.
//   6. Return a structured result; the CLI wraps it in the envelope.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import {
  defaultTemplateForKind,
  getTemplate,
  listTemplates,
} from "./templates.mjs";

const CONTRACT_FILENAME = ".llmwiki.layout.yaml";

export class InitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function runInit({
  topic,
  kind = null,
  template = null,
  force = false,
  cwd = process.cwd(),
} = {}) {
  if (!topic || typeof topic !== "string") {
    throw new InitError("INIT-01", "init requires a <topic> path");
  }
  const absTopic = pathResolve(cwd, topic);

  // Pick the template.
  let templateName = template;
  if (!templateName) {
    if (!kind) {
      throw new InitError(
        "INIT-02",
        "init requires either --template <name> or --kind <dated|subject>",
      );
    }
    templateName = defaultTemplateForKind(kind);
    if (!templateName) {
      throw new InitError(
        "INIT-03",
        `init: unknown --kind "${kind}". Accepted: dated, subject.`,
      );
    }
  }
  const tmpl = getTemplate(templateName);
  if (!tmpl) {
    const available = Object.keys(listTemplates()).join(", ");
    throw new InitError(
      "INIT-04",
      `init: template "${templateName}" not found. Available: ${available}`,
    );
  }
  // If the caller supplied both --kind and --template, check that
  // they're compatible so we catch "`--kind dated --template runbooks`"
  // before the consumer is surprised by a dated mis-shape.
  if (kind && tmpl.kind !== "unknown" && tmpl.kind !== kind) {
    throw new InitError(
      "INIT-05",
      `init: template "${templateName}" is kind=${tmpl.kind}, but --kind ${kind} was requested.`,
    );
  }

  // Ensure the topic is a directory. Use lstat so a pre-existing
  // symlink at <topic> does not silently let us mkdir/writeFile
  // through it into an attacker-controlled target. This is the
  // classic TOCTOU shape: an attacker plants
  // `<topic> -> /home/user/.ssh/` before `init` runs; without
  // lstat, writeFileSync would create .ssh/.llmwiki.layout.yaml.
  // `mkdirSync(recursive: true)` is a no-op if the directory
  // already exists; it throws only if the path exists as a file.
  if (existsSync(absTopic)) {
    const st = lstatSync(absTopic);
    if (st.isSymbolicLink()) {
      throw new InitError(
        "INIT-08",
        `init: ${absTopic} is a symbolic link; refusing to write through it. Remove or resolve the symlink explicitly before initialising.`,
      );
    }
    if (!st.isDirectory()) {
      throw new InitError(
        "INIT-06",
        `init: ${absTopic} exists but is not a directory.`,
      );
    }
  } else {
    mkdirSync(absTopic, { recursive: true });
  }

  const contractPath = join(absTopic, CONTRACT_FILENAME);
  // Same symlink guard for the contract file itself. An attacker
  // who controls the topic directory could plant a symlink at
  // <topic>/.llmwiki.layout.yaml pointing anywhere; without lstat
  // we'd follow it on writeFileSync.
  if (existsSync(contractPath)) {
    const cst = lstatSync(contractPath);
    if (cst.isSymbolicLink()) {
      throw new InitError(
        "INIT-08",
        `init: ${contractPath} is a symbolic link; refusing to overwrite through it.`,
      );
    }
  }
  const alreadyPresent = existsSync(contractPath);
  if (alreadyPresent && !force) {
    throw new InitError(
      "INIT-07",
      `init: ${CONTRACT_FILENAME} already exists at ${absTopic}. Pass --force to overwrite, or use \`skill-llm-wiki rebuild\` to reconcile against the existing contract.`,
    );
  }

  const body = readFileSync(tmpl.path, "utf8");
  writeFileSync(contractPath, body, "utf8");

  // The next step for the consumer. Passed back so the CLI can
  // include it in the envelope as an "info" diagnostic: machine-
  // readable enough for scripts, human-readable enough for operators.
  const buildCommand = [
    "skill-llm-wiki",
    "build",
    absTopic,
    "--layout-mode",
    "hosted",
    "--target",
    absTopic,
    "--json",
  ];

  return {
    topic: absTopic,
    template: templateName,
    kind: tmpl.kind,
    contract_path: contractPath,
    overwrote: alreadyPresent,
    build_command: buildCommand,
  };
}
