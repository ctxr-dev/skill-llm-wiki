// rollback.mjs — resolve a rollback reference to a concrete git ref,
// verify it exists, then perform `git reset --hard` + `git clean -fd`.
//
// Tag namespace split (see snapshot.mjs): pre-op anchors live under
// `refs/tags/pre-op/<id>` and final tags live under `refs/tags/op/<id>`.
// The two namespaces exist so git's ref hierarchy doesn't collide.
//
// Accepted ref forms:
//   genesis             → op/genesis          (always present after gitInit)
//   <op-id>             → op/<op-id>          (state right after the op)
//   pre-<op-id>         → pre-op/<op-id>      (state just before the op)
//   HEAD, HEAD~N, etc.  → passed through verbatim to git rev-parse
//   pre-op/...          → passed through verbatim
//   op/...              → passed through verbatim

import { gitClean, gitRefExists, gitResetHard, gitRevParse } from "./git.mjs";

// Op-id / bare-ref grammar. Refs that don't look like this are
// rejected outright so they cannot slip through to git as unintended
// command-line flags or path-like expressions.
const BARE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HEAD_REF_RE = /^HEAD(~\d+|\^\d*)?$/;

export function resolveRollbackRef(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("rollback reference must be a non-empty string");
  }
  if (raw.startsWith("-")) {
    throw new Error(`rollback reference must not start with '-': ${raw}`);
  }
  if (raw === "genesis") return "op/genesis";
  if (HEAD_REF_RE.test(raw)) return raw;
  // Namespace-prefixed tags: accept but validate the body.
  if (raw.startsWith("pre-op/")) {
    const rest = raw.slice("pre-op/".length);
    if (!BARE_REF_RE.test(rest)) {
      throw new Error(`rollback: invalid pre-op ref body: ${raw}`);
    }
    return raw;
  }
  if (raw.startsWith("op/")) {
    const rest = raw.slice("op/".length);
    if (!BARE_REF_RE.test(rest)) {
      throw new Error(`rollback: invalid op ref body: ${raw}`);
    }
    return raw;
  }
  if (raw.startsWith("pre-")) {
    const rest = raw.slice("pre-".length);
    if (!BARE_REF_RE.test(rest)) {
      throw new Error(`rollback: invalid pre-<op-id> ref body: ${raw}`);
    }
    return `pre-op/${rest}`;
  }
  // Bare op-id: interpret as "state right after the op finished".
  if (!BARE_REF_RE.test(raw)) {
    throw new Error(`rollback: invalid op-id: ${raw}`);
  }
  return `op/${raw}`;
}

/**
 * Rollback the wiki's working tree to a prior commit, destructively.
 *
 * ⚠ IRREVERSIBLE by itself: this function runs `git reset --hard` and
 * `git clean -fd`, which discards any unsaved working-tree edits and
 * removes untracked files not protected by `.gitignore` / `info/exclude`.
 * Callers should either (a) take a fresh `preOpSnapshot` immediately
 * before invoking this as a belt-and-braces rollback anchor, or (b)
 * prompt the user with the current HEAD SHA so they can recover via
 * `git reflog` on the private repo if they typed the wrong ref.
 *
 * `git clean -fd` omits `-x` intentionally: scratch dirs protected by
 * the internal `.llmwiki/git/info/exclude` (namely `.work/` and
 * `.shape/history/*\/work/`) are preserved through a rollback.
 *
 * @param {string} wikiRoot  Absolute path to the wiki root
 * @param {string} rawRef    One of: "genesis", "<op-id>", "pre-<op-id>",
 *                           "HEAD", "HEAD~N", or any git ref the private
 *                           repo understands.
 * @returns {{ ref: string, sha: string | null }}
 * @throws if the resolved ref does not exist in the private repo
 */
export function rollbackOperation(wikiRoot, rawRef) {
  const ref = resolveRollbackRef(rawRef);
  if (!gitRefExists(wikiRoot, ref)) {
    throw new Error(
      `rollback: ref "${ref}" not found in the wiki's private git repo`,
    );
  }
  const sha = gitRevParse(wikiRoot, ref);
  gitResetHard(wikiRoot, ref);
  gitClean(wikiRoot);
  return { ref, sha };
}
