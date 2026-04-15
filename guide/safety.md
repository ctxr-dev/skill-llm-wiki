---
id: safety
type: primary
depth_role: leaf
focus: "safety envelope, phase-commit pipeline, and commit semantics for every operation"
parents:
  - index.md
covers:
  - "source immutability in sibling/hosted modes; in-place mode anchored by pre-op snapshot"
  - ".work/ staging convention: ephemeral phase scratch, deleted at commit-finalize"
  - "per-phase git commits as the durable audit trail on the private repo"
  - "full validator must pass before commit-finalize; otherwise reset to pre-op and preserve prior state"
  - "atomic commit semantics across sibling / in-place / hosted modes via git tags"
  - "rollback to any pre-op/<id> tag via `skill-llm-wiki rollback <wiki> --to pre-<id>`"
  - "backup before structural mutation in hosted mode (backup_before_mutate default true)"
tags:
  - safety
  - pipeline
  - commit
activation:
  keyword_matches:
    - safety
    - envelope
    - commit
    - backup
    - rollback
  tag_matches:
    - mutation
    - any-op
  escalation_from:
    - build
    - extend
    - rebuild
    - fix
    - join
---

# Safety envelope and phased pipeline

Every operation honors these rules. Break any of them and you have broken the skill.

## Hard rules

1. **Sibling / hosted modes: source is immutable.** Never write inside the user's source folder. Ever.
2. **In-place mode: the pre-op snapshot is the rollback anchor.** The user's original content is captured byte-for-byte by `pre-op/<op-id>` before the operation starts, so every change is reversible via `rollback`.
3. **Hosted mode: contract defines the write surface.** Write only into directories the contract permits. Never create directories outside the contract. Never place entries in violation of its rules.
4. **Every phase is a git commit.** The private repo at `<wiki>/.llmwiki/git/` takes a `pre-op/<op-id>` snapshot before the operation starts and commits after every subsequent phase. `git log pre-op/<id>..HEAD` is the complete per-phase audit trail for the operation.
5. **Run the full validator before commit-finalize.** Any hard-invariant violation triggers `git reset --hard pre-op/<id>` + `git clean -fd`. The failed phase commits survive in the reflog for post-mortem; the working tree returns to the pre-op state exactly.
6. **Atomic commit-finalize.** Tagging `op/<op-id>` and appending to the op-log are the last operations. Until the tag exists, the operation is still reversible in one command.
7. **Backup before structural mutation in hosted mode.** If the contract has `backup_before_mutate: true`, snapshot the target tree to `<backup_dir>/<timestamp>/` before Rebuild/Fix/Join apply.

## Phase-commit audit trail and rollback

Every long-running operation runs as a named sequence of phases. Each phase (and each operator-convergence iteration) is a git commit in the private repo at `<wiki>/.llmwiki/git/`, so the complete history of "what the skill did during this operation" is introspectable via `skill-llm-wiki log --op <id>`, `skill-llm-wiki diff --op <id>`, and `skill-llm-wiki reflog <wiki>`. An interrupted operation leaves partial phase commits behind; they survive in the git reflog, and the user can roll back to `pre-op/<id>` in one command to restore the pre-op state exactly.

The `.work/` directory is scratch space used by phases that need to stage intermediate artifacts (candidate JSON, partial plans). It is **not** the durable audit layer — the git commits are. `.work/` is created at the start of an operation and deleted at commit-finalize.

> **Future work.** A true mid-phase resume (`skill-llm-wiki resume <wiki>` that picks up from the last committed phase rather than restarting the whole operation) is scoped but not implemented. The current orchestrator treats a re-invocation after a crash as a fresh operation; the user rolls back to `pre-op/<id>` from the prior attempt, then re-runs.

## Commit semantics by mode

**Sibling mode (default, Phase 2+):**

- Wiki lives at `<source>.wiki/` as a single directory — no version-numbered
  folders. History is tracked by the private git repo at
  `<source>.wiki/.llmwiki/git/`, and rollback is `skill-llm-wiki rollback
  <source>.wiki --to pre-<op-id>` (byte-exact via `git reset --hard`).
- See [guide/layout-modes.md](layout-modes.md) for the full mode matrix and
  [guide/in-place-mode.md](in-place-mode.md) for the in-place variant. Legacy
  `<source>.llmwiki.v<N>/` wikis are detected via **INT-04** and must be
  migrated explicitly with `skill-llm-wiki migrate <legacy-path>` before any
  other operation will run.

**Legacy free mode (pre–Phase 2):**

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
