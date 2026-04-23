// fs-walk.mjs — shared filesystem-walk helpers for tests.
//
// The X.11 root-containment invariant (Phase 4.4.5) moves flat-source
// outlier leaves into per-slug subcategories deterministically but with
// slug names derived from content — tests can't hardcode the final
// location of a leaf built from a flat source. Before X.11 these tests
// used `join(wiki, leafname)` directly; after X.11 they all need to
// search the tree for the leaf's current path.
//
// `findLeafByName(wikiRoot, name)` walks the wiki (skipping dotfiles)
// and returns the absolute path of the first `.md` file whose basename
// matches `name`, or `null` if no such file exists. Stack-based DFS
// avoids recursion depth limits on deep trees. Dotfile skip matches
// the blanket rule used by `listChildren`, `buildWikiForbiddenIndex`,
// `collectEntryPaths`, and every other wiki-walker in this codebase.

import { readdirSync } from "node:fs";
import { join } from "node:path";

export function findLeafByName(wikiRoot, name) {
  const stack = [wikiRoot];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === name) return full;
    }
  }
  return null;
}
