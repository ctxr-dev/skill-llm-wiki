// preflight.mjs — centralized runtime checks invoked from cli.mjs and
// any long-running phase that wants defence-in-depth against a broken
// environment.
//
// Exit codes (kept consistent with cli.mjs):
//   4 — Node too old / missing
//   5 — git missing / too old
//   6 — wiki present but corrupt (git fsck failed)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BASE_ISOLATION_ENV, gitFsck } from "./git.mjs";

export const REQUIRED_NODE_MAJOR = 18;
export const REQUIRED_GIT_MAJOR = 2;
export const REQUIRED_GIT_MINOR = 25;

// Parse `vX.Y.Z` → { major, minor }. Returns null on malformed input.
function parseNodeVersion(raw) {
  const m = /^v(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Parse `git version 2.25.1 (Apple Git-133)` → { major, minor }.
function parseGitVersion(raw) {
  const m = /git version (\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Returns { ok: true } on success, otherwise { ok: false, message, exitCode }.
export function preflightNode() {
  const raw = (process && process.version) || "";
  const v = parseNodeVersion(raw);
  if (!v || v.major < REQUIRED_NODE_MAJOR) {
    return {
      ok: false,
      exitCode: 4,
      message:
        `skill-llm-wiki: Node.js ${raw || "<unknown>"} is below the required ` +
        `minimum (v${REQUIRED_NODE_MAJOR}.0.0).\n` +
        "Please upgrade Node.js and retry. See SKILL.md " +
        "'Preflight: verify Node.js is installed' for platform-specific " +
        "install instructions.\n",
    };
  }
  return { ok: true, version: v };
}

// Returns { ok: true, version } when git is present and new enough, otherwise
// { ok: false, exitCode, message }. Spawns `git --version` with an isolated
// env so a user with GIT_* env vars set cannot redirect it. Reuses
// BASE_ISOLATION_ENV from git.mjs so this preflight probe and the main
// subprocess path stay in lockstep (including the Windows NUL override).
// The parent `process.env` is filtered to drop every `GIT_*` / `SSH_ASKPASS`
// key before the isolation block is applied, matching `buildGitEnv` (D3).
function preflightGitEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_")) continue;
    if (k === "SSH_ASKPASS") continue;
    out[k] = v;
  }
  return { ...out, ...BASE_ISOLATION_ENV };
}

export function preflightGit() {
  const result = spawnSync("git", ["--version"], {
    encoding: "utf8",
    env: preflightGitEnv(),
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      exitCode: 5,
      message:
        "skill-llm-wiki: `git` binary not found on PATH.\n" +
        `Please install Git >= ${REQUIRED_GIT_MAJOR}.${REQUIRED_GIT_MINOR}.\n` +
        "macOS:    brew install git\n" +
        "Debian:   sudo apt-get install git\n" +
        "Fedora:   sudo dnf install git\n" +
        "Windows:  https://git-scm.com/download/win\n",
    };
  }
  const raw = (result.stdout || "").trim();
  const v = parseGitVersion(raw);
  if (!v) {
    return {
      ok: false,
      exitCode: 5,
      message: `skill-llm-wiki: unable to parse git version from "${raw}"\n`,
    };
  }
  if (
    v.major < REQUIRED_GIT_MAJOR ||
    (v.major === REQUIRED_GIT_MAJOR && v.minor < REQUIRED_GIT_MINOR)
  ) {
    return {
      ok: false,
      exitCode: 5,
      message:
        `skill-llm-wiki: Git ${v.major}.${v.minor} is below the required minimum ` +
        `(${REQUIRED_GIT_MAJOR}.${REQUIRED_GIT_MINOR}).\n` +
        "Please upgrade git and retry.\n",
    };
  }
  return { ok: true, version: v };
}

// Optional check: when pointed at an existing wiki, run git fsck inside
// the private repo to catch object corruption early. If `.llmwiki/git/`
// does not exist, this is a no-op success — the wiki predates git tracking.
export function preflightWiki(wikiRoot) {
  if (!existsSync(join(wikiRoot, ".llmwiki", "git", "HEAD"))) {
    return { ok: true, reason: "no-private-git" };
  }
  const r = gitFsck(wikiRoot);
  if (!r.ok) {
    return {
      ok: false,
      exitCode: 6,
      message:
        `skill-llm-wiki: private git repo at ${wikiRoot}/.llmwiki/git/ ` +
        `failed integrity check:\n${r.stderr.trim() || r.stdout.trim()}\n`,
    };
  }
  return { ok: true };
}

// Run the mandatory Node + Git preflight and exit on failure. Intended to
// be called once at CLI startup. Split into a helper so phase-level code
// can call it mid-operation if it wants extra paranoia.
export function preflightOrExit({ requireGit = true } = {}) {
  const n = preflightNode();
  if (!n.ok) {
    process.stderr.write(n.message);
    process.exit(n.exitCode);
  }
  if (requireGit) {
    const g = preflightGit();
    if (!g.ok) {
      process.stderr.write(g.message);
      process.exit(g.exitCode);
    }
  }
}
