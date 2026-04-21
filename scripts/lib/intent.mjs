// intent.mjs — resolve a CLI invocation into a concrete operation plan,
// or return a structured ambiguity error if the user's intent cannot be
// determined without guessing. This module is the sole enforcement point
// of the "ask, don't guess" rule from methodology section 9.4.3.
//
// Callers (cli.mjs) pass the raw argv tail plus a context object:
//   resolveIntent({ subcommand, args, flags, cwd })
// Return shape:
//   { status: "ok", plan }           — go ahead and execute `plan`
//   { status: "ambiguous", error }   — print the structured error and exit 2
//
// An ambiguity `error` carries:
//   code           a stable machine-readable identifier
//   message        one-line human-readable summary
//   options[]      numbered interpretations with the resolving_flag for each
//   resolving_flag the single flag / env var / action that would remove the
//                  ambiguity by making the user's intent explicit
//
// Scenarios refused (see methodology §9.4.3):
//   INT-01   default sibling name collides with a foreign directory
//   INT-01b  explicit --target points at a foreign non-empty directory
//   INT-02   source is already a managed wiki (implicit in-place)
//   INT-03   target wiki exists but no subcommand specified
//   INT-04   legacy `.llmwiki.v<N>` folder detected
//   INT-05   rollback invoked without --to
//   INT-06   source is a bare file, not a directory
//   INT-07   multi-source build/extend without explicit canonical
//   INT-08   source is inside a user git repo with a dirty working tree
//   INT-09a  --layout-mode in-place combined with --target
//   INT-09b  --layout-mode hosted invoked without --target
//   INT-10   unknown --layout-mode value
//   INT-11   unknown CLI flag (emitted from cli.mjs's parseSubArgv)
//   INT-12   ambiguity reached interactive resolution in a non-TTY
//            context (emitted by cli.mjs when NonInteractiveError fires)
//   INT-13   unknown --quality-mode value
//   INT-14   invalid --fanout-target value (must be a positive integer
//            in [FANOUT_TARGET_MIN, FANOUT_TARGET_MAX])
//   INT-15   invalid --max-depth value (must be a positive integer in
//            [MAX_DEPTH_MIN, MAX_DEPTH_MAX])
//
// Plan shape (status === "ok"):
//   {
//     operation:     "build" | "extend" | "rebuild" | "fix" | "join" | "rollback"
//     layout_mode:   "sibling" | "in-place" | "hosted"
//     source:        absolute path | null    (the corpus to read)
//     target:        absolute path           (where the wiki lives)
//     is_new_wiki:   boolean                 (true ⇒ create from scratch)
//     flags:         { accept_dirty, no_prompt, json_errors }
//   }
//
// This module is pure — no I/O beyond filesystem probes. No git calls, no
// prompts, no network. Prompts and migration actions are orchestrated by
// the caller based on the returned structured error.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  defaultSiblingPath,
  hasPrivateGit,
  isLegacyVersionedWiki,
} from "./paths.mjs";

export const VALID_LAYOUT_MODES = Object.freeze(["sibling", "in-place", "hosted"]);

// Tiered-AI quality modes accepted by --quality-mode. Duplicated
// here (rather than imported from tiered.mjs) so the intent layer
// rejects typos BEFORE the orchestrator runs, avoiding expensive
// rollbacks on a trivial flag error. Must stay in sync with
// tiered.mjs:QUALITY_MODES — the unit test
// tests/unit/intent-resolve.test.mjs:valid-quality-modes verifies
// this.
export const VALID_QUALITY_MODES = Object.freeze([
  "tiered-fast",
  "claude-first",
  "tier0-only",
  "deterministic",
]);

// Range bounds for the balance-enforcement flags (`--fanout-target`,
// `--max-depth`). Exported so tests and the balance module can
// reference them directly without re-stating the literal values.
//
// The ranges cover the band where a post-convergence rebalance pass
// has a meaningful effect. Fanout 1 is degenerate (every split forces
// single-child chains); 100+ is effectively unbounded for any real
// corpus (the cluster detector caps individual clusters at 8).
// Max depth 0 means "no nesting" (the flat-layout case, which the
// regular NEST operator already handles); 11+ is deeper than any
// hand-authored corpus anyone has reported. Out-of-range values are
// treated as user errors at intent time so the flag is never a
// silent no-op at runtime.
export const FANOUT_TARGET_MIN = 2;
export const FANOUT_TARGET_MAX = 100;
export const MAX_DEPTH_MIN = 1;
export const MAX_DEPTH_MAX = 10;

// Parse + validate an integer-in-range flag value. Returns a short
// human-readable reason string when the value is invalid (for use in
// the ambiguity error), or null when valid. Factored out so INT-14
// and INT-15 share one implementation.
function invalidIntInRange(raw, min, max) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return `expected a positive integer, got "${raw}"`;
  }
  const n = Number.parseInt(raw, 10);
  if (n < min) return `${n} is below the minimum ${min}`;
  if (n > max) return `${n} is above the maximum ${max}`;
  return null;
}

export function ok(plan) {
  return { status: "ok", plan };
}

export function ambiguous(code, message, options, resolving_flag) {
  return {
    status: "ambiguous",
    error: { code, message, options, resolving_flag },
  };
}

function absolute(cwd, p) {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// True when a managed wiki target carries an in-progress build that
// the exit-7 handshake parked. The signal is conservative on purpose:
// either there is at least one `pending-*.json` waiting in
// `<target>/.work/tier2/`, or the work area carries a `build-*` op
// folder with no matching final tag in the op-log. Both shapes are
// produced exclusively by a build that exited 7 (or crashed mid-way)
// and there is no other production code path that creates them, so
// allowing INT-03 to short-circuit when this returns true cannot
// silently overwrite a healthy wiki.
//
// Pure filesystem probe — no git calls.
function hasIncompleteBuild(targetDir) {
  if (!isDir(targetDir)) return false;
  // Signal A: pending Tier 2 batches waiting to be re-fed.
  const tier2Dir = join(targetDir, ".work", "tier2");
  if (isDir(tier2Dir)) {
    try {
      for (const name of readdirSync(tier2Dir)) {
        if (name.startsWith("pending-") && name.endsWith(".json")) {
          return true;
        }
      }
    } catch {
      /* fall through to signal B */
    }
  }
  // Signal B: a `build-*` workdir exists with `candidates.json` but
  // its op-id has no entry in the op-log (i.e. commit-finalize never
  // ran). Read the op-log via a string substring match so we do not
  // pull in the YAML parser at intent time — this module is meant to
  // stay free of orchestrator/library imports.
  const workRoot = join(targetDir, ".work");
  if (!isDir(workRoot)) return false;
  let workEntries;
  try {
    workEntries = readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return false;
  }
  let opLogText = "";
  try {
    opLogText = readFileSync(join(targetDir, ".llmwiki", "op-log.yaml"), "utf8");
  } catch {
    opLogText = "";
  }
  for (const entry of workEntries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("build-")) continue;
    const candidatesPath = join(workRoot, entry.name, "candidates.json");
    if (!isFile(candidatesPath)) continue;
    // If the op-log mentions this op-id, the build finalised — not a
    // resume candidate. The op-log emitter (history.mjs) writes the
    // op-id unquoted unless it would round-trip ambiguously, but the
    // hyphen-separated form we generate never trips needsQuoting; for
    // safety we check both quoted and unquoted forms with a
    // surrounding-character anchor so a substring of a longer op-id
    // does not accidentally match.
    const idLine = `op_id: ${entry.name}`;
    const idLineQuoted = `op_id: "${entry.name}"`;
    if (!opLogText.includes(idLine) && !opLogText.includes(idLineQuoted)) {
      return true;
    }
  }
  return false;
}

// True if a directory is foreign-to-us: it exists, is non-empty, and has
// no `.llmwiki/git/HEAD` marker identifying it as a skill-managed wiki.
function isForeignNonEmptyDir(p) {
  if (!isDir(p)) return false;
  if (hasPrivateGit(p)) return false;
  try {
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

// Walk `startPath` upward until we find a `.git` directory or hit the
// filesystem root. Returns the repo root (the directory containing
// `.git/`) or null when the path is not inside any git repository. This
// is a READ-ONLY probe — we never spawn git through the isolated env
// block because we are intentionally inspecting the user's own repo,
// not our private one.
function findEnclosingUserRepo(startPath) {
  let cur = startPath;
  while (true) {
    if (isDir(resolve(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Run `git status --porcelain` against the user's own repo (no isolation
// env — this is the user's repo, not ours) and return an array of dirty
// path entries. Empty array ⇒ clean working tree. Returns null if the
// probe cannot run (git missing, permission denied, etc.) so callers
// can fall through rather than falsely flag.
function userRepoDirtyPaths(repoPath) {
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf8",
    env: {
      ...process.env,
      // Narrow the env so our own GIT_DIR (if set from an outer call)
      // cannot hijack this probe into the skill's private repo.
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Resolve the canonical operation plan or return an ambiguity error.
//
// ctx = {
//   subcommand: "build" | "extend" | ...
//   args:       string[]  — positional args after the subcommand
//   flags:      {
//                 layout_mode?: string,
//                 target?: string,
//                 no_prompt?: boolean,
//                 json_errors?: boolean,
//                 accept_dirty?: boolean,
//                 accept_foreign_target?: boolean,
//                 to?: string,  // for rollback
//               }
//   cwd:        string    — process working directory
// }
export function resolveIntent(ctx) {
  const { subcommand, args, flags, cwd } = ctx;
  const f = flags || {};

  // ─── Global flag validation ──────────────────────────────────────────
  if (f.layout_mode && !VALID_LAYOUT_MODES.includes(f.layout_mode)) {
    return ambiguous(
      "INT-10",
      `unknown --layout-mode value "${f.layout_mode}"`,
      VALID_LAYOUT_MODES.map((m) => ({
        description: `use ${m} mode`,
        flag: `--layout-mode ${m}`,
      })),
      "--layout-mode",
    );
  }
  if (f.quality_mode && !VALID_QUALITY_MODES.includes(f.quality_mode)) {
    return ambiguous(
      "INT-13",
      `unknown --quality-mode value "${f.quality_mode}"`,
      VALID_QUALITY_MODES.map((m) => ({
        description: `use ${m} quality mode`,
        flag: `--quality-mode ${m}`,
      })),
      "--quality-mode",
    );
  }
  if (f.fanout_target !== undefined) {
    const bad = invalidIntInRange(
      f.fanout_target,
      FANOUT_TARGET_MIN,
      FANOUT_TARGET_MAX,
    );
    if (bad) {
      return ambiguous(
        "INT-14",
        `invalid --fanout-target "${f.fanout_target}" (${bad})`,
        [
          {
            description: `use a positive integer in [${FANOUT_TARGET_MIN}, ${FANOUT_TARGET_MAX}]`,
            flag: "--fanout-target <integer>",
          },
        ],
        "--fanout-target",
      );
    }
  }
  if (f.max_depth !== undefined) {
    const bad = invalidIntInRange(f.max_depth, MAX_DEPTH_MIN, MAX_DEPTH_MAX);
    if (bad) {
      return ambiguous(
        "INT-15",
        `invalid --max-depth "${f.max_depth}" (${bad})`,
        [
          {
            description: `use a positive integer in [${MAX_DEPTH_MIN}, ${MAX_DEPTH_MAX}]`,
            flag: "--max-depth <integer>",
          },
        ],
        "--max-depth",
      );
    }
  }
  if (f.layout_mode === "in-place" && f.target) {
    return ambiguous(
      "INT-09a",
      "--layout-mode in-place cannot be combined with --target",
      [
        {
          description: "transform the source folder itself in place",
          flag: "--layout-mode in-place (drop --target)",
        },
        {
          description: "write to a separate target directory",
          flag: "--target <path> (drop --layout-mode in-place)",
        },
      ],
      "drop one of --layout-mode in-place or --target",
    );
  }

  // ─── Rollback: --to is mandatory ─────────────────────────────────────
  if (subcommand === "rollback") {
    if (args.length === 0) {
      return ambiguous(
        "INT-05",
        "rollback requires a wiki path",
        [{ description: "specify the wiki", flag: "rollback <wiki-path> --to <ref>" }],
        "positional wiki path",
      );
    }
    if (!f.to) {
      return ambiguous(
        "INT-05",
        "rollback invoked without --to <ref>",
        [
          {
            description: "roll back to the state just before a specific op",
            flag: "--to pre-<op-id>",
          },
          {
            description: "roll back to the state just after a specific op",
            flag: "--to <op-id>",
          },
          {
            description: "roll back to the wiki's first tracked state",
            flag: "--to genesis",
          },
        ],
        "--to",
      );
    }
    return ok({
      operation: "rollback",
      layout_mode: null,
      source: null,
      target: absolute(cwd, args[0]),
      is_new_wiki: false,
      flags: f,
    });
  }

  // ─── Rebuild / fix: the positional IS the wiki, not a source ──────
  // These operations read frontmatter from an existing wiki and write
  // back in place. There is no separate source — the wiki is both.
  if (subcommand === "rebuild" || subcommand === "fix") {
    if (args.length !== 1) {
      return ambiguous(
        "INT-06",
        `${subcommand} requires exactly one <wiki-path> positional`,
        [
          {
            description: "specify the wiki to operate on",
            flag: `${subcommand} <wiki-path>`,
          },
        ],
        "positional wiki path",
      );
    }
    const wikiPath = absolute(cwd, args[0]);
    if (!existsSync(wikiPath)) {
      return ambiguous(
        "INT-06",
        `${subcommand}: wiki path ${wikiPath} does not exist`,
        [
          {
            description: "point at an existing skill-managed wiki",
            flag: `${subcommand} <existing-wiki-path>`,
          },
        ],
        "positional wiki path must exist",
      );
    }
    if (!hasPrivateGit(wikiPath)) {
      return ambiguous(
        "INT-06",
        `${subcommand}: ${wikiPath} is not a skill-managed wiki (no .llmwiki/git)`,
        [
          {
            description: "build the wiki first",
            flag: `build ${args[0]} --layout-mode in-place`,
          },
          {
            description: "point at an existing wiki",
            flag: `${subcommand} <path/with/.llmwiki>`,
          },
        ],
        "target must be a managed wiki",
      );
    }
    return ok({
      operation: subcommand,
      layout_mode: "in-place",
      source: wikiPath,
      target: wikiPath,
      is_new_wiki: false,
      flags: f,
    });
  }

  // ─── Multi-source check (INT-07) ────────────────────────────────────
  if (args.length > 1 && (subcommand === "build" || subcommand === "extend")) {
    return ambiguous(
      "INT-07",
      `${subcommand} received ${args.length} positional arguments; ` +
        "the canonical source determines the sibling location",
      args.map((_, i) => ({
        description: `treat ${args[i]} as canonical; merge the rest`,
        flag: `--canonical ${args[i]}`,
      })),
      "--canonical <path>",
    );
  }

  // ─── Operations that take exactly one positional path ───────────────
  if (args.length === 0) {
    return ambiguous(
      "INT-06",
      `${subcommand} requires a path to a source folder or existing wiki`,
      [
        {
          description: "provide the source folder to build from",
          flag: `${subcommand} <source-path>`,
        },
      ],
      "positional source path",
    );
  }

  const rawInput = args[0];
  const input = absolute(cwd, rawInput);

  // Source must be a directory (or a not-yet-existing path for build target).
  if (existsSync(input) && !isDir(input)) {
    if (isFile(input)) {
      return ambiguous(
        "INT-06",
        `${input} is a file, not a directory`,
        [
          {
            description:
              "treat the file as a one-entry wiki by wrapping it in a folder",
            flag: `mkdir <folder> && mv ${rawInput} <folder>/ && ${subcommand} <folder>`,
          },
          {
            description: "point at the containing folder",
            flag: `${subcommand} ${dirname(rawInput)}`,
          },
        ],
        "positional source path must be a directory",
      );
    }
  }

  // ─── Legacy wiki detection (INT-04) ─────────────────────────────────
  if (isLegacyVersionedWiki(input) && isDir(input)) {
    return ambiguous(
      "INT-04",
      `${input} uses the legacy .llmwiki.v<N> layout; migrate before operating on it`,
      [
        {
          description: "migrate to the new sibling layout <source>.wiki/",
          flag: `migrate ${rawInput}`,
        },
        {
          description: "keep using the legacy folder (not supported)",
          flag: "(not supported — migrate first)",
        },
      ],
      "migrate",
    );
  }

  // ─── Implicit in-place detection (INT-02) ───────────────────────────
  // The user pointed at a folder that is already a managed wiki. Unless
  // they explicitly asked for a mode that makes sense (rebuild, fix,
  // extend, in-place build), refuse.
  const inputIsWiki = existsSync(input) && hasPrivateGit(input);
  if (inputIsWiki) {
    if (subcommand === "build" && !f.layout_mode) {
      return ambiguous(
        "INT-02",
        `${input} is already a skill-managed wiki`,
        [
          {
            description: "update it with new entries from another source",
            flag: `extend ${rawInput} <new-source>`,
          },
          {
            description: "rebuild in place (optimise structure)",
            flag: `rebuild ${rawInput}`,
          },
          {
            description: "repair methodology divergences",
            flag: `fix ${rawInput}`,
          },
          {
            description:
              "build a fresh wiki at a different location from the same source",
            flag: `build ${rawInput} --target <new-path>`,
          },
        ],
        "pick a non-build subcommand or --target",
      );
    }
  }

  // ─── Determine layout_mode and target ────────────────────────────────
  const explicitMode = f.layout_mode || null;
  const explicitTarget = f.target ? absolute(cwd, f.target) : null;

  // Build on an existing wiki via explicit in-place is allowed.
  if (subcommand === "build" && explicitMode === "in-place") {
    return ok({
      operation: "build",
      layout_mode: "in-place",
      source: input,
      target: input,
      is_new_wiki: !inputIsWiki,
      flags: f,
    });
  }

  // Hosted mode requires --target.
  if (explicitMode === "hosted") {
    if (!explicitTarget) {
      return ambiguous(
        "INT-09b",
        "--layout-mode hosted requires --target <path>",
        [
          {
            description: "specify where the hosted wiki lives",
            flag: "--target <path>",
          },
        ],
        "--target",
      );
    }
    // INT-01b: explicit hosted target that is foreign and non-empty is
    // refused unless --accept-foreign-target is set. Hosted mode is
    // supposed to respect a pre-existing layout contract — if the user
    // points us at a random non-empty directory, we want them to make
    // the intent explicit.
    if (
      isForeignNonEmptyDir(explicitTarget) &&
      !existsSync(resolve(explicitTarget, ".llmwiki.layout.yaml")) &&
      !f.accept_foreign_target
    ) {
      return ambiguous(
        "INT-01b",
        `--target ${explicitTarget} is a non-empty directory with no layout contract`,
        [
          {
            description: "create or supply a .llmwiki.layout.yaml first",
            flag: "<author the contract at the target>",
          },
          {
            description: "pick a different target",
            flag: "--target <other-path>",
          },
          {
            description: "accept the foreign target and write into it",
            flag: "--accept-foreign-target",
          },
        ],
        "--accept-foreign-target or --target",
      );
    }
    return ok({
      operation: subcommand,
      layout_mode: "hosted",
      source: input,
      target: explicitTarget,
      is_new_wiki: !existsSync(explicitTarget) || !hasPrivateGit(explicitTarget),
      flags: f,
    });
  }

  // Default: sibling mode. Target = <source>.wiki or explicit --target.
  const target = explicitTarget || defaultSiblingPath(input);

  // INT-01: default sibling exists but is not ours.
  if (!explicitTarget && isForeignNonEmptyDir(target)) {
    return ambiguous(
      "INT-01",
      `default sibling target ${target} already exists and is not a skill-managed wiki`,
      [
        {
          description: "write to a different target path",
          flag: `--target <other-path>`,
        },
        {
          description: "transform the source folder itself",
          flag: "--layout-mode in-place",
        },
        {
          description: "remove the existing folder (destructive)",
          flag: `rm -rf ${target} && ${subcommand} ${rawInput}`,
        },
      ],
      "--target or --layout-mode in-place",
    );
  }

  // INT-01b: explicit --target points at a non-empty foreign directory.
  // Same protection as the implicit-default path; the user could easily
  // have typed a typo and we do not want to start writing inside an
  // unrelated folder. Escape hatch: --accept-foreign-target.
  if (
    explicitTarget &&
    isForeignNonEmptyDir(explicitTarget) &&
    !f.accept_foreign_target
  ) {
    return ambiguous(
      "INT-01b",
      `--target ${explicitTarget} is a non-empty directory not managed by this skill`,
      [
        {
          description: "pick a different target",
          flag: "--target <other-path>",
        },
        {
          description: "accept the foreign target and write into it",
          flag: "--accept-foreign-target",
        },
        {
          description: "remove the existing folder (destructive)",
          flag: `rm -rf ${explicitTarget} && ${subcommand} ${rawInput} --target ${explicitTarget}`,
        },
      ],
      "--accept-foreign-target or --target",
    );
  }

  // INT-08: source is inside a user git repository with dirty working
  // tree. Refuse unless the user passes --accept-dirty. We probe the
  // user's own .git (not our private one) read-only. Fail-open on probe
  // failure: if we cannot determine dirtiness, we proceed (the rest of
  // the envelope still protects the user's repo).
  if (!f.accept_dirty) {
    const userRepo = findEnclosingUserRepo(input);
    if (userRepo) {
      const dirty = userRepoDirtyPaths(userRepo);
      if (dirty && dirty.length > 0) {
        return ambiguous(
          "INT-08",
          `${userRepo} is a git repository with uncommitted changes; refusing to operate on a dirty working tree`,
          [
            {
              description: "commit or stash the changes first",
              flag: "<git commit>   or   <git stash>",
            },
            {
              description: "proceed anyway — you take the risk",
              flag: "--accept-dirty",
            },
          ],
          "--accept-dirty or clean the working tree",
        );
      }
    }
  }

  // INT-03: target exists, is ours, but subcommand is `build`.
  //
  // Resume escape hatch: if the target carries an in-progress build
  // (pending Tier 2 batches and/or a `build-*` workdir whose op-id
  // never appeared in the op-log), the user is RESUMING — typically
  // after the wiki-runner wrote responses for an exit-7 batch and
  // re-invoked us. Treat this as a normal sibling build so the
  // orchestrator's idempotent ingest path takes over. We only allow
  // the bypass when the target shows a build-shaped incomplete state;
  // a healthy completed wiki still trips INT-03.
  if (
    !explicitTarget &&
    subcommand === "build" &&
    existsSync(target) &&
    hasPrivateGit(target) &&
    !f.layout_mode
  ) {
    if (!hasIncompleteBuild(target)) {
      return ambiguous(
        "INT-03",
        `${target} is already a managed wiki; choose an operation`,
        [
          { description: "add new entries from the source", flag: `extend ${rawInput}` },
          { description: "optimise structure in place", flag: `rebuild ${rawInput}` },
          { description: "repair methodology divergences", flag: `fix ${rawInput}` },
        ],
        "pick extend / rebuild / fix",
      );
    }
    // Fall through to the happy path so the orchestrator resumes.
  }

  // Happy path: a plain sibling build/extend/rebuild/fix.
  const isNew = !existsSync(target) || !hasPrivateGit(target);
  return ok({
    operation: subcommand,
    layout_mode: explicitMode || "sibling",
    source: input,
    target,
    is_new_wiki: isNew,
    flags: f,
  });
}

// Format an ambiguity error for human consumption (stderr text mode).
export function formatAmbiguityText(error) {
  const lines = [
    `error: ${error.message}`,
    `(code ${error.code})`,
    "",
    "Options:",
  ];
  for (let i = 0; i < error.options.length; i++) {
    const o = error.options[i];
    lines.push(`  ${i + 1}. ${o.description}`);
    lines.push(`     → ${o.flag}`);
  }
  lines.push("");
  lines.push(`Disambiguating flag: ${error.resolving_flag}`);
  return lines.join("\n") + "\n";
}

// Format an ambiguity error for machine consumption (--json-errors).
export function formatAmbiguityJson(error) {
  return JSON.stringify({ error }, null, 2) + "\n";
}
