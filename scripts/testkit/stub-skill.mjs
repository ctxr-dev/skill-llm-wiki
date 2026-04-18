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
import { isAbsolute, join, relative, resolve } from "node:path";
import { FORMAT_VERSION } from "../lib/contract.mjs";

// The kit's ARTIFACT_TYPES.skill enumerates these install layouts.
// Consumers pick the one their test environment emulates.
const LAYOUTS = {
  "claude-skills": [".claude", "skills"],
  "agents-skills": [".agents", "skills"],
};

export const STUB_SKILL_NAME = "ctxr-skill-llm-wiki";

// Walk every segment from `base` (inclusive) down to `target`
// (inclusive), lstat-ing each. Refuse if any segment is a
// symbolic link. Non-existent segments are accepted (they'll be
// created by mkdir). `base` itself is NOT walked further upward:
// we never inspect OS-level directories above the caller-supplied
// home (macOS's /var → /private/var, for example, would false-
// positive otherwise).
//
// Containment is validated with path.resolve + path.relative
// rather than a string-prefix check, so `/tmp/home2/x` is NOT
// misclassified as "under /tmp/home" and path separators /
// trailing slashes don't matter.
async function refuseSymlinkChain(base, target) {
  const baseAbs = resolve(base);
  const targetAbs = resolve(target);
  const segments = [baseAbs];
  if (targetAbs !== baseAbs) {
    const rel = relative(baseAbs, targetAbs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `stubSkill: internal error, target ${target} is not under base ${base}`,
      );
    }
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let cursor = baseAbs;
    for (const part of parts) {
      cursor = join(cursor, part);
      segments.push(cursor);
    }
  }
  for (const seg of segments) {
    try {
      const st = await lstat(seg);
      if (st.isSymbolicLink()) {
        throw new Error(
          `stubSkill: ${seg} is a symbolic link; refusing to write through it`,
        );
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

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
  const skillMd = join(dir, "SKILL.md");
  // Walk every intermediate segment (home → .claude → skills →
  // ctxr-skill-llm-wiki) BEFORE mkdir. mkdir({recursive: true})
  // follows symlinks, so a hostile fixture that planted
  // `${home}/.claude -> /etc` would otherwise cause stubSkill to
  // create `.claude/skills/ctxr-skill-llm-wiki` under `/etc/`.
  await refuseSymlinkChain(home, dir);
  await mkdir(dir, { recursive: true });
  // Re-check the leaf file path before writing, so a pre-existing
  // symlink at `<dir>/SKILL.md` is also rejected.
  await refuseSymlinkChain(home, skillMd);
  const body = [
    "---",
    "name: skill-llm-wiki",
    "description: test stub of @ctxr/skill-llm-wiki — presence-only, not a working skill",
    `format_version: ${FORMAT_VERSION}`,
    "---",
    "",
    "This is a test stub. Do not invoke wiki operations against it.",
    "",
  ].join("\n");
  await writeFile(skillMd, body, "utf8");
  return { dir, skillMd, layout };
}
