// migrate.mjs — move a legacy `<source>.llmwiki.v<N>/` wiki into the new
// `<source>.wiki/` sibling layout with a private git repo and an op-log
// entry recording the migration lineage.
//
// Atomicity guarantees:
//   1. The legacy folder is read-only to this module — never mutated,
//      byte-identical before and after (success OR failure).
//   2. The destination is cleaned up on ANY exception between mkdirSync
//      and the final commit. The user never has to manually rm a
//      half-built sibling before retrying.
//   3. If the destination existed before this call (the caller should
//      have refused via intent.mjs's INT-01 check, but defence in depth),
//      we never touch it on failure — we only nuke directories this
//      call created.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appendOpLog } from "./history.mjs";
import { ensureWikiGitignore } from "./gitignore.mjs";
import {
  gitCommit,
  gitHeadSha,
  gitInit,
  gitRunChecked,
  gitTag,
} from "./git.mjs";

// Match legacy folder names of the form `<anything>.llmwiki.v<digits>`
// and extract the version integer. Returns null for non-matching inputs.
function parseLegacyVersion(legacyPath) {
  const m = /\.llmwiki\.v(\d+)$/.exec(basename(legacyPath));
  return m ? Number(m[1]) : null;
}

// Build the default migration destination for a legacy wiki.
// `<parent>/<base>.llmwiki.v3` → `<parent>/<base>.wiki`.
export function defaultMigrationTarget(legacyPath) {
  const parent = dirname(legacyPath);
  const name = basename(legacyPath);
  const cleanName = name.replace(/\.llmwiki\.v\d+$/, "");
  return join(parent, `${cleanName}.wiki`);
}

// Migrate a legacy wiki. Parameters:
//   legacyPath    absolute path to `<source>.llmwiki.v<N>/`
//   newWikiPath   absolute path to the new sibling destination
//   opts.opId     op-id string for the migration (caller-supplied so the
//                 surrounding CLI can correlate with its op-log record)
//
// Returns { opId, version, sha } on success.
// Throws if legacyPath is not a legacy wiki, or if newWikiPath already
// exists (collision resolution is the caller's job).
export function migrateLegacyWiki(legacyPath, newWikiPath, opts = {}) {
  const version = parseLegacyVersion(legacyPath);
  if (version === null) {
    throw new Error(
      `migrate: ${legacyPath} does not match the legacy .llmwiki.v<N> naming convention`,
    );
  }
  if (!existsSync(legacyPath)) {
    throw new Error(`migrate: legacy wiki ${legacyPath} does not exist`);
  }
  if (existsSync(newWikiPath)) {
    throw new Error(
      `migrate: destination ${newWikiPath} already exists; pick a new target or remove it first`,
    );
  }
  if (!opts.opId || typeof opts.opId !== "string") {
    throw new Error("migrate: opts.opId is required");
  }
  // The destination must not pre-exist. We check and throw here — AFTER
  // this point, any directory at `newWikiPath` was created by this
  // specific call, so failure-cleanup can rmSync it unconditionally
  // without fear of destroying an unrelated pre-existing directory.
  if (existsSync(newWikiPath)) {
    throw new Error(
      `migrate: destination ${newWikiPath} already exists; pick a new target or remove it first`,
    );
  }
  try {
    mkdirSync(newWikiPath, { recursive: true });
    // Copy everything except the legacy sibling's own cruft. The legacy
    // layout never had a `.llmwiki/` subdir of its own, so a full recursive
    // copy is safe. `errorOnExist: false` is the default; explicit for clarity.
    for (const entry of readdirSync(legacyPath, { withFileTypes: true })) {
      cpSync(join(legacyPath, entry.name), join(newWikiPath, entry.name), {
        recursive: true,
        errorOnExist: false,
        force: false,
        preserveTimestamps: true,
      });
    }
    // Initialise the private git repo, stage everything, commit.
    gitInit(newWikiPath);
    ensureWikiGitignore(newWikiPath);
    gitRunChecked(newWikiPath, ["add", "-A"]);
    gitCommit(newWikiPath, `migrate from legacy .llmwiki.v${version}`);
    const tagName = `op/${opts.opId}`;
    gitTag(newWikiPath, tagName, "HEAD");
    const sha = gitHeadSha(newWikiPath);
    appendOpLog(newWikiPath, {
      op_id: opts.opId,
      operation: "migrate",
      layout_mode: "sibling",
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
      base_commit: "legacy",
      final_commit: sha || "",
      summary: `migrated from ${legacyPath} (v${version})`,
    });
    return { opId: opts.opId, version, sha };
  } catch (err) {
    // Atomic-rollback: remove the half-built destination so the user
    // can retry cleanly. Safe to do unconditionally because the
    // pre-existence check above guarantees this call is the one that
    // created `newWikiPath`.
    try {
      rmSync(newWikiPath, { recursive: true, force: true });
    } catch {
      /* best effort — surface the original error anyway */
    }
    throw err;
  }
}

export { parseLegacyVersion };
