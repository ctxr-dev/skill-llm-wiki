// git-commands.mjs — thin passthrough wrappers for the hidden-git
// subcommands exposed to Claude at runtime: log, show, diff, blame,
// reflog, history. These all run against the wiki's private repo via
// the isolation env in git.mjs; no user-git is ever consulted.
//
// The `diff` wrapper has extra sugar: a `--op <id>` flag expands to the
// commit range `pre-op/<id>..op/<id>`, which is the most common user
// question ("what did this operation do?"). Everything else is a plain
// passthrough so users can use their existing knowledge of git flags.
//
// `history <entry-id>` is a higher-level wrapper that walks the op-log
// plus `git log --follow` so Claude can answer "when and why did this
// entry change?" without stitching the two sources together itself.

import { gitRefExists, gitRun, redactUrl } from "./git.mjs";
import { readOpLog } from "./history.mjs";

// Shared: call git with the passed args and stream stdout to the caller.
// Exit code is the git exit code. We return it rather than exiting so
// the CLI can wrap errors in its usual way. stderr is routed through
// `redactUrl` on the off chance a remote URL surfaces in an error
// stream (D5 defence-in-depth from the Phase 8 security sweep).
function runPassthrough(wikiRoot, args) {
  const r = gitRun(wikiRoot, args);
  if (r.stdout) process.stdout.write(redactUrl(r.stdout));
  if (r.stderr) process.stderr.write(redactUrl(r.stderr));
  return r.status ?? 0;
}

// diff <wiki> [--op <id>] [extra git-diff args...]
// Defaults add --find-renames --find-copies so rename detection is on.
export function cmdDiff(wikiRoot, { op, args }) {
  const gitArgs = ["diff", "--find-renames", "--find-copies"];
  if (op) {
    const preTag = `pre-op/${op}`;
    const finalTag = `op/${op}`;
    if (!gitRefExists(wikiRoot, preTag)) {
      process.stderr.write(
        `diff: tag ${preTag} not found in ${wikiRoot}/.llmwiki/git\n`,
      );
      return 2;
    }
    // If the final tag exists, show pre..final. Otherwise show what has
    // landed since pre (typical during an in-flight operation).
    if (gitRefExists(wikiRoot, finalTag)) {
      gitArgs.push(`${preTag}..${finalTag}`);
    } else {
      gitArgs.push(`${preTag}..HEAD`);
    }
  }
  if (args && args.length > 0) gitArgs.push(...args);
  return runPassthrough(wikiRoot, gitArgs);
}

// log <wiki> [--op <id>] [extra args...]
// Default: one-line oneline view of the op history. `--op <id>` narrows
// the output to the commits between `pre-op/<id>` and `op/<id>` (or
// `pre-op/<id>..HEAD` for an in-flight operation), matching the sugar
// `cmdDiff` already provides. Callers can pass any git-log arg to
// override the default format.
export function cmdLog(wikiRoot, { op, args }) {
  const gitArgs = ["log"];
  let rangeAppended = false;
  if (op) {
    const preTag = `pre-op/${op}`;
    const finalTag = `op/${op}`;
    if (!gitRefExists(wikiRoot, preTag)) {
      process.stderr.write(
        `log: tag ${preTag} not found in ${wikiRoot}/.llmwiki/git\n`,
      );
      return 2;
    }
    const range = gitRefExists(wikiRoot, finalTag)
      ? `${preTag}..${finalTag}`
      : `${preTag}..HEAD`;
    gitArgs.push("--oneline", "--decorate", range);
    rangeAppended = true;
  } else if (!args || args.length === 0) {
    gitArgs.push("--oneline", "--decorate", "--all");
  }
  if (args && args.length > 0) {
    // When --op was passed, still accept extra git-log args after the
    // range; when no --op, the args replace the default shape entirely.
    if (rangeAppended) {
      gitArgs.push(...args);
    } else {
      gitArgs.length = 1;
      gitArgs.push(...args);
    }
  }
  return runPassthrough(wikiRoot, gitArgs);
}

// show <wiki> <ref> [-- <path>]
export function cmdShow(wikiRoot, { ref, args }) {
  if (!ref) {
    process.stderr.write("show: <ref> is required\n");
    return 1;
  }
  return runPassthrough(wikiRoot, ["show", ref, ...(args || [])]);
}

// blame <wiki> <path>
export function cmdBlame(wikiRoot, { path, args }) {
  if (!path) {
    process.stderr.write("blame: <path> is required\n");
    return 1;
  }
  return runPassthrough(wikiRoot, ["blame", ...(args || []), path]);
}

// reflog <wiki>
export function cmdReflog(wikiRoot, { args }) {
  return runPassthrough(wikiRoot, ["reflog", ...(args || [])]);
}

// history <wiki> <entry-id>
// Higher-level: walk the op-log first (so Claude sees the op-level
// lineage), then run `git log --follow` on the entry's current path if
// we can resolve it, catching renames across operations.
export function cmdHistory(wikiRoot, { entryId }) {
  if (!entryId) {
    process.stderr.write("history: <entry-id> is required\n");
    return 1;
  }
  const opLog = readOpLog(wikiRoot);
  process.stdout.write(`# Op-log entries mentioning ${entryId}\n\n`);
  let opHits = 0;
  for (const entry of opLog) {
    const summary = (entry.summary || "").includes(entryId);
    if (summary || entry.op_id.includes(entryId)) {
      opHits++;
      process.stdout.write(
        `${entry.op_id}  ${entry.operation}  ${entry.finished}\n` +
          `  ${entry.summary}\n\n`,
      );
    }
  }
  if (opHits === 0) {
    process.stdout.write("  (no op-log entries match)\n\n");
  }
  process.stdout.write(`# Git history for files matching **/${entryId}.md\n\n`);
  // `git log --follow` needs a path. We don't know the exact path — try
  // the wildcard pattern and fall back to a ref-log search if empty.
  const r = gitRun(wikiRoot, [
    "log",
    "--oneline",
    "--follow",
    "--",
    `*${entryId}.md`,
  ]);
  if (r.stdout) process.stdout.write(r.stdout);
  else process.stdout.write("  (no tracked file matches)\n");
  return 0;
}
