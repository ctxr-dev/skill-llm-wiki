// json-envelope.mjs — shared JSON stdout shape for consumer-facing
// subcommands. Every subcommand that accepts `--json` emits exactly
// one envelope object on stdout; no surrounding prose, no multiple
// envelopes per invocation. stderr stays free-form for logs.
//
// Consumers validate the `schema` discriminator as their first
// check. See guide/consumers/recipes/post-write-heal.md and
// recipes/ci-gate.md for canonical parsing patterns.
//
// Envelope shape (format_version 1):
//   {
//     "schema": "skill-llm-wiki/v1",
//     "command": "validate",
//     "target": "/abs/path" | null,
//     "verdict": "ok" | "fixable" | "needs-rebuild" | "broken"
//              | "built" | "extended" | "healed" | "initialised"
//              | "aborted" | "ambiguous",
//     "exit": <integer>,
//     "diagnostics": [
//       { "code": "IDX-01", "severity": "warning", "path": "...", "message": "..." }
//     ],
//     "artifacts": { "created": [...], "modified": [...], "deleted": [...] },
//     "timing_ms": <integer>
//   }

export const ENVELOPE_SCHEMA = "skill-llm-wiki/v1";

// Every known verdict string. Consumers can switch on these without
// fearing a surprise value; adding a new verdict is a format_version
// bump.
export const VERDICTS = Object.freeze([
  "ok",
  "fixable",
  "needs-rebuild",
  "broken",
  "built",
  "extended",
  "healed",
  "initialised",
  "aborted",
  "ambiguous",
]);

// Diagnostic severity levels. Consumers gate their CI on `error`.
export const SEVERITIES = Object.freeze(["error", "warning", "info"]);

// Build an envelope from a minimal set of inputs. Missing artifact
// buckets default to empty arrays so consumers never have to
// defensively check for undefined.
//
// `next` is an optional structured hint for consumers that also
// carries a human-readable form in an info diagnostic. It is the
// machine-readable sibling of the NEXT-01 diagnostic consumers may
// still parse today.
export function makeEnvelope({
  command,
  target = null,
  verdict,
  exit,
  diagnostics = [],
  artifacts = {},
  timing_ms = 0,
  next = null,
} = {}) {
  if (!command || typeof command !== "string") {
    throw new Error("makeEnvelope: command is required");
  }
  if (!verdict || typeof verdict !== "string") {
    throw new Error("makeEnvelope: verdict is required");
  }
  if (!VERDICTS.includes(verdict)) {
    throw new Error(
      `makeEnvelope: unknown verdict "${verdict}". Known: ${VERDICTS.join(", ")}`,
    );
  }
  if (!Number.isInteger(exit)) {
    throw new Error("makeEnvelope: exit must be an integer");
  }
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    command,
    target,
    verdict,
    exit,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    artifacts: {
      created: artifacts.created ?? [],
      modified: artifacts.modified ?? [],
      deleted: artifacts.deleted ?? [],
    },
    timing_ms: Number.isInteger(timing_ms) ? timing_ms : 0,
  };
  if (next !== null) {
    if (
      typeof next !== "object" ||
      typeof next.command !== "string" ||
      !Array.isArray(next.args)
    ) {
      throw new Error(
        "makeEnvelope: next must be { command: string, args: string[] } or null",
      );
    }
    envelope.next = { command: next.command, args: next.args.slice() };
  }
  return envelope;
}

// Shared error-envelope builder used by consumer subcommands that
// need to surface a structured failure without reinventing the
// envelope shape. Verdict defaults to "ambiguous" (the canonical
// error verdict) and exit defaults to 2 (validation / ambiguity per
// the skill-wide scheme). Usage-error callers pass exit=1 explicitly.
export function makeErrorEnvelope({
  command,
  code,
  message,
  target = null,
  verdict = "ambiguous",
  exit = 2,
} = {}) {
  if (!command || typeof command !== "string") {
    throw new Error("makeErrorEnvelope: command is required");
  }
  if (!code || typeof code !== "string") {
    throw new Error("makeErrorEnvelope: code is required");
  }
  return makeEnvelope({
    command,
    target,
    verdict,
    exit,
    diagnostics: [
      { code, severity: "error", path: target, message: message ?? "" },
    ],
  });
}

// Write an envelope to stdout as one line of JSON followed by a
// newline. Single-line output is easier to pipe through `jq` and
// also to `grep`-assert in test harnesses.
export function writeEnvelope(envelope, stream = process.stdout) {
  stream.write(JSON.stringify(envelope) + "\n");
}

// Detect whether any of --json, --json-errors (legacy alias), or
// --json=1 was passed. Returns true on the first positive match.
// `--json-errors` predates the envelope; we accept it as an alias
// rather than deprecating it loudly, because every existing
// consumer passes it to get structured intent errors.
export function hasJsonFlag(args) {
  if (!Array.isArray(args)) return false;
  for (const tok of args) {
    if (typeof tok !== "string") continue;
    if (tok === "--json" || tok === "--json-errors") return true;
    if (tok.startsWith("--json=")) {
      const v = tok.slice("--json=".length).toLowerCase();
      return v === "1" || v === "true" || v === "yes";
    }
  }
  return false;
}

// Convert a validate-style finding (code, severity, target, message)
// into a diagnostic object in the envelope's canonical shape. Shared
// so consumers see the same field names everywhere.
export function findingToDiagnostic(finding) {
  return {
    code: finding.code ?? "UNKNOWN",
    severity: finding.severity ?? "info",
    path: finding.target ?? null,
    message: finding.message ?? "",
  };
}
