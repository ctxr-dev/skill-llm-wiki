// Validator: runs the hard invariants from the methodology against a wiki.
// Reports findings as structured objects so tools can consume them.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { readIndex } from "./indices.mjs";
import { isWikiRoot } from "./paths.mjs";

export function validateWiki(wikiRoot) {
  const findings = [];
  const push = (severity, code, target, message) =>
    findings.push({ severity, code, target, message });

  if (!isWikiRoot(wikiRoot)) {
    push("error", "WIKI-01", wikiRoot, "path is not a valid wiki root (no index.md or wrong naming)");
    return findings;
  }

  const allEntries = collectAll(wikiRoot, push);

  // Index maps for cross-checks
  const byId = new Map();
  const aliasTo = new Map();
  for (const e of allEntries) {
    if (byId.has(e.data.id)) {
      push("error", "DUP-ID", e.absolute, `duplicate id "${e.data.id}" (also in ${byId.get(e.data.id).absolute})`);
    } else {
      byId.set(e.data.id, e);
    }
    for (const a of e.data.aliases ?? []) {
      if (byId.has(a)) {
        push("error", "ALIAS-COLLIDES-ID", e.absolute, `alias "${a}" collides with a live id`);
      }
      aliasTo.set(a, e);
    }
  }

  for (const e of allEntries) {
    const data = e.data;

    // #1 Required frontmatter fields
    const required = ["id", "type", "depth_role", "focus"];
    for (const f of required) {
      if (!(f in data)) push("error", "MISSING-FIELD", e.absolute, `required field "${f}" missing`);
    }

    // #2 id matches filename/directory
    if (data.type === "index") {
      if (data.id !== basename(dirname(e.absolute))) {
        push("error", "ID-MISMATCH-DIR", e.absolute, `index id "${data.id}" must match directory name "${basename(dirname(e.absolute))}"`);
      }
    } else {
      const expected = basename(e.absolute, ".md");
      if (data.id !== expected) {
        push("error", "ID-MISMATCH-FILE", e.absolute, `id "${data.id}" must match filename "${expected}"`);
      }
    }

    // #3 depth_role matches tree position
    const depth = depthOf(e.absolute, wikiRoot, data.type === "index");
    const expectedRole = depth === 0 ? "category" : depth === 1 ? "category" : "subcategory";
    if (data.type === "index") {
      // Tolerate either category or subcategory at depth ≥1
      if (depth === 0 && data.depth_role !== "category") {
        push("error", "DEPTH-ROLE", e.absolute, `root index must have depth_role: category`);
      }
    } else if (data.depth_role !== "leaf") {
      push("error", "DEPTH-ROLE", e.absolute, `leaf entry must have depth_role: leaf`);
    }

    // #8 parents[] required and non-empty (except root)
    const isRoot = data.type === "index" && dirname(e.absolute) === wikiRoot;
    if (!isRoot) {
      if (!Array.isArray(data.parents) || data.parents.length === 0) {
        push("error", "PARENTS-REQUIRED", e.absolute, `non-root entry must declare parents[]`);
      }
    }

    // #11 leaf size cap
    if (data.type === "primary" || data.type === "overlay") {
      const lineCount = readFileSync(e.absolute, "utf8").split("\n").length;
      const cap = data.type === "overlay" ? 200 : 500;
      if (lineCount > cap) {
        push("warning", "SIZE-CAP", e.absolute, `${data.type} entry exceeds ${cap}-line cap (${lineCount})`);
      }
    }

    // #12 parent file contract: index.md body must not contain leaf-content signatures
    if (data.type === "index") {
      const { body } = parseFrontmatter(readFileSync(e.absolute, "utf8"), e.absolute);
      const authored = extractAuthoredZone(body);
      if (authored && /^\s*- \[ \]/m.test(authored)) {
        push("error", "PARENT-CONTRACT", e.absolute, `index body contains checklist items — content must live in a leaf`);
      }
      if (authored && /^\s*```/m.test(authored)) {
        push("error", "PARENT-CONTRACT", e.absolute, `index body contains code fences — content must live in a leaf`);
      }
      const budget = 2048;
      if (authored && authored.length > budget) {
        push("error", "PARENT-CONTRACT", e.absolute, `index authored zone ${authored.length} bytes exceeds ${budget}-byte budget`);
      }
    }

    // #6 links[].id resolves
    for (const link of data.links ?? []) {
      if (!link || typeof link !== "object") continue;
      const target = link.id;
      if (!target) continue;
      if (!byId.has(target) && !aliasTo.has(target)) {
        push("error", "DANGLING-LINK", e.absolute, `links[].id "${target}" does not resolve`);
      }
    }

    // #5 overlay targets resolve
    if (data.type === "overlay") {
      for (const target of data.overlay_targets ?? []) {
        if (!byId.has(target) && !aliasTo.has(target)) {
          push("error", "DANGLING-OVERLAY", e.absolute, `overlay_targets "${target}" does not resolve`);
        }
      }
    }
  }

  return findings;
}

function collectAll(wikiRoot, push) {
  const out = [];
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // index.md
    const indexPath = join(dir, "index.md");
    if (existsSync(indexPath)) {
      try {
        const { data } = parseFrontmatter(readFileSync(indexPath, "utf8"), indexPath);
        out.push({ absolute: indexPath, data });
      } catch (err) {
        push("error", "PARSE", indexPath, err.message);
      }
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "index.md") {
        try {
          const { data } = parseFrontmatter(readFileSync(full, "utf8"), full);
          if (data && data.id) out.push({ absolute: full, data });
        } catch (err) {
          push("error", "PARSE", full, err.message);
        }
      }
    }
  }
  return out;
}

function depthOf(absPath, wikiRoot, isIndex) {
  const base = isIndex ? dirname(absPath) : dirname(absPath);
  const rel = relative(wikiRoot, base);
  if (rel === "" || rel === ".") return 0;
  return rel.split("/").filter(Boolean).length;
}

function extractAuthoredZone(body) {
  const start = body.indexOf("<!-- BEGIN AUTHORED ORIENTATION -->");
  const end = body.indexOf("<!-- END AUTHORED ORIENTATION -->");
  if (start === -1 || end === -1) return "";
  return body.slice(start + "<!-- BEGIN AUTHORED ORIENTATION -->".length, end);
}

export function summariseFindings(findings) {
  const byCode = new Map();
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === "error") errors++;
    else if (f.severity === "warning") warnings++;
    byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
  }
  return { errors, warnings, byCode };
}
