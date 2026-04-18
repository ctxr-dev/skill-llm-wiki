// stub-skill.mjs — testkit helper: seed a presence-only
// @ctxr/skill-llm-wiki install at a kit-canonical path under the
// caller-supplied base directory.
//
// Consumers use this in their test suites to satisfy the "is the
// skill installed?" preflight without needing a real skill
// checkout. The stub is NOT a working skill — it only carries the
// SKILL.md frontmatter consumers typically grep for. For richer
// test fixtures (a real hosted wiki), see make-wiki-fixture.mjs.
//
// Zero runtime deps; pure Node built-ins.

import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The kit's ARTIFACT_TYPES.skill enumerates these install layouts.
// Consumers pick the one their test environment emulates.
const LAYOUTS = {
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
};

export const STUB_SKILL_NAME = "ctxr-skill-llm-wiki";

export async function stubSkill({ home, layout = "claude-skills" } = {}) {
  if (!home || typeof home !== "string") {
    throw new Error(
      "stubSkill: { home } is required (the base directory under which the stub install tree is seeded)",
    );
  }
  const parts = LAYOUTS[layout];
  if (!parts) {
    const known = Object.keys(LAYOUTS).join(", ");
    throw new Error(
      `stubSkill: unknown layout "${layout}". Known: ${known}`,
    );
  }
  const dir = join(home, ...parts, STUB_SKILL_NAME);
  // Refuse to follow a pre-existing symlink at the stub directory.
  // Test harnesses run in shared tmp dirs; a hostile fixture in
  // CI could plant a symlink here and redirect writeFile elsewhere.
  try {
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new Error(
        `stubSkill: ${dir} is a symbolic link; refusing to write through it`,
      );
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await mkdir(dir, { recursive: true });
  const skillMd = join(dir, "SKILL.md");
  // Same guard on the file itself.
  try {
    const st = await lstat(skillMd);
    if (st.isSymbolicLink()) {
      throw new Error(
        `stubSkill: ${skillMd} is a symbolic link; refusing to overwrite through it`,
      );
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const body = [
    "---",
    "name: skill-llm-wiki",
    "description: test stub of @ctxr/skill-llm-wiki — presence-only, not a working skill",
    "format_version: 1",
    "---",
    "",
    "This is a test stub. Do not invoke wiki operations against it.",
    "",
  ].join("\n");
  await writeFile(skillMd, body, "utf8");
  return { dir, skillMd, layout };
}
