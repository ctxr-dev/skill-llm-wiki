// Validator: runs the hard invariants from the methodology against a wiki.
// Reports findings as structured objects so tools can consume them.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";
import { readIndex } from "./indices.mjs";
import { isWikiRoot } from "./paths.mjs";
import { gitFsck, gitRefExists, gitRevParse, gitRun } from "./git.mjs";
import { provenancePath, readProvenance, verifyCoverage } from "./provenance.mjs";
import { readOpLog } from "./history.mjs";

export function validateWiki(wikiRoot) {
  const findings = [];
  const push = (severity, code, target, message) =>
    findings.push({ severity, code, target, message });

  if (!isWikiRoot(wikiRoot)) {
    push("error", "WIKI-01", wikiRoot, "path is not a valid wiki root (no index.md or wrong naming)");
    return findings;
  }

  // GIT-01 — guarded: only fires when the private git repo exists.
  // When it fires, git fsck must pass with no non-dangling errors AND
  // the most recent operation's pre-op tag must be reachable from HEAD.
  runGit01(wikiRoot, push);

  // LOSS-01 — guarded: only fires when .llmwiki/provenance.yaml exists.
  // Every source byte must be accounted for via target sources[] or
  // discarded_ranges[], with no gaps or overlaps.
  runLoss01(wikiRoot, push);

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

    // ROOT-LEAF-AT-DEPTH-1 — the wiki root must hold only `index.md`
    // plus subdirectories. Any leaf `.md` at depth 0 is an outlier
    // that escaped clustering (Phase X.11 root-containment should
    // have placed it into its own single-member subcategory). The
    // rule is navigational, not structural: Claude reading
    // `<root>/index.md` and following its `entries[]` should reach
    // every leaf via a semantically-named category; loose root
    // leaves bypass that mental model and bloat the top-level index.
    if (data.type !== "index") {
      const absDir = dirname(e.absolute);
      if (absDir === wikiRoot) {
        push(
          "error",
          "ROOT-LEAF-AT-DEPTH-1",
          e.absolute,
          `leaf at wiki root — must live in a subcategory (run 'fix' to contain)`,
        );
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

// GIT-01 — private git repo integrity.
//
// Guarded: only runs when `.llmwiki/git/HEAD` exists. When it runs, it
// requires `git fsck --no-dangling --no-reflogs` to exit cleanly AND
// the pre-op tag of the most recent logged operation to be reachable
// from HEAD (git ancestor check). Unreachable pre-op tags indicate
// either a tampered tree or a bug in the orchestrator's rollback path.
function runGit01(wikiRoot, push) {
  if (!existsSync(join(wikiRoot, ".llmwiki", "git", "HEAD"))) return;
  const fsck = gitFsck(wikiRoot);
  if (!fsck.ok) {
    push(
      "error",
      "GIT-01",
      wikiRoot,
      `git fsck failed: ${(fsck.stderr || fsck.stdout || "").trim()}`,
    );
    return;
  }
  // Find the most recent op's pre-op tag from the op-log. Empty log is
  // a legitimate "freshly initialised wiki, no ops yet" — skip ancestor
  // check in that case.
  let opLog = [];
  try {
    opLog = readOpLog(wikiRoot);
  } catch (err) {
    push(
      "error",
      "GIT-01",
      join(wikiRoot, ".llmwiki", "op-log.yaml"),
      `unreadable op-log: ${err.message}`,
    );
    return;
  }
  if (opLog.length === 0) return;
  const latest = opLog[opLog.length - 1];
  const preTag = `pre-op/${latest.op_id}`;
  if (!gitRefExists(wikiRoot, preTag)) {
    push(
      "error",
      "GIT-01",
      wikiRoot,
      `pre-op tag ${preTag} for latest logged op not found in the private repo`,
    );
    return;
  }
  const headSha = gitRevParse(wikiRoot, "HEAD");
  const preSha = gitRevParse(wikiRoot, preTag);
  if (!headSha || !preSha) {
    push(
      "error",
      "GIT-01",
      wikiRoot,
      `unable to resolve HEAD or ${preTag}`,
    );
    return;
  }
  // Ancestor check: pre-op/<latest> must be reachable from HEAD. Use
  // `git merge-base --is-ancestor`, which exits 0 when preSha is an
  // ancestor of headSha and exit 1 when it is not — O(log N) walk
  // without materialising the full ancestry. Equality short-circuits
  // for the common post-rollback case where HEAD === pre-op.
  if (headSha === preSha) return;
  try {
    const r = gitRun(wikiRoot, [
      "merge-base",
      "--is-ancestor",
      preSha,
      headSha,
    ]);
    if (r.status === 0) return;
    if (r.status === 1) {
      push(
        "error",
        "GIT-01",
        wikiRoot,
        `pre-op/${latest.op_id} (${preSha.slice(0, 12)}) is not an ancestor of HEAD (${headSha.slice(0, 12)})`,
      );
      return;
    }
    push(
      "error",
      "GIT-01",
      wikiRoot,
      `merge-base --is-ancestor exited ${r.status}: ${(r.stderr || "").trim()}`,
    );
  } catch (err) {
    push("error", "GIT-01", wikiRoot, `ancestor check failed: ${err.message}`);
  }
}

// LOSS-01 — provenance coverage of every source byte.
//
// Guarded: only runs when `.llmwiki/provenance.yaml` exists. Walks the
// manifest's target entries, computes the reverse source → ranges
// index, and asserts that every byte is covered by either a target's
// preserved/split/merged/transformed range or an explicit discarded
// range. Source sizes come from the manifest's `source_size` field
// (authoritative at ingest time) so the check does NOT depend on the
// source file still being available at validation time.
function runLoss01(wikiRoot, push) {
  if (!existsSync(provenancePath(wikiRoot))) return;
  let doc;
  try {
    doc = readProvenance(wikiRoot);
  } catch (err) {
    push(
      "error",
      "LOSS-01",
      provenancePath(wikiRoot),
      `unreadable provenance manifest: ${err.message}`,
    );
    return;
  }
  // Build an in-memory lookup from the source_size fields recorded by
  // recordSource at ingest time.
  const sizeIndex = new Map();
  for (const entry of Object.values(doc.targets)) {
    for (const s of entry.sources || []) {
      if (typeof s.source_size === "number") {
        sizeIndex.set(s.source_path, s.source_size);
      }
    }
  }
  const result = verifyCoverage(wikiRoot, (path) => {
    if (sizeIndex.has(path)) return sizeIndex.get(path);
    return null;
  });
  if (result.ok) return;
  for (const u of result.uncovered) {
    const rangeDesc = u.byte_range
      ? ` bytes ${u.byte_range[0]}..${u.byte_range[1]}`
      : "";
    push(
      "error",
      "LOSS-01",
      join(wikiRoot, u.source_path || "<unknown-source>"),
      `${u.source_path ?? "<unknown>"}${rangeDesc}: ${u.reason}`,
    );
  }
  for (const o of result.overlaps) {
    push(
      "error",
      "LOSS-01",
      join(wikiRoot, o.source_path),
      `${o.source_path} bytes ${o.byte_range[0]}..${o.byte_range[1]} claimed by ${o.target} AND another target`,
    );
  }
  for (const ob of result.out_of_bounds || []) {
    push(
      "error",
      "LOSS-01",
      join(wikiRoot, ob.source_path),
      `${ob.source_path} bytes ${ob.byte_range[0]}..${ob.byte_range[1]} exceed source_size ${ob.source_size} (target ${ob.target})`,
    );
  }
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
