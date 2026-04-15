// sync.mjs — `skill-llm-wiki sync <wiki> [--remote <name>]
//                                          [--push-branch <ref>]`
//
// Explicit, user-invoked object exchange with a configured remote.
// Fetches tags from the remote first (read side), then pushes the
// private repo's `op/*` and `pre-op/*` tags (write side). Nothing is
// ever pushed automatically — `sync` is always a conscious user
// action and the only way to propagate history to a shared location.
//
// By default the push refspec is `refs/tags/op/*` + `refs/tags/
// pre-op/*`, so the remote receives a read-only history mirror
// without any competing `main` branch head. A user who genuinely
// wants to push a branch passes `--push-branch <name>` and takes
// responsibility for that refspec.

import { gitFetch, gitPush, gitRemoteList } from "../lib/git.mjs";

// A branch name that `git` and our refspec interpolation will accept
// without surprise. Refs containing `:`, `+`, `*`, or leading `-` can
// change push semantics (force-push, refspec patterns, flag smuggling),
// so we refuse them at the gate. Matches the conservative subset of
// `git check-ref-format`'s rules that we care about. Phase 8 security
// sweep finding D7.
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function cmdSync(wikiRoot, opts = {}) {
  const { remote = "origin", pushBranch = null, skipFetch = false, skipPush = false } = opts;
  if (!wikiRoot) {
    process.stderr.write("sync: <wiki> is required\n");
    return 1;
  }
  if (pushBranch !== null && !SAFE_BRANCH_RE.test(pushBranch)) {
    process.stderr.write(
      `sync: invalid --push-branch "${pushBranch}" — branch must match ` +
        `[A-Za-z0-9][A-Za-z0-9._/-]*; refusing to build an unsafe refspec.\n`,
    );
    return 1;
  }
  // Verify the remote exists before we start. A typo or missing
  // remote should be a loud "unknown remote" error, not a
  // surprising git fatal from deep in the fetch path.
  let remotes;
  try {
    remotes = gitRemoteList(wikiRoot);
  } catch (err) {
    process.stderr.write(`sync: could not list remotes: ${err.message}\n`);
    return 1;
  }
  const known = new Set(remotes.map((r) => r.name));
  if (!known.has(remote)) {
    process.stderr.write(
      `sync: unknown remote "${remote}" (configured: ${[...known].join(", ") || "none"})\n` +
        "  add one first: skill-llm-wiki remote <wiki> add <name> <url>\n",
    );
    return 1;
  }

  if (!skipFetch) {
    try {
      gitFetch(wikiRoot, remote);
      process.stdout.write(`sync: fetched from ${remote}\n`);
    } catch (err) {
      process.stderr.write(`sync: fetch failed: ${err.message}\n`);
      return 1;
    }
  }

  if (!skipPush) {
    const refspecs = pushBranch
      ? ["refs/tags/op/*", "refs/tags/pre-op/*", `refs/heads/${pushBranch}`]
      : ["refs/tags/op/*", "refs/tags/pre-op/*"];
    try {
      gitPush(wikiRoot, remote, { refspecs });
      process.stdout.write(
        `sync: pushed ${refspecs.join(", ")} to ${remote}\n`,
      );
    } catch (err) {
      process.stderr.write(`sync: push failed: ${err.message}\n`);
      return 1;
    }
  }

  return 0;
}
