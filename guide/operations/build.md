# Build

**Purpose:** create a new wiki from source(s).

## Phases

0. **preflight** — Node.js preflight (see SKILL.md). Stop and relay user-facing message if it fails.
1. **check-mode** — `test -f <target>/.llmwiki.layout.yaml` if the user gave you a target; otherwise default to free mode with sibling output.
2. **validate-contract** (hosted only) — parse the contract and verify the schema rules from `guide/layout-contract.md`.
3. **ingest** — `node scripts/cli.mjs ingest <source>` → JSON array of candidates. Save to `<wiki>/.work/ingest/candidates.json`.
4. **classify** — for each candidate, assign a category path. Free mode: cluster by similarity (use `draft-category` as a first-pass heuristic, fall back to your own semantic clustering for prose-heavy sources with no taxonomy). Hosted mode: map each candidate to one of the contract's `layout[].path` entries by matching candidate content against each directory's `purpose` + `content_rules`. If no contract directory fits, escalate to HUMAN (tell the user which candidates couldn't be placed and why).
5. **draft-frontmatter** — for each candidate, run `node scripts/cli.mjs draft-leaf` to get a script-first draft with a confidence score. If `needs_ai: true` or confidence is below your threshold, read the source file via `Read` and rewrite `focus` and `covers[]` into strong, concrete statements. Save each final frontmatter under `<wiki>/.work/frontmatter/<id>.yaml`.
6. **layout** — create the target version directory (`node scripts/cli.mjs next-version <source>` for free mode; for hosted mode create `<target>/` if empty or use the existing directory). Materialize each entry as `<wiki>/<category>/<id>.md` using the Write tool, combining drafted frontmatter + original body.
7. **operator-convergence** — apply the four rewrite operators (see `guide/operators.md`) in priority order. In hosted mode, check each proposed application against the contract before accepting. Record each application to `<wiki>/.work/operators/applied.yaml`. Stop when no operator reports a change.
8. **index-generation** — `node scripts/cli.mjs index-rebuild <wiki>` to emit `index.md` at every directory.
9. **validation** — `node scripts/cli.mjs validate <wiki>`. If any hard invariant fails, fix the offending frontmatter and re-run. Do not commit until validation returns 0 errors.
10. **golden-path** (optional) — if the user provided fixture queries, establish a baseline by routing each through the new wiki and recording the load set. Save to `<wiki>/.work/golden-path/baseline.yaml`.
11. **commit** — free mode: `node scripts/cli.mjs set-current <source> v<N>` to flip the current-pointer. Hosted mode in-place: the files are already in place; just archive `<wiki>/.work/` to `<wiki>/.shape/history/build-<timestamp>/`.

## Notes

- Build is idempotent in free mode given the same source and seed.
- The `--with-ai` threshold for draft-frontmatter confidence is your judgement call — prefer reading the source and writing strong frontmatter yourself for prose-heavy corpora.
- For Build against an empty hosted target, the contract file must already exist — if it doesn't, stop and ask the user whether they want free mode or want to draft a contract first.
