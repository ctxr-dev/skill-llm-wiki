// Shape-check: detect which rewrite operators from section 3.5 of the
// methodology would currently apply. Non-mutating. Writes findings to
// `<wiki>/.shape/suggestions.md` and, if they cross a threshold, sets
// `rebuild_needed: true` on the root index.md.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { listChildren, readIndex } from "./indices.mjs";

const DEFAULT_THRESHOLD = 5;
const MERGE_SIMILARITY = 0.7;

export function runShapeCheck(wikiRoot, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const suggestions = [];
  const dirs = [];
  collectDirs(wikiRoot, dirs);

  for (const dir of dirs) {
    const { leaves, subdirs } = listChildren(dir);

    // LIFT: exactly one non-index entry in a non-root folder
    if (dir !== wikiRoot && leaves.length === 1 && subdirs.length === 0) {
      suggestions.push({
        operator: "LIFT",
        target: dir,
        reason: `folder contains exactly one entry (${leaves[0].data.id}); lift it to parent`,
      });
    }

    // MERGE: sibling pairs with high covers overlap
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const a = leaves[i].data;
        const b = leaves[j].data;
        if (a.type !== b.type) continue;
        const aCov = new Set(a.covers ?? []);
        const bCov = new Set(b.covers ?? []);
        if (aCov.size === 0 || bCov.size === 0) continue;
        let intersect = 0;
        for (const c of aCov) if (bCov.has(c)) intersect++;
        const union = aCov.size + bCov.size - intersect;
        if (union === 0) continue;
        const overlap = intersect / union;
        if (overlap >= MERGE_SIMILARITY) {
          suggestions.push({
            operator: "MERGE",
            target: [leaves[i].path, leaves[j].path],
            reason: `siblings "${a.id}" and "${b.id}" have ${Math.round(overlap * 100)}% covers overlap`,
          });
        }
      }
    }

    // DESCEND: index body with authored zone above budget
    const indexPath = join(dir, "index.md");
    if (existsSync(indexPath)) {
      const raw = readFileSync(indexPath, "utf8");
      const { body } = parseFrontmatter(raw, indexPath);
      const authored = extractAuthoredZone(body);
      if (authored.length > 2048) {
        suggestions.push({
          operator: "DESCEND",
          target: indexPath,
          reason: `index authored zone is ${authored.length} bytes; push content to a leaf`,
        });
      }
      if (authored && (/^\s*```/m.test(authored) || /^\s*- \[ \]/m.test(authored))) {
        suggestions.push({
          operator: "DESCEND",
          target: indexPath,
          reason: "index body contains leaf-style content (code fence or checklist)",
        });
      }
    }

    // DECOMPOSE & NEST candidates are frontmatter-heuristic-heavy; we report
    // simpler signals here and leave semantic clustering to AI review during
    // Rebuild.
    for (const leaf of leaves) {
      const covers = leaf.data.covers ?? [];
      if (covers.length > 12) {
        suggestions.push({
          operator: "DECOMPOSE",
          target: leaf.path,
          reason: `leaf has ${covers.length} covers[] items; consider splitting by concern`,
        });
      }
      if (leaf.data.nests_into && Array.isArray(leaf.data.nests_into) && leaf.data.nests_into.length > 0) {
        suggestions.push({
          operator: "NEST",
          target: leaf.path,
          reason: `leaf declares nests_into: ${leaf.data.nests_into.join(", ")}`,
        });
      }
    }
  }

  // Write suggestions file and root flag.
  writeSuggestions(wikiRoot, suggestions);
  if (suggestions.length >= threshold) {
    setRootRebuildFlag(wikiRoot, suggestions, true);
  } else if (suggestions.length === 0) {
    setRootRebuildFlag(wikiRoot, [], false);
  }
  return suggestions;
}

function collectDirs(dirPath, acc) {
  if (!existsSync(dirPath)) return;
  acc.push(dirPath);
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!e.isDirectory()) continue;
      const sub = join(dirPath, e.name);
      if (existsSync(join(sub, "index.md"))) collectDirs(sub, acc);
    }
  } catch {
    /* skip */
  }
}

function extractAuthoredZone(body) {
  const start = body.indexOf("<!-- BEGIN AUTHORED ORIENTATION -->");
  const end = body.indexOf("<!-- END AUTHORED ORIENTATION -->");
  if (start === -1 || end === -1) return "";
  return body.slice(start + "<!-- BEGIN AUTHORED ORIENTATION -->".length, end).trim();
}

function writeSuggestions(wikiRoot, suggestions) {
  const dir = join(wikiRoot, ".shape");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "suggestions.md");
  const now = new Date().toISOString();
  const lines = [];
  lines.push("# Shape Suggestions");
  lines.push("");
  lines.push(`_Last shape-check: ${now}_`);
  lines.push("");
  if (suggestions.length === 0) {
    lines.push("_No pending operator candidates._");
    lines.push("");
  } else {
    lines.push(`**${suggestions.length} pending candidate(s):**`);
    lines.push("");
    for (const s of suggestions) {
      const targetStr = Array.isArray(s.target) ? s.target.map((t) => relative(wikiRoot, t)).join(", ") : relative(wikiRoot, s.target);
      lines.push(`- **${s.operator}** — \`${targetStr}\``);
      lines.push(`  - ${s.reason}`);
    }
    lines.push("");
  }
  writeFileSync(p, lines.join("\n"), "utf8");
}

function setRootRebuildFlag(wikiRoot, suggestions, needed) {
  const p = join(wikiRoot, "index.md");
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf8");
  const { data, body } = parseFrontmatter(raw, p);
  data.rebuild_needed = needed;
  data.rebuild_reasons = suggestions.slice(0, 10).map((s) => `${s.operator}: ${s.reason}`);
  if (!data.rebuild_command) {
    data.rebuild_command = `skill-llm-wiki rebuild ${wikiRoot} --plan`;
  }
  const tmp = p + ".tmp";
  writeFileSync(tmp, renderFrontmatter(data, body), "utf8");
  renameSync(tmp, p);
}
