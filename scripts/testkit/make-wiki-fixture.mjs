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
import { dirname, join } from "node:path";
import { templatesDir } from "../lib/templates.mjs";

// Refuse to write through a pre-existing symlink. Fixture builders
// run in shared tmp dirs; a hostile sibling test could plant a
// symlink and redirect fixture writes elsewhere.
async function refuseSymlink(absPath) {
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) {
      throw new Error(
        `makeWikiFixture: ${absPath} is a symbolic link; refusing to write through it`,
      );
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
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
  await refuseSymlink(path);
  await mkdir(path, { recursive: true });

  // Pick a template. `templatesDir()` returns the absolute path;
  // filenames follow `<name>.llmwiki.layout.yaml`.
  const tmplName = template ?? (kind === "subject" ? "runbooks" : "reports");
  const tmplPath = join(templatesDir(), `${tmplName}.llmwiki.layout.yaml`);
  if (!existsSync(tmplPath)) {
    throw new Error(
      `makeWikiFixture: template "${tmplName}" not found at ${tmplPath}`,
    );
  }
  const contractPath = join(path, CONTRACT_FILENAME);
  await refuseSymlink(contractPath);
  await copyFile(tmplPath, contractPath);

  // Seed any requested leaves. Each entry is either:
  //   { path: "reports/2026/04/18/example.md", body: "..." }
  // or just a plain string `"reports/2026/04/18/example.md"` which
  // seeds a minimal leaf with default frontmatter.
  const createdLeaves = [];
  for (const raw of seedLeaves) {
    const entry =
      typeof raw === "string" ? { path: raw, body: null } : raw;
    const abs = join(path, entry.path);
    await mkdir(dirname(abs), { recursive: true });
    await refuseSymlink(abs);
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
