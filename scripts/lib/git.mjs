// git.mjs — the ONE place in the skill that spawns `git` subprocesses.
//
// Everything runs through a strictly isolated environment so our private
// per-wiki repository at <wiki>/.llmwiki/git/ never reads from, writes to,
// or otherwise interferes with a user's own git repository — even when the
// wiki lives inside their working tree.
//
// Naming note: GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL,
// HOME, GIT_TERMINAL_PROMPT, GIT_OPTIONAL_LOCKS, GIT_AUTHOR_* and
// GIT_COMMITTER_* are git's own environment variables — we cannot rename
// them. They are set only in the per-subprocess `env` option passed to
// spawnSync; they never mutate process.env and never touch the user's
// shell. Skill-owned env vars use the namespaced LLM_WIKI_* prefix.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";
const NULL_DEVICE = IS_WINDOWS ? "NUL" : "/dev/null";

// Per-invocation `-c` flags applied to every git call. These override whatever
// the user (or system) set in their own gitconfig. Duplicated in the env block
// via GIT_CONFIG_* where possible; keeping them as CLI args is defence in depth.
const FORCED_CONFIG_FLAGS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fileMode=false",
  "-c",
  "core.longpaths=true",
];

export function gitDir(wikiRoot) {
  return join(wikiRoot, ".llmwiki", "git");
}

// Keys common to every isolated git invocation — used both by the full
// per-wiki env builder and by the "git --version" probe in preflight.mjs
// so both paths share one source of truth.
export const BASE_ISOLATION_ENV = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
});

// The fixed-timestamp override pins commit author/committer date so two
// runs against the same inputs produce byte-identical commit SHAs.
// Returns ISO 8601 or null when the env var is unset. Throws on malformed
// values so operator mistakes fail loud instead of silently dropping.
// Internal to this module — `gitCommit` is the sole caller.
function resolveFixedTimestamp() {
  const raw = process.env.LLM_WIKI_FIXED_TIMESTAMP;
  if (raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `LLM_WIKI_FIXED_TIMESTAMP must be a positive integer (epoch seconds); got "${raw}"`,
    );
  }
  return new Date(Number(raw) * 1000).toISOString();
}

// The parent `process.env` may contain `GIT_*` variables set by the
// user's shell (e.g. `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_NAMESPACE`,
// `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_SSH_COMMAND`,
// `GIT_AUTHOR_DATE`) that would bypass our isolation contract if we
// spread them verbatim into the subprocess env. Strip every `GIT_*`
// and `SSH_ASKPASS` key at the boundary, then re-populate ONLY the
// keys we explicitly control. This is the D3 fix from the Phase 8
// security sweep.
function sanitisedParentEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_")) continue;
    if (k === "SSH_ASKPASS") continue;
    out[k] = v;
  }
  return out;
}

// Build the isolation env block for a git subprocess. NEVER mutates
// process.env. Exported for test inspection. When `extraEnv` is provided,
// its keys are merged AFTER the base isolation keys, so callers can
// inject per-invocation overrides (e.g. GIT_AUTHOR_DATE for deterministic
// commits) without going around the builder.
export function buildGitEnv(wikiRoot, extraEnv = null) {
  const env = {
    ...sanitisedParentEnv(),
    ...BASE_ISOLATION_ENV,
    GIT_DIR: gitDir(wikiRoot),
    GIT_WORK_TREE: wikiRoot,
    HOME: tmpdir(),
    GIT_AUTHOR_NAME: "skill-llm-wiki",
    GIT_AUTHOR_EMAIL: "noreply@skill-llm-wiki.invalid",
    GIT_COMMITTER_NAME: "skill-llm-wiki",
    GIT_COMMITTER_EMAIL: "noreply@skill-llm-wiki.invalid",
  };
  if (extraEnv) Object.assign(env, extraEnv);
  return env;
}

// Generic git invocation. Returns { status, stdout, stderr } exactly as
// spawnSync, with { encoding: "utf8" } applied and the isolation env.
// Throws with an actionable message if the subprocess failed to spawn
// OR was killed by a signal (so callers never silently continue on
// SIGINT/SIGTERM). `opts.extraEnv` is merged into the env block AFTER
// the standard isolation keys, for per-call overrides like fixed dates.
export function gitRun(wikiRoot, args, opts = {}) {
  const { extraEnv, ...rest } = opts;
  const env = buildGitEnv(wikiRoot, extraEnv);
  const fullArgs = [...FORCED_CONFIG_FLAGS, ...args];
  const result = spawnSync("git", fullArgs, {
    env,
    encoding: "utf8",
    ...rest,
  });
  if (result.error) {
    const err = new Error(
      `git invocation failed to start: ${result.error.message}`,
    );
    err.cause = result.error;
    throw err;
  }
  if (result.signal) {
    const err = new Error(
      `git ${args.join(" ")} killed by signal ${result.signal}`,
    );
    err.signal = result.signal;
    throw err;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Run git and throw on non-zero exit with the stderr attached.
// Every argv element and every stderr line that escapes this
// function runs through `redactUrl` first so embedded credentials
// never surface in shell transcripts, CI logs, or bug reports.
export function gitRunChecked(wikiRoot, args, opts = {}) {
  const r = gitRun(wikiRoot, args, opts);
  if (r.status !== 0) {
    const redactedArgs = redactArgs(args);
    const redactedStderr = redactUrl(r.stderr.trim());
    const err = new Error(
      `git ${redactedArgs.join(" ")} exited ${r.status}\n${redactedStderr}`,
    );
    err.stdout = redactUrl(r.stdout);
    err.stderr = redactUrl(r.stderr);
    err.status = r.status;
    throw err;
  }
  return r;
}

// Lazy init: create the bare repo under .llmwiki/git/ if missing, commit
// an empty genesis tree tagged op/genesis, and install an internal
// info/exclude so `git add -A` never sweeps scratch directories.
//
// Crash-safe: a successful init is marked by the presence of `op/genesis`
// (not merely `.git/HEAD`). If an earlier run crashed part-way through
// setup, the next invocation detects the missing tag and completes the
// setup idempotently. On catastrophic failure during fresh init, the
// partially-created repo is removed so retries start clean.
export function gitInit(wikiRoot) {
  const dir = gitDir(wikiRoot);
  const alreadyInitialized =
    existsSync(join(dir, "HEAD")) && gitRefExists(wikiRoot, "op/genesis");
  if (alreadyInitialized) {
    return { initialized: false, dir };
  }
  // Cleanup: if HEAD exists but op/genesis does not, the prior init was
  // interrupted. Nuke the half-built metadata directory and start over.
  if (existsSync(join(dir, "HEAD"))) {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    mkdirSync(dir, { recursive: true });
    // `git init` discovers $GIT_DIR from the env; --quiet keeps logs clean.
    gitRunChecked(wikiRoot, ["init", "--quiet", "--initial-branch=main"]);
    // Internal exclude — our private repo ignores these even if the user
    // has no wiki-local .gitignore yet.
    const excludePath = join(dir, "info", "exclude");
    mkdirSync(join(dir, "info"), { recursive: true });
    writeFileSync(
      excludePath,
      [
        "# skill-llm-wiki internal exclude — do not edit",
        ".work/",
        ".shape/history/*/work/",
        "",
      ].join("\n"),
      "utf8",
    );
    // Empty genesis commit so we always have a root to rollback to, even
    // against an empty wiki directory. --allow-empty is the only way to
    // commit with no files staged.
    gitCommit(wikiRoot, "genesis", { allowEmpty: true });
    gitTag(wikiRoot, "op/genesis", "HEAD");
  } catch (err) {
    // Clean up the half-built repo so subsequent retries don't see a
    // corrupt state. Rethrow so the caller knows init failed.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; swallow to preserve the original error */
    }
    throw err;
  }
  return { initialized: true, dir };
}

// Create a commit. Timestamp pinning honours LLM_WIKI_FIXED_TIMESTAMP
// (skill-owned env var) for deterministic-SHA rebuilds, else uses the
// ambient wall clock. Malformed LLM_WIKI_FIXED_TIMESTAMP is a hard error
// surfaced from resolveFixedTimestamp — we never silently drop operator
// mistakes.
//
// Runs through gitRunChecked so the full diagnostic detail (stderr,
// cause-chained spawn errors, signal detection) is carried uniformly.
// We do NOT pass --no-verify because core.hooksPath=/dev/null already
// disables hooks at the config layer.
export function gitCommit(wikiRoot, message, opts = {}) {
  const args = ["commit", "--quiet", "-m", message];
  if (opts.allowEmpty) args.push("--allow-empty");
  const extraEnv = {};
  const iso = resolveFixedTimestamp();
  if (iso) {
    extraEnv.GIT_AUTHOR_DATE = iso;
    extraEnv.GIT_COMMITTER_DATE = iso;
  }
  return gitRunChecked(wikiRoot, args, { extraEnv });
}

// Create an annotated-or-lightweight tag. Fails loud on collision by
// default: if `tagName` already exists pointing at a different commit,
// this throws with a clear message so operators never silently overwrite
// a prior op-id's rollback anchor. Pass `{ force: true }` only when the
// caller has verified the rewrite is intentional (e.g., migration).
// Reject refs/specs that would be parseable as a git flag. Every
// helper that accepts a user-controllable ref wraps its argv with an
// end-of-options separator (`--`) AND runs the ref through this guard
// at the boundary so a caller cannot smuggle `--git-dir=elsewhere` or
// similar via a crafted rollback / diff ref. The Phase 8 security
// audit flagged this as D2.
function assertSafeRef(ref, kind) {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error(`${kind}: ref must be a non-empty string`);
  }
  if (ref.startsWith("-")) {
    throw new Error(`${kind}: refs starting with '-' are refused: ${ref}`);
  }
  if (ref.includes("\0") || ref.includes("\n")) {
    throw new Error(`${kind}: control characters in ref: ${JSON.stringify(ref)}`);
  }
}

export function gitTag(wikiRoot, tagName, commitRef = "HEAD", opts = {}) {
  assertSafeRef(tagName, "gitTag tagName");
  assertSafeRef(commitRef, "gitTag commitRef");
  const existing = gitRevParse(wikiRoot, `refs/tags/${tagName}`);
  if (existing !== null) {
    const target = gitRevParse(wikiRoot, commitRef);
    if (existing === target) {
      // Tag already points at the requested commit — idempotent no-op.
      return { status: 0, stdout: "", stderr: "" };
    }
    if (!opts.force) {
      throw new Error(
        `gitTag: refusing to overwrite existing tag "${tagName}" ` +
          `(points at ${existing.slice(0, 12)}, would move to ${String(target).slice(0, 12)}). ` +
          `Pass { force: true } if the rewrite is intentional.`,
      );
    }
  }
  const args = ["tag"];
  if (opts.force) args.push("-f");
  args.push(tagName, commitRef);
  return gitRunChecked(wikiRoot, args);
}

export function gitFsck(wikiRoot) {
  const r = gitRun(wikiRoot, [
    "fsck",
    "--no-dangling",
    "--no-reflogs",
    "--no-progress",
  ]);
  return { ok: r.status === 0, stderr: r.stderr, stdout: r.stdout };
}

export function gitResetHard(wikiRoot, ref) {
  assertSafeRef(ref, "gitResetHard");
  return gitRunChecked(wikiRoot, ["reset", "--hard", "--quiet", ref]);
}

// Remove untracked files introduced since the last commit.
//
// We pass `-fd` (force, include directories) but deliberately OMIT `-x`
// so files matching `.gitignore` and the internal `.git/info/exclude` are
// preserved through a rollback. Specifically, this protects:
//
//   - `.work/`                  — in-flight phase scratch
//   - `.shape/history/*/work/`  — archived per-op scratch
//   - `.llmwiki/`               — the private git repo itself + caches
//
// These paths are the user's "in-flight operation state". Wiping them on
// rollback would defeat resumable pipelines and destroy the op-log. If a
// future phase genuinely needs nuclear clean, add a dedicated helper that
// passes `-x` explicitly rather than changing this one.
export function gitClean(wikiRoot) {
  return gitRunChecked(wikiRoot, ["clean", "-fd", "--quiet"]);
}

// Returns the resolved SHA, or null if the ref cannot be parsed.
export function gitRevParse(wikiRoot, ref) {
  assertSafeRef(ref, "gitRevParse");
  // `rev-parse` does not support `--` as an end-of-options separator
  // before its refs argument; the leading-dash guard above is our only
  // protection, which is why assertSafeRef is mandatory here.
  const r = gitRun(wikiRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export function gitRefExists(wikiRoot, ref) {
  return gitRevParse(wikiRoot, ref) !== null;
}

// Returns the HEAD SHA or null when the repo has no commits yet.
export function gitHeadSha(wikiRoot) {
  return gitRevParse(wikiRoot, "HEAD");
}

// Run `git cat-file -s <spec>` and return the integer byte size, or null
// on failure. Used by the provenance verifier in later phases to read
// source sizes authoritatively from a pinned commit.
export function gitCatFileSize(wikiRoot, spec) {
  assertSafeRef(spec, "gitCatFileSize");
  const r = gitRun(wikiRoot, ["cat-file", "-s", spec]);
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

// ── URL credential redaction ─────────────────────────────────────────
//
// Remote URLs routinely carry embedded credentials for https auth:
//   https://ghp_xxxxx@github.com/owner/repo.git
//   https://user:token@host/repo.git
//
// Any code path that echoes a URL — error messages composed from
// argv, success lines that report "remote X added (Y)", log output
// — MUST run the URL through `redactUrl` first. A leaked token in
// a shell transcript or CI log is a credential-disclosure incident
// the skill is obligated to prevent.
//
// `redactArgs` applies the same redaction to every element of an
// argv array, preserving non-URL elements untouched. Used by
// `gitRunChecked`'s error-message builder.
export function redactUrl(value) {
  if (typeof value !== "string") return value;
  // Match URLs with userinfo: `scheme://user[:pass]@host...`. The
  // replacement preserves scheme + host + path, stripping only the
  // `user[:pass]@` component.
  return value.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi,
    "$1<redacted>@",
  );
}

export function redactArgs(args) {
  return args.map((a) => redactUrl(a));
}

// ── Remote mirroring helpers (Phase 7) ───────────────────────────────
//
// Every remote operation flows through the isolation env like every
// other git call — the remote can be anywhere (local bare repo, ssh,
// https) and the subprocess still inherits `GIT_DIR`, `GIT_CONFIG_*`,
// `HOME=tmpdir()`, etc. The user's own `~/.gitconfig` credentials,
// signing keys, and push templates are NOT consulted; auth must flow
// via the URL or an out-of-band credential helper the user sets up
// explicitly. `GIT_TERMINAL_PROMPT=0` (already in the base env)
// prevents any password prompt from blocking a pipeline.
//
// By design:
//   - We never auto-push. `gitPush` is only reachable via the
//     `skill-llm-wiki sync` subcommand, which the user invokes
//     explicitly.
//   - We push tag refs by default, not branch heads, so a shared
//     remote becomes a read-only history mirror rather than a
//     competing HEAD.
//   - We never fetch with --depth (shallow clones lose op history).

export function gitRemoteAdd(wikiRoot, name, url) {
  if (!name || typeof name !== "string") {
    throw new Error("gitRemoteAdd: remote name must be a non-empty string");
  }
  if (!url || typeof url !== "string") {
    throw new Error("gitRemoteAdd: remote url must be a non-empty string");
  }
  return gitRunChecked(wikiRoot, ["remote", "add", name, url]);
}

export function gitRemoteRemove(wikiRoot, name) {
  if (!name || typeof name !== "string") {
    throw new Error("gitRemoteRemove: remote name must be a non-empty string");
  }
  return gitRunChecked(wikiRoot, ["remote", "remove", name]);
}

// List configured remotes as `{ name, url, fetch, push }` records.
// Parses `git remote -v` output which is the authoritative form.
// Returns an empty array when no remotes are configured.
export function gitRemoteList(wikiRoot) {
  const r = gitRun(wikiRoot, ["remote", "-v"]);
  // Defence-in-depth: redact any URL-looking content in stderr on
  // failure, in case a corrupt config surfaces a remote URL in the
  // error stream.
  if (r.status !== 0) {
    throw new Error(
      `gitRemoteList: git remote -v exited ${r.status}: ${redactUrl(
        r.stderr.trim(),
      )}`,
    );
  }
  const out = new Map();
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    if (line === "") continue;
    // `origin\thttps://.../repo.git (fetch)` or `(push)`
    const m = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const [, name, url, kind] = m;
    if (!out.has(name)) out.set(name, { name, fetch: null, push: null });
    out.get(name)[kind] = url;
  }
  return Array.from(out.values());
}

export function gitFetch(wikiRoot, remoteName = "origin") {
  return gitRunChecked(wikiRoot, ["fetch", "--tags", "--no-recurse-submodules", remoteName]);
}

// Push tag refs to the remote. Defaults to pushing every `op/*` and
// `pre-op/*` tag in the private repo — the op history we want
// mirrored. Branch heads are explicitly NOT pushed by default; the
// caller must pass `refspecs` to push a branch.
export function gitPush(wikiRoot, remoteName = "origin", opts = {}) {
  const { refspecs = ["refs/tags/op/*", "refs/tags/pre-op/*"], force = false } = opts;
  const args = ["push"];
  if (force) args.push("--force");
  args.push(remoteName, ...refspecs);
  return gitRunChecked(wikiRoot, args);
}

// Check whether the working tree has any tracked changes (staged or not).
// Returns true when `git diff --cached --quiet && git diff --quiet` would
// report a clean tree. Used by snapshot.mjs to avoid empty commits.
export function gitWorkingTreeClean(wikiRoot) {
  const cached = gitRun(wikiRoot, ["diff", "--cached", "--quiet"]);
  if (cached.status === 1) return false;
  if (cached.status !== 0) {
    throw new Error(
      `git diff --cached exited ${cached.status}: ${cached.stderr.trim()}`,
    );
  }
  const unstaged = gitRun(wikiRoot, ["diff", "--quiet"]);
  if (unstaged.status === 1) return false;
  if (unstaged.status !== 0) {
    throw new Error(
      `git diff exited ${unstaged.status}: ${unstaged.stderr.trim()}`,
    );
  }
  return true;
}
