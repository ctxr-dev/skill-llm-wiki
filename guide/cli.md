# CLI subcommand reference

All subcommands are invoked via `node scripts/cli.mjs <subcommand> [args]`. Never read the source of any `.mjs` file — everything you need is documented here.

The CLI exits with code 4 and a short message if invoked on Node.js < 18.0.0. This is defense-in-depth only — always run the Bash preflight from SKILL.md first so the user sees the detailed, actionable message.

## `ingest <source>`

Walks a source directory, computes content hashes, emits an array of entry candidates.

- **Input:** `<source>` = absolute or relative path to a directory.
- **Output (stdout, JSON):** `{ "candidates": [ {id, source_path, absolute_path, ext, size, hash, kind, title, lead, headings}, … ] }` where:
  - `id`: kebab-case id derived from path
  - `source_path`: path relative to the source root
  - `hash`: `sha256:<hex>` content hash
  - `kind`: `prose` or `code`
  - `title`: first H1 or filename fallback
  - `lead`: first paragraph (up to 400 chars)
  - `headings`: array of `{level, text}` for every H1–H6
- **Exit codes:** 0 on success.
- **Determinism:** walk order is sorted by path.

## `draft-leaf <candidate-file>`

Script-first frontmatter draft for a single candidate. Takes a JSON file containing one candidate (as produced by `ingest`).

- **Input:** `<candidate-file>` = path to a JSON file with one candidate object.
- **Output (stdout, JSON):** `{ "data": <frontmatter-object>, "confidence": <0..1>, "needs_ai": <boolean> }`. If `needs_ai: true`, you must read the source file yourself and rewrite `focus` and `covers[]`.
- **Exit codes:** 0 on success.

## `draft-category <candidate-file>`

Deterministic category hint by directory prefix. Cheap first-pass classifier.

- **Input:** same as `draft-leaf`.
- **Output (stdout):** single-line category slug.
- **Exit codes:** 0 on success.

## `index-rebuild <wiki>`

Regenerate every `index.md` in a wiki, bottom-up. Preserves authored frontmatter fields and authored body content; replaces derived fields and the auto-generated navigation zone.

- **Input:** `<wiki>` = path to a wiki root (must contain an `index.md` with `generator: skill-llm-wiki/v1`).
- **Output (stdout):** one line summary: `rebuilt N index.md files`.
- **Exit codes:** 0 on success; non-zero on any error.
- **Safety:** the script verifies the root carries the generator marker before mutating anything. Running against a non-wiki directory is a no-op error.

## `index-rebuild-one <dir> <wiki>`

Rebuild a single directory's `index.md`. Useful for targeted refreshes.

- **Input:** `<dir>` = directory to rebuild; `<wiki>` = wiki root.
- **Output (stdout):** `rebuilt <path>`.
- **Exit codes:** 0 on success.

## `validate <wiki>`

Run all hard invariants against a wiki. Read-only.

- **Input:** `<wiki>` = wiki root.
- **Output (stdout):** one `[TAG] CODE  path` line per finding, then a summary `N error(s), M warning(s)`.
- **Exit codes:** 0 = clean, 2 = errors. Warnings do not affect exit code.

## `shape-check <wiki>`

Detect operator candidates and write findings to `<wiki>/.shape/suggestions.md`. Also updates the root `index.md` `rebuild_needed` flag when pending suggestions cross the configured threshold.

- **Input:** `<wiki>` = wiki root.
- **Output (stdout):** `N pending shape candidate(s)` followed by one `  OPERATOR  target / reason` entry per candidate.
- **Exit codes:** 0 on success.

## `resolve-wiki <source>`

Print the current live wiki path for a source (reads the current-pointer file).

- **Input:** `<source>` = source folder path.
- **Output (stdout):** absolute path to current live wiki, e.g. `/path/to/docs.llmwiki.v2`.
- **Exit codes:** 0 if a wiki exists, 3 if no wiki has been built yet.

## `next-version <source>`

Print the next version tag for a source (used when creating a new version).

- **Input:** `<source>`.
- **Output (stdout):** next tag, e.g. `v3`.
- **Exit codes:** 0.

## `list-versions <source>`

List all existing versioned wikis for a source.

- **Input:** `<source>`.
- **Output (stdout):** one `<tag>\t<absolute-path>` per existing version, sorted ascending.
- **Exit codes:** 0.

## `set-current <source> <version>`

Update the current-pointer file.

- **Input:** `<source>`, `<version>` (e.g. `v2`).
- **Output (stdout):** `current → v2`.
- **Exit codes:** 0.

## `--version` / `--help`

Print the CLI version string or a condensed command list.

## Exit code summary

- **0** — success
- **1** — usage error (missing/bad arguments, unknown subcommand)
- **2** — validation errors (hard invariants failed)
- **3** — resolve-wiki could not find an existing wiki for the given source
- **4** — Node.js is present but below the required minimum (defense-in-depth runtime guard)
