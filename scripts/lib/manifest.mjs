// Progress manifest read/write for the resumable phase pipeline.
// Stored at `<wiki>/.work/progress.yaml`. Re-uses the same minimal YAML
// subset as frontmatter — the manifest is small and regular.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";

export const PHASES = Object.freeze([
  "ingest",
  "classify",
  "draft-frontmatter",
  "layout",
  "operator-convergence",
  "index-generation",
  "validation",
  "golden-path",
  "commit",
]);

export function manifestPath(wikiPath) {
  return join(wikiPath, ".work", "progress.yaml");
}

export function newManifest({ wikiPath, operation, sourcePaths, seed }) {
  const phases = {};
  for (const p of PHASES) phases[p] = { status: "pending", items_total: 0, items_completed: 0 };
  return {
    wiki_path: wikiPath,
    operation,
    source_paths: sourcePaths,
    source_hashes: {},
    started: new Date().toISOString(),
    last_progress: new Date().toISOString(),
    current_phase: "ingest",
    determinism_seed: seed,
    phases,
  };
}

export function readManifest(wikiPath) {
  const p = manifestPath(wikiPath);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  // Store as frontmatter YAML for simplicity — a fake doc with empty body.
  const { data } = parseFrontmatter(raw, p);
  return data;
}

export function writeManifest(wikiPath, manifest) {
  const p = manifestPath(wikiPath);
  mkdirSync(dirname(p), { recursive: true });
  manifest.last_progress = new Date().toISOString();
  // Atomic write: temp file + rename.
  const tmp = p + ".tmp";
  const content = renderFrontmatter(manifest, "");
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, p);
}

export function advancePhase(manifest, phase, patch) {
  manifest.phases[phase] = { ...manifest.phases[phase], ...patch };
  return manifest;
}

export function nextPhase(manifest) {
  const idx = PHASES.indexOf(manifest.current_phase);
  if (idx === -1 || idx >= PHASES.length - 1) return null;
  const next = PHASES[idx + 1];
  manifest.current_phase = next;
  return next;
}
