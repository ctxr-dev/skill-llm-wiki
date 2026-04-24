// contract.mjs — stable, machine-readable description of what this
// skill speaks to consumers. The single source of truth for the
// skill's format + CLI surface version.
//
// Consumers (other skills, agents, CI jobs) invoke
// `node scripts/cli.mjs contract --json` and assert
// `format_version >= <their required>` rather than drift-testing
// against SKILL.md prose. Bump FORMAT_VERSION on any breaking change
// to: leaf frontmatter schema, layout-contract grammar, CLI wire
// protocol, or exit-code meanings. Additive changes do not bump.
//
// The shape returned by `getContract()` is documented in
// guide/consumers/recipes/format-gate.md.

import { readFileSync } from "node:fs";

// ─── Version constants ──────────────────────────────────────────────
// `FORMAT_VERSION` is an integer. Bumps are breaking changes to the
// consumer-visible contract. Start at 1.
export const FORMAT_VERSION = 1;

// `MIN_CONSUMER_FORMAT_VERSION` is the oldest consumer-declared
// format_version this skill still speaks to. A consumer whose
// `required_format_version` is below this refuses to run; a consumer
// whose `required_format_version` is between this and FORMAT_VERSION
// runs unchanged. Bumps here signal a deprecation window closing.
export const MIN_CONSUMER_FORMAT_VERSION = 1;

// ─── Canonical shape ────────────────────────────────────────────────

// Leaf + index frontmatter fields the skill reads and writes.
// Mirrors scripts/lib/draft.mjs AUTHORED_LEAF_FIELDS for leaves
// and scripts/lib/indices.mjs / scripts/lib/validate.mjs for
// indices. Enums here are the canonical values the skill's own
// code emits and validate.mjs accepts; consumers authoring their
// own frontmatter must pick from these.
const FRONTMATTER_SCHEMA = {
  leaf: {
    required: ["id", "type", "depth_role", "focus", "parents", "source"],
    fields: {
      id: { kind: "string", description: "Unique leaf identifier; derived from source path." },
      // Leaves are `primary` by default; `overlay` is a dedicated
      // type that carries a smaller body budget (see validate.mjs
      // SIZE-CAP) and mandates overlay_targets[].
      type: { kind: "enum", values: ["primary", "overlay"] },
      // Leaves only ever carry depth_role "leaf". Indices have
      // their own depth_role vocabulary (see index.depth_role
      // below).
      depth_role: { kind: "enum", values: ["leaf"] },
      focus: { kind: "string", description: "One-line subject of the leaf." },
      covers: { kind: "string[]", description: "Sub-topics or H2 headings." },
      parents: { kind: "string[]", description: "Relative paths to parent index.md files (e.g. [index.md] or [../index.md])." },
      tags: { kind: "string[]" },
      source: {
        kind: "object",
        fields: {
          origin: { kind: "enum", values: ["file", "synthetic"] },
          path: { kind: "string", description: "POSIX-relative path from the source root." },
          hash: { kind: "string", description: "SHA-256 of the source content." },
        },
      },
      activation: { kind: "object", description: "Routing hints: keyword_matches, tag_matches, etc." },
      domains: { kind: "string[]" },
      aliases: { kind: "string[]" },
      shared_covers: { kind: "string[]" },
      // Only present (and required) when type === "overlay".
      overlay_targets: { kind: "string[]" },
      links: { kind: "string[]" },
    },
  },
  index: {
    required: ["id", "type", "depth_role", "focus"],
    fields: {
      id: { kind: "string", description: "Must match the containing directory's basename." },
      type: { kind: "enum", values: ["index"] },
      // `category` is the root index of a wiki; `subcategory` is
      // any nested index. There is no `root` or `branch` role in
      // the canonical shape; the skill refuses those.
      depth_role: { kind: "enum", values: ["category", "subcategory"] },
      focus: { kind: "string", description: "One-line subject of this branch." },
      depth: { kind: "integer", description: "0 for root category, 1+ for subcategories." },
      parents: { kind: "string[]", description: "Empty at the root; [../index.md] for nested." },
      children: { kind: "string[]", description: "Relative paths to nested index files." },
      entries: { kind: "object[]", description: "Per-leaf summaries (id, file, type, focus, tags)." },
      shared_covers: { kind: "string[]", description: "Inherited by this branch's leaves." },
      orientation: { kind: "string", description: "Authored guidance block; preserved across rebuilds." },
      rebuild_command: { kind: "string" },
      // Skill-generated marker; validate rejects a wiki root
      // whose root index.md lacks it.
      generator: { kind: "string", description: "e.g. \"skill-llm-wiki/v1\"; required on the root index." },
    },
  },
};

// Dynamic-subdirs template tokens supported inside
// `.llmwiki.layout.yaml` under `layout[].dynamic_subdirs.template`.
const LAYOUT_TOKENS = [
  { token: "{yyyy}", description: "4-digit year." },
  { token: "{mm}", description: "2-digit month." },
  { token: "{dd}", description: "2-digit day of month." },
  { token: "{slug}", description: "Leaf slug derived from source filename." },
];

// Exit code contract. Mirrors the banner in cli.mjs printUsage().
// Listed here so consumers have a single machine-readable source.
const EXIT_CODES = {
  0: "ok",
  1: "usage error",
  2: "validation or ambiguity error",
  3: "resolve-wiki miss",
  4: "Node.js too old",
  5: "git missing or too old",
  6: "wiki corrupt",
  7: "NEEDS_TIER2 — suspend and resume; not a failure",
  8: "DEPS_MISSING — required runtime dep missing",
};

// Top-level subcommands consumers are expected to invoke. Low-level
// helpers (`ingest`, `draft-leaf`, etc.) are deliberately omitted
// from the contract: they are internal tools, subject to change
// without a format_version bump. Keep this list in sync with
// cli.mjs printUsage() top-level operations.
// Keep this table in sync with scripts/cli.mjs. A drift test in
// tests/unit/contract.test.mjs asserts every flag listed here is
// actually accepted by the CLI's shared parser or one of the
// per-subcommand handlers. `SUBCOMMANDS[*].flags` lists canonical
// consumer-surface flags only; legacy aliases accepted by the CLI
// (for example `--json-errors` as an alias of `--json`) are
// deliberately omitted so consumers standardise on the current
// flag form.
const SUBCOMMANDS = {
  build: {
    positionals: ["source"],
    flags: [
      "--layout-mode",
      "--target",
      "--quality-mode",
      "--fanout-target",
      "--max-depth",
      "--soft-dag-parents",
      "--no-prompt",
      "--accept-dirty",
      "--accept-foreign-target",
      "--json",
    ],
  },
  extend: {
    positionals: ["wiki"],
    flags: [
      "--quality-mode",
      "--no-prompt",
      "--json",
    ],
  },
  validate: { positionals: ["wiki"], flags: ["--json"] },
  rebuild: {
    positionals: ["wiki"],
    flags: [
      "--quality-mode",
      "--fanout-target",
      "--max-depth",
      "--soft-dag-parents",
      "--review",
      "--no-prompt",
      "--json",
    ],
  },
  fix: { positionals: ["wiki"], flags: ["--json"] },
  join: {
    positionals: ["wiki-a", "wiki-b"],
    flags: [
      "--target",
      "--canonical",
      "--id-collision",
      "--quality-mode",
      "--json",
    ],
  },
  rollback: { positionals: ["wiki"], flags: ["--to", "--json"] },
  init: {
    positionals: ["topic"],
    flags: ["--kind", "--template", "--force", "--json"],
  },
  heal: { positionals: ["wiki"], flags: ["--dry-run", "--json"] },
  where: { positionals: [], flags: ["--json"] },
  contract: { positionals: [], flags: ["--json"] },
  "testkit-stub": { positionals: [], flags: ["--at", "--layout"] },
};

// Envelope schema that --json stdout follows across every command.
// Full JSON Schema lives in scripts/lib/json-envelope.mjs (Feature
// 5). Consumers gate on the `schema` discriminator.
const ENVELOPE_SCHEMA = {
  schema: "skill-llm-wiki/v1",
  fields: {
    schema: { kind: "string", const: "skill-llm-wiki/v1" },
    command: { kind: "string" },
    target: { kind: "string|null" },
    verdict: { kind: "string" },
    exit: { kind: "integer" },
    diagnostics: { kind: "object[]" },
    artifacts: { kind: "object" },
    timing_ms: { kind: "integer" },
    // `next` is optional: present only when the subcommand wants
    // to hand the consumer a machine-readable follow-up command
    // (init emits `{command:"skill-llm-wiki", args:["build",...]}`,
    // heal emits the fix/rebuild invocation). When absent, the
    // consumer has nothing to run.
    next: { kind: "object|null", fields: { command: "string", args: "string[]" } },
  },
};

// ─── Assembly ───────────────────────────────────────────────────────

function packageVersion() {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    return JSON.parse(readFileSync(pkgUrl, "utf8")).version;
  } catch {
    return "unknown";
  }
}

export function getContract() {
  return {
    schema: "skill-llm-wiki/contract/v1",
    format_version: FORMAT_VERSION,
    min_consumer_format_version: MIN_CONSUMER_FORMAT_VERSION,
    package_version: packageVersion(),
    frontmatter_schema: FRONTMATTER_SCHEMA,
    layout_tokens: LAYOUT_TOKENS,
    subcommands: SUBCOMMANDS,
    envelope_schema: ENVELOPE_SCHEMA,
    exit_codes: EXIT_CODES,
  };
}

// Human-readable summary. Used when `contract` is invoked without
// --json. Keep it short: anyone who wants detail takes --json.
export function renderContractText(contract) {
  const lines = [];
  lines.push(`skill-llm-wiki contract`);
  lines.push(`  package_version: ${contract.package_version}`);
  lines.push(`  format_version: ${contract.format_version}`);
  lines.push(`  min_consumer_format_version: ${contract.min_consumer_format_version}`);
  lines.push(`  subcommands: ${Object.keys(contract.subcommands).join(", ")}`);
  lines.push(`  layout_tokens: ${contract.layout_tokens.map((t) => t.token).join(" ")}`);
  lines.push(`  envelope: ${contract.envelope_schema.schema}`);
  return lines.join("\n") + "\n";
}
