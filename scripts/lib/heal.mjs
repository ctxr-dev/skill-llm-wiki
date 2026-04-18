// heal.mjs — classify validate findings and name the next command.
//
// `skill-llm-wiki heal <wiki>` runs validate internally, then maps
// the findings to one of five verdicts:
//
//   ok            → nothing to do
//   fixable       → `skill-llm-wiki fix <wiki>` will resolve it
//   needs-rebuild → `skill-llm-wiki rebuild <wiki>` is required
//   broken        → the wiki is corrupt; manual intervention needed
//   ambiguous     → validate itself failed before producing findings
//
// The consumer invokes the recommended command as a separate step.
// Heal does not run fix/rebuild directly: doing so pulls in the
// orchestrator's error surface (Tier 2 exits, validation rollback,
// non-interactive refusal) that a classify-only shape deliberately
// avoids. A follow-up can add --apply once that error-mapping is
// proven.
//
// The classification table below is the public contract: consumers
// who want to pre-classify findings themselves (e.g. for a CI dash)
// can import FINDING_ACTIONS.

import { validateWiki } from "./validate.mjs";

// Map every known finding code to the minimum action that resolves
// it. Ranked from cheapest ("none") to most invasive ("manual"):
//
//   none    → a warning; no mutating step required
//   fix     → `skill-llm-wiki fix` is sufficient
//   rebuild → `skill-llm-wiki rebuild` is required
//   manual  → the wiki is broken in a way the skill cannot self-heal
export const FINDING_ACTIONS = Object.freeze({
  // Wiki substrate / git:
  "WIKI-01": "manual", // not a valid wiki root
  "GIT-01": "manual", // private git is broken / divergent

  // Content loss:
  "LOSS-01": "rebuild", // source bytes not accounted for in target

  // Parse / malformed frontmatter:
  PARSE: "manual", // cannot parse YAML; user must edit

  // Frontmatter field issues — fix regenerates most of these:
  "MISSING-FIELD": "fix",
  "DUP-ID": "rebuild",
  "ALIAS-COLLIDES-ID": "fix",
  "ID-MISMATCH-DIR": "rebuild",
  "ID-MISMATCH-FILE": "rebuild",
  "DEPTH-ROLE": "rebuild",
  "PARENTS-REQUIRED": "rebuild",
  "PARENT-CONTRACT": "rebuild",
  "DANGLING-LINK": "fix",
  "DANGLING-OVERLAY": "fix",

  // Size cap is a warning surface only:
  "SIZE-CAP": "none",
});

// Priority ranking: if any finding maps to a higher-priority action,
// that action wins for the whole wiki.
const PRIORITY = { none: 0, fix: 1, rebuild: 2, manual: 3 };

function actionFor(code) {
  return FINDING_ACTIONS[code] ?? "rebuild";
}

// Core routing. Pure: call validateWiki separately if you want to
// avoid re-validating.
export function classifyFindings(findings) {
  const actions = new Set();
  for (const f of findings) {
    // Warnings never trigger a mutating verdict — they're advisory.
    if (f.severity !== "error") continue;
    actions.add(actionFor(f.code));
  }
  if (actions.size === 0) {
    return { action: "none", verdict: "ok" };
  }
  let best = "none";
  for (const a of actions) {
    if (PRIORITY[a] > PRIORITY[best]) best = a;
  }
  const verdictByAction = {
    none: "ok",
    fix: "fixable",
    rebuild: "needs-rebuild",
    manual: "broken",
  };
  return { action: best, verdict: verdictByAction[best] };
}

// Full heal run against a wiki path. Returns an object the CLI
// wraps into an envelope.
export function runHeal(wikiPath) {
  let findings;
  try {
    findings = validateWiki(wikiPath);
  } catch (err) {
    return {
      target: wikiPath,
      verdict: "ambiguous",
      action: "manual",
      findings: [],
      error: err.message,
      next_command: null,
    };
  }
  const { action, verdict } = classifyFindings(findings);
  const next_command = buildNextCommand(action, wikiPath);
  return {
    target: wikiPath,
    verdict,
    action,
    findings,
    error: null,
    next_command,
  };
}

function buildNextCommand(action, wikiPath) {
  if (action === "none") return null;
  if (action === "fix") {
    return ["skill-llm-wiki", "fix", wikiPath, "--json"];
  }
  if (action === "rebuild") {
    return ["skill-llm-wiki", "rebuild", wikiPath, "--json"];
  }
  // manual
  return null;
}
