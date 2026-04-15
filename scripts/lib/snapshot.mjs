// snapshot.mjs — create the pre-op snapshot commit that every top-level
// operation anchors rollback to. The snapshot captures every byte of every
// tracked wiki file at the moment before the operation starts.

import {
  gitCommit,
  gitHeadSha,
  gitInit,
  gitRunChecked,
  gitTag,
  gitWorkingTreeClean,
} from "./git.mjs";
import { ensureWikiGitignore } from "./gitignore.mjs";

export { ensureWikiGitignore };

// preOpSnapshot(wikiRoot, opId)
//   1. Ensure the private repo exists (git init + genesis).
//   2. Ensure the wiki-local .gitignore is present.
//   3. git add -A.
//   4. If anything is staged: commit "pre-op <opId>". Otherwise skip commit.
//   5. Tag HEAD as pre-op/<opId>.
//
// Tag naming note: the pre-op anchor lives in the `refs/tags/pre-op/`
// namespace and the final tag lives in `refs/tags/op/`. Keeping them in
// separate ref subdirectories avoids git's "cannot create ref X: X/y
// exists" hierarchy collision — we used to use `op/<id>/pre` + `op/<id>`
// which DO collide because git treats the slash as a directory
// boundary. Rollback's `pre-<op-id>` shorthand resolves to `pre-op/<op-id>`.
//
// Returns { initialized, tag, committed, sha } — `committed` indicates
// whether a new pre-op commit was actually written (skipped when the
// working tree already matched HEAD), and `sha` is the final HEAD SHA
// the tag points at. The tag creation itself is loud on collision: if
// `pre-op/<opId>` already exists pointing elsewhere, gitTag throws
// rather than silently overwriting a prior rollback anchor.
export function preOpSnapshot(wikiRoot, opId) {
  if (!opId || typeof opId !== "string") {
    throw new Error("preOpSnapshot requires a non-empty opId string");
  }
  const init = gitInit(wikiRoot);
  ensureWikiGitignore(wikiRoot);
  gitRunChecked(wikiRoot, ["add", "-A"]);
  const clean = gitWorkingTreeClean(wikiRoot);
  let committed = false;
  if (!clean) {
    gitCommit(wikiRoot, `pre-op ${opId}`);
    committed = true;
  }
  const tag = `pre-op/${opId}`;
  gitTag(wikiRoot, tag, "HEAD");
  const sha = gitHeadSha(wikiRoot);
  return { initialized: init.initialized, tag, committed, sha };
}
