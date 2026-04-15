// source-frontmatter.mjs — read frontmatter from source files via
// `gray-matter`, the de-facto-standard YAML frontmatter library.
//
// Why not extend scripts/lib/frontmatter.mjs? That module owns the
// skill's OUTPUT serialisation, where deterministic byte-identical
// rendering is a hard requirement. The home-rolled parser only covers
// the narrow YAML subset the skill writes. When we read an ALREADY-
// frontmatter'd source file (e.g. a hand-authored wiki guide with
// `activation`, `covers`, `tags`, `focus`, `shared_covers`, nested
// sequences of maps, etc.), we want full YAML 1.2 coverage — exactly
// what gray-matter gives us (it delegates to js-yaml).
//
// Pollution guard: gray-matter's parsed object can still contain keys
// that would poison our internal object pipeline if merged naively
// (`__proto__`, `constructor`, `prototype`). We strip those here so
// every downstream caller can treat the returned `data` as a safe
// plain object. This preserves the security invariant encoded in
// `scripts/lib/frontmatter.mjs`'s POLLUTION_KEYS list and its test
// at `tests/unit/frontmatter-pollution.test.mjs`.

import matter from "gray-matter";

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Parse a raw source string. Returns `{ data, body, hasFrontmatter }`.
//
//   - `data`: the parsed frontmatter as a safe plain object (pollution
//     keys removed recursively). Empty object when there was no fence.
//   - `body`: the source content WITH the frontmatter block stripped.
//     This is what the orchestrator concatenates fresh frontmatter on
//     top of — stripping here is what fixes the double-stack bug.
//   - `hasFrontmatter`: true iff the source opened with `---\n` and a
//     matching close fence. Used by the orchestrator to decide whether
//     to apply the authored-field merge in draftLeafFrontmatter.
export function parseSourceFrontmatter(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("parseSourceFrontmatter: raw must be a string");
  }
  // Fast path: no leading fence → no frontmatter. Avoids gray-matter
  // having to tokenise the whole file just to confirm there's nothing
  // to parse.
  if (!raw.startsWith("---\n") && raw !== "---\n" && !raw.startsWith("---\r\n")) {
    return { data: {}, body: raw, hasFrontmatter: false };
  }
  let parsed;
  try {
    parsed = matter(raw, { excerpt: false });
  } catch (err) {
    // gray-matter throws on malformed YAML. Surface the underlying
    // message and let the orchestrator decide whether to fall back
    // (it currently treats malformed source frontmatter as empty).
    return {
      data: {},
      body: raw,
      hasFrontmatter: false,
      error: err.message || String(err),
    };
  }
  const safeData = sanitise(parsed.data);
  const body = typeof parsed.content === "string" ? parsed.content : "";
  // gray-matter returns `matter: ""` when there was no fence. Use the
  // `isEmpty` heuristic: any non-empty data object OR a body shorter
  // than the raw input implies a fence was parsed.
  const hasFrontmatter =
    Object.keys(safeData).length > 0 || body.length < raw.length;
  return { data: safeData, body, hasFrontmatter };
}

// Recursively copy a parsed object, refusing any pollution key. Arrays
// and nested maps are walked; primitives pass through unchanged.
function sanitise(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitise(v));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (POLLUTION_KEYS.has(k)) continue;
    Object.defineProperty(out, k, {
      value: sanitise(v),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}
