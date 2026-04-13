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
// Runtime Node version guard (defense-in-depth).
//
// The primary preflight is a Bash check Claude runs BEFORE invoking this CLI
// (see SKILL.md "Preflight: verify Node.js is installed"). This guard is the
// second layer: if Node is present but below our minimum, we abort cleanly
// with a user-friendly message instead of crashing later inside some library
// call with a cryptic error.
//
// Kept intentionally before the real imports so the failure mode is: exit 4
// with a short stderr message pointing the user at SKILL.md's Preflight
// section. Exit codes used by this CLI are: 0 (ok), 1 (usage), 2 (validation
// errors), 3 (resolve-wiki miss), 4 (Node too old).
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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ingestSource } from "./lib/ingest.mjs";
import { draftLeafFrontmatter, draftCategory } from "./lib/draft.mjs";
import { rebuildAllIndices, rebuildIndex } from "./lib/indices.mjs";
import { validateWiki, summariseFindings } from "./lib/validate.mjs";
import { runShapeCheck } from "./lib/shape-check.mjs";
import {
  listVersions,
  nextVersionTag,
  resolveLiveWiki,
  writeCurrentPointer,
} from "./lib/paths.mjs";

// Hard-coded because @ctxr/kit strips package.json from installed artifacts
// (see installers/folder.js: package.json is always-dropped metadata). Bump
// this on every release alongside package.json.
const CLI_VERSION = "0.1.0";

function getPackageVersion() {
  return CLI_VERSION;
}

function printUsage() {
  console.error(`skill-llm-wiki CLI v${getPackageVersion()}

Usage: node scripts/cli.mjs <subcommand> [args]

Subcommands:
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
  --version                        Print CLI version
  --help, -h                       Show this help
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printUsage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv[0] === "--version") {
    console.log(getPackageVersion());
    return;
  }

  const cmd = argv[0];
  const args = argv.slice(1);

  switch (cmd) {
    case "ingest": {
      if (args.length < 1) usageError("ingest requires <source>");
      const candidates = ingestSource(resolve(args[0]));
      process.stdout.write(JSON.stringify({ candidates }, null, 2) + "\n");
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
      const findings = validateWiki(wiki);
      const summary = summariseFindings(findings);
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
      process.exit(summary.errors > 0 ? 2 : 0);
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
    default:
      printUsage();
      process.exit(1);
  }
}

function usageError(msg) {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
