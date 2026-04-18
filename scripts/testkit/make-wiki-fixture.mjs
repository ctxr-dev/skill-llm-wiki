// make-wiki-fixture.mjs — testkit helper: build a minimal hosted-
// mode wiki at a caller-supplied path using the skill's shipped
// starter templates. Useful for consumer tests that need a
// plausible wiki shape to read against without running the full
// build pipeline.
//
// What this does NOT do: invoke the full orchestrator. It seeds the
// layout contract and optionally writes seed leaves the consumer
// asks for. That is enough for consumers whose tests read/write
// frontmatter; for tests that exercise validate/fix/rebuild,
// consumers should `spawn` the CLI via cli-run.mjs.
//
// Zero runtime deps; pure Node built-ins.

import {
  copyFile,
  lstat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { templatesDir } from "../lib/templates.mjs";

// Reject any seed-leaf path that would escape the fixture root via
// an absolute path or `..` traversal. This is a LEXICAL check; it
// does not detect symlink-based escapes inside the fixture tree.
// For those, see `refuseSymlink` below, which walks every path
// segment from the root down to the leaf and rejects if any is a
// symbolic link. Together the two functions defend against:
//   - absolute seed paths
//   - `..` segments that resolve outside the root
//   - symlinks anywhere in the resolved path's intermediate
//     directories (e.g. `<root>/sub -> /etc/`)
function assertInsideRoot(rootAbs, entryRel) {
  if (typeof entryRel !== "string" || entryRel.length === 0) {
    throw new Error("makeWikiFixture: seedLeaves entries must have a non-empty path");
  }
  if (isAbsolute(entryRel)) {
    throw new Error(
      `makeWikiFixture: seed-leaf path "${entryRel}" must be relative to the fixture root`,
    );
  }
  const resolved = resolve(rootAbs, entryRel);
  const rel = relative(rootAbs, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `makeWikiFixture: seed-leaf path "${entryRel}" resolves outside the fixture root`,
    );
  }
  return resolved;
}

// Refuse to write through a pre-existing symlink.
//
// When called with a single `absPath` (no `rootAbs`), only that
// path is checked — useful for the one-time fixture-root probe,
// where climbing further up the chain would trip macOS's
// /var → /private/var (or similar OS-level symlinks that are NOT
// a fixture concern).
//
// When called with `rootAbs`, every segment from rootAbs down to
// absPath is checked. A lexical `assertInsideRoot` check can be
// bypassed by planting a symlinked sub-directory inside the
// fixture (e.g. `<root>/sub -> /etc/`) and then passing a
// seedLeaves entry like `sub/passwd`; walking every segment
// closes that.
//
// Non-existent segments are accepted (mkdir/writeFile will create
// them).
async function refuseSymlink(absPath, rootAbs = null) {
  const segments = [];
  if (rootAbs) {
    // Build segment list from rootAbs DOWN to absPath so we only
    // inspect paths inside the fixture. Never climb past rootAbs.
    segments.push(rootAbs);
    if (absPath !== rootAbs) {
      const rel = relative(rootAbs, absPath);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        const parts = rel.split(/[\\/]/).filter(Boolean);
        let cursor = rootAbs;
        for (const part of parts) {
          cursor = join(cursor, part);
          segments.push(cursor);
        }
      }
    }
  } else {
    segments.push(absPath);
  }
  for (const seg of segments) {
    try {
      const st = await lstat(seg);
      if (st.isSymbolicLink()) {
        throw new Error(
          `makeWikiFixture: ${seg} is a symbolic link; refusing to write through it`,
        );
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // Segment doesn't exist yet — that's fine for mkdir's path.
    }
  }
}

export const CONTRACT_FILENAME = ".llmwiki.layout.yaml";

export async function makeWikiFixture({
  path,
  kind = "dated",
  template = null,
  seedLeaves = [],
} = {}) {
  if (!path || typeof path !== "string") {
    throw new Error("makeWikiFixture: { path } is required");
  }
  const rootAbs = resolve(path);
  // Root-level check: refuse if the fixture root path ITSELF is a
  // pre-existing symlink. We intentionally do NOT walk parent
  // directories above rootAbs here; OS-level symlinks in the path
  // above the tmp dir (e.g. macOS's /var → /private/var) are a
  // user-environment concern, not a fixture concern, and flagging
  // them would fail every test on macOS. Subsequent
  // refuseSymlink calls pass rootAbs so they inspect every
  // segment INSIDE the fixture tree.
  await refuseSymlink(rootAbs);
  await mkdir(rootAbs, { recursive: true });

  // Pick a template. `templatesDir()` returns the absolute path;
  // filenames follow `<name>.llmwiki.layout.yaml`.
  const tmplName = template ?? (kind === "subject" ? "runbooks" : "reports");
  const tmplPath = join(templatesDir(), `${tmplName}.llmwiki.layout.yaml`);
  if (!existsSync(tmplPath)) {
    throw new Error(
      `makeWikiFixture: template "${tmplName}" not found at ${tmplPath}`,
    );
  }
  const contractPath = join(rootAbs, CONTRACT_FILENAME);
  await refuseSymlink(contractPath, rootAbs);
  await copyFile(tmplPath, contractPath);

  // Seed any requested leaves. Each entry is either:
  //   { path: "reports/2026/04/18/example.md", body: "..." }
  // or just a plain string `"reports/2026/04/18/example.md"` which
  // seeds a minimal leaf with default frontmatter.
  const createdLeaves = [];
  for (const raw of seedLeaves) {
    const entry =
      typeof raw === "string" ? { path: raw, body: null } : raw;
    // Refuse any seed path that escapes the fixture root. Caller
    // bugs (typos, absolute paths) are caught loudly before any
    // write happens.
    const abs = assertInsideRoot(rootAbs, entry.path);
    await mkdir(dirname(abs), { recursive: true });
    // Walk every intermediate segment (rootAbs ... abs) so a
    // pre-existing symlinked sub-dir inside the fixture can't
    // redirect the write.
    await refuseSymlink(abs, rootAbs);
    const body = entry.body ?? defaultLeafBody(entry.path);
    await writeFile(abs, body, "utf8");
    createdLeaves.push(abs);
  }

  return {
    path,
    template: tmplName,
    kind,
    contract_path: contractPath,
    seeded_leaves: createdLeaves,
  };
}

function defaultLeafBody(relativePath) {
  const segments = relativePath.split(/[\\\/]/).filter(Boolean);
  const basename = segments[segments.length - 1] ?? "leaf.md";
  const id = basename.replace(/\.md$/, "");
  return [
    "---",
    `id: ${id}`,
    "type: primary",
    "depth_role: leaf",
    `focus: "${id}"`,
    "covers: []",
    "parents: [../index.md]",
    "tags: []",
    `source:`,
    `  origin: file`,
    `  path: ${relativePath}`,
    "---",
    "",
    `# ${id}`,
    "",
    "Fixture leaf body.",
    "",
  ].join("\n");
}
