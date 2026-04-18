// cli-run.mjs — testkit helper: spawn the skill CLI as a child
// process, capture stdout/stderr/exitCode, optionally parse the
// --json envelope. Consumers use this in their test suites to drive
// the skill without re-implementing the spawn ceremony.
//
// Zero runtime deps; pure Node built-ins.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `cli-run.mjs` lives at <SKILL_ROOT>/scripts/testkit/cli-run.mjs,
// so the CLI is two directories up then scripts/cli.mjs.
const SKILL_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const CLI_PATH = join(SKILL_ROOT, "scripts", "cli.mjs");

// Run the skill CLI with `args`. Returns an object of:
//   { status, stdout, stderr, envelope, error }
//
// `envelope` is only populated when `args` includes `--json` or
// `--json-errors` AND the stdout parses as JSON. On parse failure it
// is `null` and the caller can inspect `stdout` directly.
//
// `error` is populated when the child process could not be spawned
// at all (ENOENT, EACCES, EPERM). When it is set, `status` will be
// `null` (spawnSync's convention) and the `error` field carries the
// Node errno. Consumers writing cross-platform tests need to see
// this to distinguish "CLI ran and exited with status X" from "CLI
// never ran".
//
// Note on environment: when `env` is supplied, the testkit forwards
// the parent process environment too (object-spread with the
// override). This is intentional for local test convenience; CI
// harnesses writing untrusted fixtures should scrub `process.env`
// before calling.
export function runCli(args, { cwd, env } = {}) {
  const resolvedArgs = Array.isArray(args) ? args : [];
  const r = spawnSync(process.execPath, [CLI_PATH, ...resolvedArgs], {
    encoding: "utf8",
    cwd: cwd ?? process.cwd(),
    env: env ? { ...process.env, ...env } : process.env,
  });
  const wantJson = resolvedArgs.some(
    (a) =>
      a === "--json" ||
      a === "--json-errors" ||
      (typeof a === "string" && a.startsWith("--json=")),
  );
  let envelope = null;
  if (wantJson && r.stdout) {
    // Two output shapes exist. Envelope subcommands (validate, init,
    // heal) emit a single-line JSON object. contract/where emit
    // pretty-printed JSON spanning multiple lines. Try parsing the
    // full stdout first; if that fails, fall back to the last
    // JSON-like line (handles envelope output that may be preceded
    // by progress lines).
    const full = r.stdout.trim();
    try {
      envelope = JSON.parse(full);
    } catch {
      const lines = full.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("{")) continue;
        try {
          envelope = JSON.parse(line);
          break;
        } catch {
          continue;
        }
      }
    }
  }
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    envelope,
    error: r.error ?? null,
  };
}

// Convenience: assert a clean run, throw on non-zero exit with the
// stderr attached so the consumer's test output is useful. When the
// child failed to spawn at all (ENOENT/EACCES), surface that
// explicitly rather than saying "exited null".
export function runCliOk(args, opts) {
  const r = runCli(args, opts);
  const argString = Array.isArray(args) ? args.join(" ") : "";
  if (r.error) {
    throw new Error(
      `runCliOk: failed to spawn skill-llm-wiki ${argString}: ` +
        `${r.error.code ?? "unknown"} — ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
    throw new Error(
      `runCliOk: skill-llm-wiki ${argString} exited ${r.status}:\n${r.stderr}`,
    );
  }
  return r;
}
