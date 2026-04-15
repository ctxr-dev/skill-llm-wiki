// gitignore.mjs — the wiki-local `.gitignore` writer.
//
// Every skill-managed wiki ships a root `.gitignore` that hides our
// private metadata (`.llmwiki/`, `.work/`, `.shape/history/*/work/`) from
// any ancestor git repository the user might have wrapped around the
// wiki. The user's own project git thus never accidentally tracks our
// binary objects, but can still commit the wiki's plain-text content
// files as part of the project's history.
//
// Idempotent: a second run on an already-compliant file is a no-op. When
// the file pre-exists with user content, missing skill entries are
// appended in a clearly-marked block so the merge is reviewable.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REQUIRED_GITIGNORE_ENTRIES = Object.freeze([
  ".llmwiki/",
  ".work/",
  ".shape/history/*/work/",
]);

const HEADER_COMMENT =
  "# skill-llm-wiki internal metadata — safe to gitignore in your own project";
const MARKER_COMMENT = "# skill-llm-wiki additions";

// Atomic write: write to a tmp file then rename over the target. A
// crash mid-write leaves either the old file or the new file, never
// a truncated `.gitignore` that would cause the user's own git to
// start tracking `.llmwiki/` on the next commit. D8 defence from the
// Phase 8 security sweep.
function atomicWrite(target, body) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, target);
}

// Write or merge <wiki>/.gitignore so it contains the required lines.
// Returns { created, updated, added } describing what happened.
export function ensureWikiGitignore(wikiRoot) {
  const target = join(wikiRoot, ".gitignore");
  if (!existsSync(target)) {
    const body = [HEADER_COMMENT, ...REQUIRED_GITIGNORE_ENTRIES, ""].join("\n");
    atomicWrite(target, body);
    return { created: true, updated: false, added: [...REQUIRED_GITIGNORE_ENTRIES] };
  }
  const current = readFileSync(target, "utf8");
  const trimmedLines = new Set(
    current.split(/\r?\n/).map((l) => l.trim()),
  );
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter(
    (l) => !trimmedLines.has(l),
  );
  if (missing.length === 0) {
    return { created: false, updated: false, added: [] };
  }
  const prefix = current.endsWith("\n") ? current : current + "\n";
  const appended =
    prefix + "\n" + MARKER_COMMENT + "\n" + missing.join("\n") + "\n";
  atomicWrite(target, appended);
  return { created: false, updated: true, added: missing };
}
