// orchestrator-leaf-naming.test.mjs — regression for bug #6 in the
// skill-llm-wiki Opus-review sweep. Leaves under a subdirectory must
// keep their plain filename on disk — no `operations-build.md`-style
// flattened prefix. A flat source must NOT nest leaves under a
// synthetic `general/` bucket (bug #5) — the X.11 root-containment
// invariant replaces that with per-outlier semantically-named
// subcategories (each leaf gets its OWN category, not a shared bucket).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Resolve once, reuse across tests. `new URL(...).pathname` is NOT a
// cross-platform path — on Windows it returns `/D:/a/.../cli.mjs`
// which spawnSync then rewrites to `C:\D:\a\...\cli.mjs` against the
// test's cwd. `fileURLToPath` returns a platform-native absolute
// path on both POSIX and Windows.
const CLI_PATH = fileURLToPath(
  new URL("../../scripts/cli.mjs", import.meta.url),
);
import { draftCategory } from "../../scripts/lib/draft.mjs";
import { findLeafByName } from "../helpers/fs-walk.mjs";

function tmp() {
  return join(
    tmpdir(),
    `skill-llm-wiki-orch-naming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

test("draftCategory: root-level source file returns empty category", () => {
  assert.equal(draftCategory({ source_path: "flat.md" }), "");
});

test("draftCategory: subdirectory source file returns top-level dir", () => {
  assert.equal(draftCategory({ source_path: "operations/build.md" }), "operations");
});

test("build: flat source gets per-outlier subcategories (no `general/` bucket)", () => {
  const parent = tmp();
  try {
    mkdirSync(parent, { recursive: true });
    const src = join(parent, "src");
    mkdirSync(src);
    writeFileSync(join(src, "alpha.md"), "# Alpha\n\nalpha content\n");
    writeFileSync(join(src, "beta.md"), "# Beta\n\nbeta content\n");
    const r = spawnSync("node", [CLI_PATH, "build", src], {
      cwd: parent,
      encoding: "utf8",
      env: { ...process.env, CI: "1", LLM_WIKI_SKIP_CLUSTER_NEST: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "src.wiki");
    // X.11 invariant: no leaf .md at the wiki root. Each outlier lives
    // in its own semantically-named subcategory, not at depth 0.
    assert.ok(
      !existsSync(join(wiki, "alpha.md")),
      "alpha.md must NOT live at wiki root",
    );
    assert.ok(
      !existsSync(join(wiki, "beta.md")),
      "beta.md must NOT live at wiki root",
    );
    // Anti-pattern still forbidden: no shared `general/` bucket.
    assert.ok(
      !existsSync(join(wiki, "general")),
      "there should be no shared `general/` bucket",
    );
    // Each leaf lives SOMEWHERE under the wiki with its plain basename.
    assert.ok(
      findLeafByName(wiki, "alpha.md"),
      "alpha.md reachable somewhere in tree",
    );
    assert.ok(
      findLeafByName(wiki, "beta.md"),
      "beta.md reachable somewhere in tree",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("build: subdirectory source file keeps plain filename (no flattened prefix)", () => {
  const parent = tmp();
  try {
    mkdirSync(parent, { recursive: true });
    const src = join(parent, "src");
    mkdirSync(join(src, "operations"), { recursive: true });
    writeFileSync(
      join(src, "operations", "build.md"),
      "# Build\n\nbuild operation details\n",
    );
    writeFileSync(
      join(src, "operations", "validate.md"),
      "# Validate\n\nvalidate operation details\n",
    );
    // Need at least one more so the build has >1 candidate.
    writeFileSync(join(src, "readme.md"), "# Readme\n\nreadme text\n");
    const r = spawnSync("node", [CLI_PATH, "build", src], {
      cwd: parent,
      encoding: "utf8",
      env: { ...process.env, CI: "1", LLM_WIKI_SKIP_CLUSTER_NEST: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    const wiki = join(parent, "src.wiki");
    assert.ok(
      existsSync(join(wiki, "operations", "build.md")),
      "operations/build.md should exist with plain filename",
    );
    assert.ok(
      existsSync(join(wiki, "operations", "validate.md")),
      "operations/validate.md should exist with plain filename",
    );
    assert.ok(
      !existsSync(join(wiki, "operations", "operations-build.md")),
      "no `operations-<name>` prefixed file should exist",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
