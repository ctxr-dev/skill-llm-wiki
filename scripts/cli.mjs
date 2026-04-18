#!/usr/bin/env node
// skill-llm-wiki CLI — deterministic script helpers Claude invokes
// while driving the methodology's operations.
//
// This is NOT the full operation pipeline. The LLM (Claude, invoking this
// skill) is the orchestrator: it reads SKILL.md, runs ingest + index-rebuild
// + validate + shape-check via this CLI, drafts frontmatter itself where
// heuristics are insufficient, and writes results using the standard Edit
// and Write tools. This CLI exists so the deterministic phases are fast,
// cheap, and identical across runs.
//
// Subcommands:
//   ingest <source>                  — walk a source, emit candidate JSON
//   draft-leaf <candidate-json>      — deterministic leaf frontmatter draft
//   index-rebuild <wiki>             — regenerate all index.md files
//   index-rebuild-one <dir> <wiki>   — regenerate a single directory's index
//   validate <wiki>                  — run hard invariants, print report
//   shape-check <wiki>               — detect operator candidates
//   resolve-wiki <source>            — print current live wiki path
//   next-version <source>            — print next version tag
//   --version                        — print version
//   --help                           — print usage

// ───────────────────────────────────────────────────────────────────────────
// Runtime preflight guard (defense-in-depth).
//
// The primary preflight is a Bash check Claude runs BEFORE invoking this CLI
// (see SKILL.md "Preflight: verify Node.js is installed"). This guard is the
// second layer.
//
// The inline Node-major check here runs BEFORE any `import` statement so
// that even on an ancient Node that rejects our modern syntax, we abort
// cleanly with a short stderr message instead of a cryptic parse error.
// The richer preflight (full semver, git version, wiki fsck) runs inside
// main() after imports have resolved — it cannot be earlier without
// creating a circular dependency between cli.mjs and preflight.mjs.
//
// Exit codes used by this CLI are:
//   0 ok · 1 usage · 2 validation · 3 resolve-wiki miss ·
//   4 Node too old · 5 git missing/too old · 6 wiki corrupt ·
//   7 NEEDS_TIER2 (suspend — wiki-runner must resolve pending
//     tier2 requests and re-invoke; NOT a failure path) ·
//   8 DEPS_MISSING (required runtime dependency missing and the
//     auto-install attempt was either declined or failed)
// ───────────────────────────────────────────────────────────────────────────
const REQUIRED_NODE_MAJOR = 18;
const _nodeVersionRaw = (process && process.version) || "";
const _nodeMajorMatch = /^v(\d+)\./.exec(_nodeVersionRaw);
const _nodeMajor = _nodeMajorMatch ? Number(_nodeMajorMatch[1]) : NaN;
if (!Number.isFinite(_nodeMajor) || _nodeMajor < REQUIRED_NODE_MAJOR) {
  process.stderr.write(
    "skill-llm-wiki: Node.js " + (_nodeVersionRaw || "<unknown>") +
      " is below the required minimum (v" + REQUIRED_NODE_MAJOR + ".0.0).\n" +
      "Please upgrade Node.js and retry. See SKILL.md " +
      "'Preflight: verify Node.js is installed' for platform-specific " +
      "install instructions.\n",
  );
  process.exit(4);
}

// ───────────────────────────────────────────────────────────────────────────
// Dependency preflight (defence-in-depth, runs BEFORE the static imports
// that would otherwise pull in `gray-matter`).
//
// The static import chain below transitively loads `gray-matter` via
// scripts/lib/source-frontmatter.mjs. If that package is missing from
// node_modules, the import throws ERR_MODULE_NOT_FOUND with no
// actionable context. By doing a synchronous resolve + prompt/install
// loop here — using only Node built-ins — we either fix the install or
// exit 8 cleanly before the failing import is reached.
//
// `--version` and `--help` deliberately bypass this check so an operator
// debugging a broken install can still sanity-check the binary. They are
// handled by an early-exit branch a few lines down.
// ───────────────────────────────────────────────────────────────────────────
import { createRequire as _createRequireDP } from "node:module";
import { spawnSync as _spawnSyncDP } from "node:child_process";
import { fileURLToPath as _fileURLToPathDP } from "node:url";
import { dirname as _dirnameDP, resolve, join as _joinDP } from "node:path";
import { readSync as _readSyncDP, readFileSync, mkdirSync } from "node:fs";

const _SKILL_ROOT_DP = _dirnameDP(_dirnameDP(_fileURLToPathDP(import.meta.url)));
const _REQUIRED_DEPS_DP = ["gray-matter", "@xenova/transformers"];

function _depPreflightCheck() {
  // Test-only override: lets the e2e suite exercise the missing-dep
  // path without renaming files inside the live node_modules tree
  // (which would race with parallel test files sharing the same
  // skill root). The value is a comma-separated list of dep names to
  // pretend are missing.
  const forced = process.env.LLM_WIKI_TEST_FORCE_DEPS_MISSING;
  if (forced) {
    return forced
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  let req;
  try {
    req = _createRequireDP(_joinDP(_SKILL_ROOT_DP, "package.json"));
  } catch {
    return _REQUIRED_DEPS_DP.slice();
  }
  const missing = [];
  for (const d of _REQUIRED_DEPS_DP) {
    try {
      req.resolve(d);
    } catch {
      missing.push(d);
    }
  }
  return missing;
}

function _depPreflightFailMessage(missing) {
  return (
    "skill-llm-wiki: required runtime dependencies are missing:\n" +
    missing.map((d) => `  - ${d}`).join("\n") +
    "\n" +
    "Run `npm install` in the skill directory to install them, or see " +
    "guide/ux/preflight.md Case E.\n"
  );
}

// Skip the dep check entirely for --version, --help, `contract`, and
// `where` so an operator debugging a broken install can still get
// version/usage output, and so consumers can probe the contract
// before the runtime dependencies are necessarily resolved. Every
// other invocation (including `--help` placed AFTER another arg,
// which is a malformed invocation we don't need to coddle) runs the
// check.
const _argvDP = process.argv.slice(2);
const _isPreflightExemptDP =
  _argvDP[0] === "--version" ||
  _argvDP[0] === "--help" ||
  _argvDP[0] === "-h" ||
  _argvDP[0] === "contract" ||
  _argvDP[0] === "where";

if (!_isPreflightExemptDP) {
  let _missingDP = _depPreflightCheck();
  if (_missingDP.length > 0) {
    process.stderr.write(_depPreflightFailMessage(_missingDP));
    const _interactiveDP =
      Boolean(process.stdin && process.stdin.isTTY) &&
      process.env.LLM_WIKI_NO_PROMPT !== "1";
    let _proceedDP = true;
    if (_interactiveDP) {
      process.stderr.write("Install now? [Y/n] ");
      let _ans = "";
      try {
        const buf = Buffer.alloc(64);
        const n = _readSyncDP(process.stdin.fd, buf, 0, buf.length, null);
        _ans = buf.subarray(0, n).toString("utf8").trim().toLowerCase();
      } catch {
        _ans = "";
      }
      if (_ans === "n" || _ans === "no") {
        process.stderr.write("Cannot proceed without dependencies. Exit.\n");
        process.exit(8);
      }
      _proceedDP = true;
    }
    if (_proceedDP) {
      // Test-only knob: when LLM_WIKI_TEST_NO_AUTOINSTALL=1 is set,
      // we skip the auto-install attempt entirely and exit 8
      // immediately. This lets the e2e test exercise the failure
      // path without ever risking a live npm install against the
      // shared node_modules used by parallel test files.
      if (process.env.LLM_WIKI_TEST_NO_AUTOINSTALL === "1") {
        process.stderr.write(
          "skill-llm-wiki: auto-install disabled by test harness. Exit.\n",
        );
        process.exit(8);
      }
      process.stderr.write(
        `skill-llm-wiki: running \`npm install --silent\` in ${_SKILL_ROOT_DP}\n`,
      );
      const _ins = _spawnSyncDP("npm", ["install", "--silent"], {
        cwd: _SKILL_ROOT_DP,
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (_ins.error || _ins.status !== 0) {
        process.stderr.write(
          "skill-llm-wiki: `npm install` failed. Cannot proceed without " +
            "dependencies. Exit.\n",
        );
        process.exit(8);
      }
      _missingDP = _depPreflightCheck();
      if (_missingDP.length > 0) {
        process.stderr.write(_depPreflightFailMessage(_missingDP));
        process.stderr.write(
          "skill-llm-wiki: dependencies are still missing after `npm install`. " +
            "Exit.\n",
        );
        process.exit(8);
      }
    }
  }
}

// All skill-internal modules are loaded via dynamic `import()` inside
// `main()` so that the dependency preflight above this line gets a
// chance to run BEFORE any module that transitively imports
// `gray-matter` or `@xenova/transformers` is evaluated. ESM static
// imports are hoisted to the top of the file regardless of source
// position, so the only way to defer them past the preflight is to use
// dynamic import. The list of imported names is identical to the
// previous static block.
let ingestSource;
let draftLeafFrontmatter, draftCategory;
let rebuildAllIndices, rebuildIndex;
let validateWiki, summariseFindings;
let runShapeCheck;
let listVersions, nextVersionTag, resolveLiveWiki, writeCurrentPointer;
let formatAmbiguityJson, formatAmbiguityText, resolveIntent;
let rollbackOperation;
let defaultMigrationTarget, migrateLegacyWiki;
let NonInteractiveError;
let NeedsTier2Error, ReviewAbortedError, runOperation, ValidationError;
let TIER2_EXIT_CODE, listBatches;
let cmdBlame, cmdDiff, cmdHistory, cmdLog, cmdReflog, cmdShow;
let cmdRemote, cmdSync;

async function loadSkillModules() {
  ({ ingestSource } = await import("./lib/ingest.mjs"));
  ({ draftLeafFrontmatter, draftCategory } = await import("./lib/draft.mjs"));
  ({ rebuildAllIndices, rebuildIndex } = await import("./lib/indices.mjs"));
  ({ validateWiki, summariseFindings } = await import("./lib/validate.mjs"));
  ({ runShapeCheck } = await import("./lib/shape-check.mjs"));
  ({ listVersions, nextVersionTag, resolveLiveWiki, writeCurrentPointer } =
    await import("./lib/paths.mjs"));
  ({ formatAmbiguityJson, formatAmbiguityText, resolveIntent } = await import(
    "./lib/intent.mjs"
  ));
  ({ rollbackOperation } = await import("./lib/rollback.mjs"));
  ({ defaultMigrationTarget, migrateLegacyWiki } = await import(
    "./lib/migrate.mjs"
  ));
  ({ NonInteractiveError } = await import("./lib/interactive.mjs"));
  ({ NeedsTier2Error, ReviewAbortedError, runOperation, ValidationError } =
    await import("./lib/orchestrator.mjs"));
  ({ TIER2_EXIT_CODE, listBatches } = await import("./lib/tier2-protocol.mjs"));
  ({ cmdBlame, cmdDiff, cmdHistory, cmdLog, cmdReflog, cmdShow } = await import(
    "./lib/git-commands.mjs"
  ));
  ({ cmdRemote } = await import("./commands/remote.mjs"));
  ({ cmdSync } = await import("./commands/sync.mjs"));
}

// Read the version from package.json at runtime. Resolved relative to this
// source file so it works both as a local clone (dev) and as a published
// npm artifact. @ctxr/kit historically stripped package.json from installed
// skill artifacts; if that environment is re-encountered we fall through to
// "unknown" rather than carrying a hand-maintained duplicate of the version
// string that inevitably drifts.
function getPackageVersion() {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return "unknown";
  }
}

// Write usage to the appropriate stream. `--help` is a success path and
// must go to stdout so shells can pipe it (e.g. `cli --help | grep ...`);
// an unknown/malformed invocation is a failure path and goes to stderr.
function printUsage(stream = process.stdout) {
  stream.write(`skill-llm-wiki CLI v${getPackageVersion()}

Usage: node scripts/cli.mjs <subcommand> [args] [flags]

Top-level operations:
  build <source>                   Build a new wiki from a source folder
  extend <wiki>                    Add new entries from a source
  rebuild <wiki>                   Optimise structure in place
  fix <wiki>                       Repair methodology divergences
  join <wiki-a> <wiki-b>           Merge two wikis into one
  rollback <wiki> --to <ref>       Restore a previous committed state
  migrate <legacy-wiki>            Migrate a legacy .llmwiki.v<N> folder

Hidden-git plumbing (Claude reads these to reason about history):
  diff <wiki> [--op <id>] [...]    Git-style diff (default --find-renames --find-copies)
  log <wiki> [...]                 git log passthrough (default --oneline --all)
  show <wiki> <ref> [-- <path>]    git show passthrough
  blame <wiki> <path>              git blame passthrough
  reflog <wiki>                    git reflog passthrough
  history <wiki> <entry-id>        Op-log + git-log walk for one entry

Remote mirroring (explicit user-invoked only, never auto-pushes):
  remote <wiki> add <name> <url>   Register a remote URL
  remote <wiki> remove <name>      Delete a configured remote
  remote <wiki> list               List configured remotes
  sync <wiki> [--remote <name>]    Fetch + push tag refs explicitly

Consumer-facing scaffolding:
  init <topic> --kind dated|subject [--template <name>] [--force] [--json]
                                   Seed a topic directory with a shipped
                                   layout contract. Prints the exact build
                                   command to run next. Replaces the
                                   cp + edit + build-flag dance.

Low-level script helpers (deterministic, called by Claude):
  ingest <source>                  Walk source, emit candidate JSON
  draft-leaf <candidate-file>       Script-first frontmatter draft for one candidate
  draft-category <candidate-file>   Deterministic category assignment
  index-rebuild <wiki>             Regenerate all index.md files in a wiki
  index-rebuild-one <dir> <wiki>   Regenerate one directory's index.md
  validate <wiki>                  Run hard invariants and print a report
  shape-check <wiki>               Detect pending operator candidates
  resolve-wiki <source>            Print current live wiki path for a source
  next-version <source>            Print next version tag for a source
  list-versions <source>           List all existing versions for a source
  set-current <source> <version>   Update the current-pointer for a source

Layout-mode flags (build/extend/rebuild/fix/join):
  --layout-mode sibling|in-place|hosted
  --target <path>                  Explicit destination (required for hosted)

Tiered-AI flags:
  --quality-mode tiered-fast|claude-first|tier0-only
                                   Default: tiered-fast (TF-IDF → embeddings
                                   → Claude ladder). See guide/tiered-ai.md.

UX flags:
  --no-prompt                      Never prompt; fail loud on ambiguity
  --json                           Emit a structured envelope on stdout
                                   (schema skill-llm-wiki/v1). Supported by
                                   validate, contract, where, init, heal.
  --json-errors                    Legacy alias for --json, kept for
                                   backwards compatibility.
  --accept-dirty                   Operate on a dirty user git repo

Rollback flags:
  --to <ref>                       genesis | <op-id> | pre-<op-id> | HEAD~N

Consumer probes (exempt from runtime-dep preflight):
  contract [--json]                Print machine-readable format + CLI surface
                                   contract. Consumers gate on format_version
                                   instead of drift-testing SKILL.md.
  where [--json]                   Print absolute paths to the skill root,
                                   SKILL.md, guide/, templates/, and testkit/.
                                   Resolves the install path without kit lookup.

Global:
  --version                        Print CLI version
  --help, -h                       Show this help

Exit codes: 0 ok · 1 usage · 2 ambiguous intent · 3 resolve-wiki miss ·
            4 Node too old · 5 git missing/too old · 6 wiki corrupt ·
            7 NEEDS_TIER2 (wiki-runner must resolve pending requests
              and re-invoke this CLI — see SKILL.md delegation contract) ·
            8 DEPS_MISSING (required runtime dependency missing and the
              install attempt was either declined or failed)
`);
}

// Parse a subcommand's remaining argv into { positionals, flags } for
// delegation to resolveIntent. Unknown flags bubble up as a structured
// error so we never silently swallow a typo.
const FLAG_WITH_VALUE = new Set([
  "--layout-mode",
  "--target",
  "--to",
  "--canonical",
  "--quality-mode",
]);
const FLAG_BOOLEAN = new Set([
  "--no-prompt",
  "--json",
  "--json-errors",
  "--accept-dirty",
  "--accept-foreign-target",
  "--review",
]);

function parseSubArgv(raw) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    // Accept both `--flag value` and `--flag=value`.
    let name = tok;
    let inlineValue = null;
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      name = tok.slice(0, eq);
      inlineValue = tok.slice(eq + 1);
    }
    if (FLAG_WITH_VALUE.has(name)) {
      const value = inlineValue !== null ? inlineValue : raw[++i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        return { error: `flag ${name} requires a non-empty value` };
      }
      const key = name.slice(2).replace(/-/g, "_");
      flags[key] = value;
      continue;
    }
    if (FLAG_BOOLEAN.has(name)) {
      if (inlineValue !== null) {
        return { error: `flag ${name} does not take a value` };
      }
      const key = name.slice(2).replace(/-/g, "_");
      flags[key] = true;
      continue;
    }
    return { error: `unknown flag: ${name}` };
  }
  return { positionals, flags };
}

// Emit an ambiguity or parse error through the configured formatter and
// exit 2. Never throws — returns through process.exit.
function emitIntentError(error, jsonMode) {
  const body = jsonMode
    ? formatAmbiguityJson(error)
    : formatAmbiguityText(error);
  process.stderr.write(body);
  process.exit(2);
}

// Generate a stable op-id for a new top-level operation. Format:
//   <operation>-<YYYYMMDD-HHMMSS>-<random>
// The wall-clock component is replaced by LLM_WIKI_FIXED_TIMESTAMP when
// set, so deterministic reruns produce identical op-ids.
function newOpId(operation) {
  const now = process.env.LLM_WIKI_FIXED_TIMESTAMP
    ? new Date(Number(process.env.LLM_WIKI_FIXED_TIMESTAMP) * 1000)
    : new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const rand = process.env.LLM_WIKI_FIXED_TIMESTAMP
    ? "deterministic"
    : Math.random().toString(36).slice(2, 8);
  return `${operation}-${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    printUsage(process.stdout);
    process.exit(0);
  }
  if (argv.length === 0) {
    printUsage(process.stderr);
    process.exit(1);
  }
  if (argv[0] === "--version") {
    // The dependency preflight is intentionally skipped for --version
    // and --help so an operator debugging a broken install can still
    // sanity-check the binary. Every other code path runs the
    // preflight before any deterministic work begins.
    console.log(getPackageVersion());
    return;
  }

  // `contract` and `where` are exempt from the dep preflight (see
  // the preflight-skip list above) so consumers can probe the
  // skill's surface before the runtime deps are resolvable. Both
  // pull only pure-data from scripts/lib/* and do not touch any
  // wiki state.
  if (argv[0] === "contract") {
    const { getContract, renderContractText } = await import("./lib/contract.mjs");
    const wantJson = argv.slice(1).includes("--json");
    const contract = getContract();
    if (wantJson) {
      process.stdout.write(JSON.stringify(contract, null, 2) + "\n");
    } else {
      process.stdout.write(renderContractText(contract));
    }
    return;
  }
  if (argv[0] === "where") {
    const { getWhere, renderWhereText } = await import("./lib/where.mjs");
    const wantJson = argv.slice(1).includes("--json");
    const info = getWhere();
    if (wantJson) {
      process.stdout.write(JSON.stringify(info, null, 2) + "\n");
    } else {
      process.stdout.write(renderWhereText(info));
    }
    return;
  }

  // The dependency preflight has already run in the pre-import block
  // at the top of this file. By the time we reach this point, every
  // required runtime dep has been verified or the process has exited
  // 8. See guide/ux/preflight.md Case E.
  //
  // Now load the skill-internal modules. They use `gray-matter` and
  // `@xenova/transformers` transitively, so they MUST be loaded only
  // after the dep preflight has confirmed both packages are
  // resolvable.
  await loadSkillModules();

  const cmd = argv[0];
  const args = argv.slice(1);

  // ─── Remote + sync subcommands (Phase 7) ────────────────────────────
  // Both take <wiki> as the first positional. `remote` takes a
  // subcommand (add/remove/list); `sync` accepts --remote <name>
  // and --push-branch <ref> flags.
  if (cmd === "remote") {
    if (args.length < 1) {
      usageError("remote requires <wiki> as its first argument");
    }
    const wiki = resolve(args[0]);
    const subcommand = args[1];
    const subArgs = args.slice(2);
    process.exit(cmdRemote(wiki, { subcommand, args: subArgs }));
  }
  if (cmd === "sync") {
    if (args.length < 1) {
      usageError("sync requires <wiki> as its first argument");
    }
    const wiki = resolve(args[0]);
    // Parse --remote / --push-branch / --skip-fetch / --skip-push.
    // Both `--flag value` and `--flag=value` are accepted to match
    // the rest of the CLI's flag conventions. Empty values and
    // leading-dash values are rejected loudly.
    const rest = args.slice(1);
    const opts = {};
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i];
      // Accept --flag=value form.
      let name = tok;
      let inlineValue = null;
      const eq = tok.indexOf("=");
      if (tok.startsWith("--") && eq !== -1) {
        name = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }
      const readValue = (flagName) => {
        const v = inlineValue !== null ? inlineValue : rest[++i];
        if (v === undefined || v === "" || v.startsWith("--")) {
          usageError(`sync: ${flagName} requires a non-empty value`);
        }
        return v;
      };
      if (name === "--remote") {
        opts.remote = readValue("--remote");
      } else if (name === "--push-branch") {
        opts.pushBranch = readValue("--push-branch");
      } else if (name === "--skip-fetch") {
        if (inlineValue !== null) usageError("sync: --skip-fetch does not take a value");
        opts.skipFetch = true;
      } else if (name === "--skip-push") {
        if (inlineValue !== null) usageError("sync: --skip-push does not take a value");
        opts.skipPush = true;
      } else {
        usageError(`sync: unknown argument "${tok}"`);
      }
    }
    process.exit(cmdSync(wiki, opts));
  }

  // ─── Hidden-git passthrough subcommands ─────────────────────────────
  // These wrap scripts/lib/git.mjs with the full isolation env so
  // Claude (or a user) can inspect history without ever touching the
  // user's own git repo. Every hidden-git command takes <wiki> as its
  // first positional; remaining args pass through to git.
  const HIDDEN_GIT_SUBCOMMANDS = new Set([
    "diff",
    "log",
    "show",
    "blame",
    "reflog",
    "history",
  ]);
  if (HIDDEN_GIT_SUBCOMMANDS.has(cmd)) {
    if (args.length < 1) {
      usageError(`${cmd} requires <wiki> as its first argument`);
    }
    const wiki = resolve(args[0]);
    // Parse a minimal set of our own flags; everything else passes
    // through to the underlying git command.
    const rest = args.slice(1);
    const opIdx = rest.indexOf("--op");
    let op = null;
    let passthrough = rest.slice();
    if (opIdx !== -1) {
      op = rest[opIdx + 1];
      passthrough = rest.slice(0, opIdx).concat(rest.slice(opIdx + 2));
    }
    let code = 0;
    switch (cmd) {
      case "diff":
        code = cmdDiff(wiki, { op, args: passthrough });
        break;
      case "log":
        code = cmdLog(wiki, { op, args: passthrough });
        break;
      case "show": {
        const ref = passthrough[0];
        const showArgs = passthrough.slice(1);
        code = cmdShow(wiki, { ref, args: showArgs });
        break;
      }
      case "blame": {
        const path = passthrough[0];
        const blameArgs = passthrough.slice(1);
        code = cmdBlame(wiki, { path: path && resolve(path), args: blameArgs });
        break;
      }
      case "reflog":
        code = cmdReflog(wiki, { args: passthrough });
        break;
      case "history": {
        const entryId = passthrough[0];
        code = cmdHistory(wiki, { entryId });
        break;
      }
    }
    process.exit(code);
  }

  // ─── Top-level operations routed through intent.mjs ─────────────────
  // build / extend / rebuild / fix / join share the same intent-
  // resolution → dispatch flow. rollback and migrate have tiny bespoke
  // paths (still routed through intent for the ambiguity surface).
  // Phase 2 wires the plumbing; Phase 3 will extend the handlers with
  // full phased orchestration.
  const INTENT_SUBCOMMANDS = new Set([
    "build",
    "extend",
    "rebuild",
    "fix",
    "join",
    "rollback",
    "migrate",
  ]);
  if (INTENT_SUBCOMMANDS.has(cmd)) {
    const parsed = parseSubArgv(args);
    if (parsed.error) {
      const jsonMode =
        args.includes("--json-errors") || args.includes("--json");
      emitIntentError(
        {
          code: "INT-11",
          message: parsed.error,
          options: [],
          resolving_flag: "correct the flag",
        },
        jsonMode,
      );
    }
    const { positionals, flags } = parsed;
    // `--json` is the canonical flag; `--json-errors` is the legacy
    // alias kept for existing consumers. Either enables JSON output.
    const jsonMode = Boolean(flags.json_errors) || Boolean(flags.json);

    // `migrate` has its own resolution path — the intent resolver would
    // reject the legacy folder shape as ambiguous.
    if (cmd === "migrate") {
      if (positionals.length !== 1) {
        emitIntentError(
          {
            code: "INT-06",
            message: "migrate requires exactly one <legacy-wiki> positional",
            options: [
              {
                description: "specify the legacy wiki",
                flag: "migrate <legacy-path>",
              },
            ],
            resolving_flag: "positional legacy path",
          },
          jsonMode,
        );
      }
      const legacyPath = resolve(positionals[0]);
      const target = flags.target
        ? resolve(flags.target)
        : defaultMigrationTarget(legacyPath);
      try {
        const opId = newOpId("migrate");
        const r = migrateLegacyWiki(legacyPath, target, { opId });
        process.stdout.write(
          `migrated ${legacyPath} (v${r.version}) → ${target}\n` +
            `  op-id: ${r.opId}\n` +
            `  sha:   ${r.sha}\n`,
        );
        return;
      } catch (err) {
        if (err && err.message && /already exists/.test(err.message)) {
          emitIntentError(
            {
              code: "INT-01",
              message: err.message,
              options: [
                {
                  description: "write to a different target",
                  flag: "--target <other-path>",
                },
              ],
              resolving_flag: "--target",
            },
            jsonMode,
          );
        }
        throw err;
      }
    }

    const intent = resolveIntent({
      subcommand: cmd,
      args: positionals,
      flags,
      cwd: process.cwd(),
    });
    if (intent.status === "ambiguous") {
      emitIntentError(intent.error, jsonMode);
    }
    const plan = intent.plan;

    if (cmd === "rollback") {
      const result = rollbackOperation(plan.target, flags.to);
      process.stdout.write(
        `rolled back ${plan.target} to ${result.ref} (${result.sha ?? "n/a"})\n`,
      );
      return;
    }

    // build / extend / rebuild / fix / join: Phase 3 runs the full
    // phased orchestrator. The orchestrator handles snapshot → ingest
    // → draft-frontmatter → index-generation → validation →
    // commit-finalize, with automatic rollback on validation failure.
    if (plan.is_new_wiki) {
      mkdirSync(plan.target, { recursive: true });
    }
    const opId = newOpId(cmd);
    const startedIso = new Date().toISOString();
    let result;
    try {
      result = await runOperation(plan, {
        opId,
        source: plan.source,
        startedIso,
      });
    } catch (err) {
      if (err instanceof NonInteractiveError) {
        emitIntentError(
          {
            code: "INT-12",
            message: err.message,
            options: [
              {
                description: "run with stdin attached to a TTY",
                flag: "(interactive terminal)",
              },
            ],
            resolving_flag: "explicit flag set",
          },
          jsonMode,
        );
      }
      if (err instanceof ValidationError) {
        process.stderr.write(
          `${cmd}: validation failed — working tree rolled back to pre-op state\n` +
            err.message +
            "\n",
        );
        process.exit(2);
      }
      if (err instanceof NeedsTier2Error) {
        // Exit-7 handshake: a phase accumulated Tier 2 requests
        // that only a wiki-runner sub-agent can resolve. The
        // working tree is NOT rolled back — the partial-converge
        // commits in the private git are preserved so the resume
        // invocation can continue from the last completed
        // iteration. The wiki-runner reads the pending batch,
        // spawns one Agent per request, writes the responses, and
        // re-invokes this CLI with the same op-id (same
        // source/target positional args) so the orchestrator
        // resumes. See SKILL.md "Agent delegation contract" and
        // guide/tiered-ai.md "exit-7 handshake" for details.
        const batches = listBatches(plan.target);
        process.stderr.write(
          `${cmd}: NEEDS_TIER2 — ${err.message}\n` +
            `  op-id: ${opId}\n` +
            `  pending: ${err.pendingPath ?? "(no path)"}\n` +
            `  total batches waiting: ${batches.length}\n` +
            `  Wiki-runner: read every pending-*.json under ` +
            `${plan.target}/.work/tier2/, spawn one Agent per request, ` +
            `write responses-*.json next to it, and re-invoke this CLI ` +
            `with the same positional args.\n`,
        );
        process.exit(TIER2_EXIT_CODE);
      }
      if (err instanceof ReviewAbortedError) {
        process.stderr.write(
          `${cmd}: ${err.message}\n` +
            "No changes were committed to the wiki.\n",
        );
        process.exit(2);
      }
      throw err;
    }
    process.stdout.write(
      `${cmd}: complete\n` +
        `  target: ${plan.target}\n` +
        `  mode:   ${plan.layout_mode}\n` +
        `  op-id:  ${opId}\n` +
        `  sha:    ${result.final_sha ?? "n/a"}\n` +
        `  phases: ${result.phases.length}\n`,
    );
    for (const p of result.phases) {
      process.stdout.write(`    • ${p.name}: ${p.summary}\n`);
    }
    return;
  }

  switch (cmd) {
    case "ingest": {
      if (args.length < 1) usageError("ingest requires <source>");
      const result = ingestSource(resolve(args[0]));
      // The CLI-level `ingest` helper exposes both the leaf candidates
      // and the index sources so that downstream tooling (and human
      // inspection via `node scripts/cli.mjs ingest`) sees the full
      // picture now that index inputs are classified separately.
      process.stdout.write(
        JSON.stringify(
          {
            candidates: result.leaves ?? result.candidates ?? [],
            indexSources: result.indexSources ?? [],
          },
          null,
          2,
        ) + "\n",
      );
      break;
    }
    case "draft-leaf": {
      if (args.length < 1) usageError("draft-leaf requires <candidate-file>");
      const candidate = JSON.parse(readFileSync(args[0], "utf8"));
      const result = draftLeafFrontmatter(candidate, {
        categoryPath: draftCategory(candidate),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      break;
    }
    case "draft-category": {
      if (args.length < 1)
        usageError("draft-category requires <candidate-file>");
      const candidate = JSON.parse(readFileSync(args[0], "utf8"));
      process.stdout.write(draftCategory(candidate) + "\n");
      break;
    }
    case "index-rebuild": {
      if (args.length < 1) usageError("index-rebuild requires <wiki>");
      const wiki = resolve(args[0]);
      const out = rebuildAllIndices(wiki);
      process.stdout.write(`rebuilt ${out.length} index.md files\n`);
      break;
    }
    case "index-rebuild-one": {
      if (args.length < 2)
        usageError("index-rebuild-one requires <dir> <wiki>");
      const dir = resolve(args[0]);
      const wiki = resolve(args[1]);
      const out = rebuildIndex(dir, wiki);
      process.stdout.write(`rebuilt ${out.path}\n`);
      break;
    }
    case "validate": {
      if (args.length < 1) usageError("validate requires <wiki>");
      const wiki = resolve(args[0]);
      const wantJson = (await import("./lib/json-envelope.mjs")).hasJsonFlag(
        args,
      );
      const startMs = Date.now();
      const findings = validateWiki(wiki);
      const summary = summariseFindings(findings);
      const exit = summary.errors > 0 ? 2 : 0;
      if (wantJson) {
        const { findingToDiagnostic, makeEnvelope, writeEnvelope } =
          await import("./lib/json-envelope.mjs");
        writeEnvelope(
          makeEnvelope({
            command: "validate",
            target: wiki,
            verdict: exit === 0 ? "ok" : "broken",
            exit,
            diagnostics: findings.map(findingToDiagnostic),
            timing_ms: Date.now() - startMs,
          }),
        );
        process.exit(exit);
      }
      for (const f of findings) {
        const tag =
          f.severity === "error"
            ? "ERR "
            : f.severity === "warning"
              ? "WARN"
              : "INFO";
        console.log(`[${tag}] ${f.code}  ${f.target}`);
        console.log(`       ${f.message}`);
      }
      console.log(
        `\n${summary.errors} error(s), ${summary.warnings} warning(s)`,
      );
      process.exit(exit);
      break;
    }
    case "shape-check": {
      if (args.length < 1) usageError("shape-check requires <wiki>");
      const wiki = resolve(args[0]);
      const suggestions = runShapeCheck(wiki);
      console.log(`${suggestions.length} pending shape candidate(s)`);
      for (const s of suggestions) {
        const t = Array.isArray(s.target) ? s.target.join(", ") : s.target;
        console.log(`  ${s.operator}  ${t}`);
        console.log(`    ${s.reason}`);
      }
      break;
    }
    case "resolve-wiki": {
      if (args.length < 1) usageError("resolve-wiki requires <source>");
      const live = resolveLiveWiki(resolve(args[0]));
      if (!live) {
        process.stderr.write("no wiki exists for this source yet\n");
        process.exit(3);
      }
      process.stdout.write(live.path + "\n");
      break;
    }
    case "next-version": {
      if (args.length < 1) usageError("next-version requires <source>");
      process.stdout.write(nextVersionTag(resolve(args[0])) + "\n");
      break;
    }
    case "list-versions": {
      if (args.length < 1) usageError("list-versions requires <source>");
      const versions = listVersions(resolve(args[0]));
      for (const v of versions) process.stdout.write(`${v.tag}\t${v.path}\n`);
      break;
    }
    case "set-current": {
      if (args.length < 2)
        usageError("set-current requires <source> <version>");
      writeCurrentPointer(resolve(args[0]), args[1]);
      process.stdout.write(`current → ${args[1]}\n`);
      break;
    }
    case "init": {
      // `init` seeds a topic directory with a shipped layout contract
      // so consumers can start building hosted wikis without the
      // cp-then-build dance. No orchestrator invocation here — that
      // remains the consumer's explicit `build` call so error paths
      // stay where they already are.
      await cmdInit(args);
      break;
    }
    default:
      printUsage();
      process.exit(1);
  }
}

async function cmdInit(args) {
  const { runInit, InitError } = await import("./lib/init.mjs");
  const { hasJsonFlag, makeEnvelope, writeEnvelope } = await import(
    "./lib/json-envelope.mjs"
  );
  const wantJson = hasJsonFlag(args);

  // Minimal flag parse for init. Positional is <topic>; flags are
  // --kind <dated|subject>, --template <name>, --force, --json.
  let topic = null;
  let kind = null;
  let template = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--force") {
      force = true;
      continue;
    }
    if (tok === "--json" || tok === "--json-errors") {
      continue;
    }
    if (tok === "--kind") {
      kind = args[++i];
      continue;
    }
    if (tok.startsWith("--kind=")) {
      kind = tok.slice("--kind=".length);
      continue;
    }
    if (tok === "--template") {
      template = args[++i];
      continue;
    }
    if (tok.startsWith("--template=")) {
      template = tok.slice("--template=".length);
      continue;
    }
    if (tok.startsWith("--")) {
      initError(
        "INIT-00",
        `init: unknown flag "${tok}"`,
        wantJson,
        null,
      );
    }
    if (topic === null) {
      topic = tok;
      continue;
    }
    initError(
      "INIT-00",
      `init: unexpected positional "${tok}"`,
      wantJson,
      null,
    );
  }
  if (!topic) {
    initError("INIT-01", "init requires a <topic> path", wantJson, null);
  }

  const startMs = Date.now();
  let result;
  try {
    result = runInit({ topic, kind, template, force, cwd: process.cwd() });
  } catch (err) {
    if (err instanceof InitError) {
      initError(err.code, err.message, wantJson, null);
    }
    throw err;
  }

  if (wantJson) {
    writeEnvelope(
      makeEnvelope({
        command: "init",
        target: result.topic,
        verdict: "initialised",
        exit: 0,
        diagnostics: [
          {
            code: "NEXT-01",
            severity: "info",
            path: result.topic,
            message:
              `contract seeded; next step: ` +
              result.build_command.join(" "),
          },
        ],
        artifacts: { created: [result.contract_path] },
        timing_ms: Date.now() - startMs,
      }),
    );
    return;
  }
  process.stdout.write(
    `init: seeded ${result.contract_path}\n` +
      `  template: ${result.template} (kind=${result.kind})\n` +
      (result.overwrote ? `  overwrote existing contract\n` : "") +
      `  next: ${result.build_command.join(" ")}\n`,
  );
}

function initError(code, message, wantJson, topic) {
  if (wantJson) {
    process.stdout.write(
      JSON.stringify({
        schema: "skill-llm-wiki/v1",
        command: "init",
        target: topic,
        verdict: "ambiguous",
        exit: 1,
        diagnostics: [
          { code, severity: "error", path: topic, message },
        ],
        artifacts: { created: [], modified: [], deleted: [] },
        timing_ms: 0,
      }) + "\n",
    );
    process.exit(1);
  }
  process.stderr.write(`error: ${code} ${message}\n`);
  process.exit(1);
}

function usageError(msg) {
  process.stderr.write(`error: ${msg}\n`);
  printUsage(process.stderr);
  process.exit(1);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
