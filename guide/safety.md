# Safety envelope and phased pipeline

Every operation honors these rules. Break any of them and you have broken the skill.

## Hard rules

1. **Free mode: source is immutable.** Never write inside the user's source folder. Ever.
2. **Hosted mode: contract defines the write surface.** Write only into directories the contract permits. Never create directories outside the contract. Never place entries in violation of its rules.
3. **Stage in `.work/` before touching the live wiki.** All intermediate artifacts (ingest records, drafted frontmatter, layout plans, validation reports) live under `<wiki>/.work/` during an operation. The live files only change during the commit phase at the end.
4. **Progress manifest before every per-item write.** `<wiki>/.work/progress.yaml` tracks current phase and next item. Flush it after every item so a SIGKILL leaves the run resumable.
5. **Run the full validator before commit.** Any hard-invariant violation aborts. Nothing becomes the new live state until validation is green.
6. **Atomic commit.** The final move into place and the current-pointer flip (free mode) or the snapshot-and-swap (hosted mode) are the last operations. Failure before commit leaves the previous state intact.
7. **Backup before structural mutation in hosted mode.** If the contract has `backup_before_mutate: true`, snapshot the target tree to `<backup_dir>/<timestamp>/` before Rebuild/Fix/Join apply.

## Resumable pipeline

Every long-running operation runs as a named sequence of phases tracked in `<wiki>/.work/progress.yaml`. Each per-item phase writes a checkpoint after every item so an interrupted run resumes deterministically on the next invocation.

The manifest records:

- Current phase name and status (`pending` / `in-progress` / `done`).
- For per-item phases, the last-completed item and the cursor for the next item.
- The source hashes the operation was started with (so you can detect source drift).
- The resolved target wiki path and mode (free vs hosted).

On resume, read the manifest, jump to the current phase, and continue from the cursor. Never restart completed phases unless the user explicitly asks for a clean re-run.

## Commit semantics by mode

**Free mode:**

- New version directory is created alongside the source (e.g. `<source>.llmwiki.v<N+1>/`).
- All staged content is moved atomically into place.
- The current-pointer file is updated (`echo v<N+1> > <source>.llmwiki.current`).
- Previous version remains on disk; rollback is just flipping the pointer back.

**Hosted mode, `versioning.style: in-place`:**

- Before any structural mutation (Rebuild, Fix, Join apply), snapshot the target to `<backup_dir>/<timestamp>/`.
- Apply staged content directly into the contract's directories.
- Rollback is restoring the backup snapshot.

**Hosted mode, `versioning.style: sibling-versioned`:**

- Same as free mode, but content inside each version honors the contract's layout rules.
- The sibling directory is named after the target (not the source), and the current-pointer lives next to it.

In every mode, if validation fails before commit, the `.work/` staging is preserved for the user to inspect but the live wiki is untouched.
