// chunk.mjs — scale-safe chunked iteration over a wiki's entries.
//
// The orchestrator's operator-convergence, classify, and plan-review
// phases (methodology sections 3.5, 3.6, 8.5) must run frontmatter-only
// at detection time. Loading every leaf body into memory defeats the
// skill's ability to handle multi-megabyte corpora.
//
// This module is the single chokepoint for "walk the wiki, give me
// every entry". It yields frontmatter-parsed records with a lazy
// `loadBody()` thunk the caller must call explicitly to read the
// body content. If the chokepoint is respected, the orchestrator's
// working set stays bounded by the largest single entry regardless of
// corpus size.
//
// Two scale guarantees this file enforces:
//
//   1. Frontmatter reads are BOUNDED per entry via a streaming fs
//      reader that stops at the closing `---` fence. We never pull a
//      10 MB body into memory just to parse a 500-byte frontmatter.
//
//   2. `loadBody()` re-opens the file on demand and returns a string.
//      The iterator does NOT cache it. Callers that hold the returned
//      string retain its bytes; callers that let it go out of scope
//      release them. Module-level metrics (inFlightBodies /
//      peakInFlightBodies) let scale tests prove the discipline is
//      being followed.

import {
  closeSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { parseFrontmatter } from "./frontmatter.mjs";

// Max bytes we ever read while looking for a frontmatter closing
// fence. Real frontmatters are typically <4 KB; 256 KB is a generous
// pathology ceiling. A file that somehow needs more is either
// corrupted or adversarial — the chunk API refuses to play AND
// `listChildren` tolerates this refusal by skipping the entry, so
// index generation never blocks on an adversarial file.
//
// The ceiling is deliberately much larger than typical frontmatter
// (~64×) so that hand-authored corner cases (giant `activation.file_globs`
// arrays, huge shared_covers lists at a fat parent index) do not hit
// it in practice.
const MAX_FRONTMATTER_BYTES = 256 * 1024;
const READ_CHUNK_SIZE = 4096;

// ── Body-load discipline metrics ─────────────────────────────────────
//
// These counters track *caller discipline*, NOT actual memory
// residency. V8 has no cheap hook for measuring string residency from
// inside JavaScript, and the module cannot observe when a caller's
// reference falls out of scope. What these counters do give us:
//
//   - `totalBodyLoads` — how many times `loadBody()` was called.
//     Scale tests use this to prove a frontmatter-only walk never
//     invoked the thunk (should be 0).
//   - `inFlightBodies` — how many `loadBody()` calls have happened
//     since the matching `releaseBody()` call. Callers that follow
//     the streaming-consumer pattern (load → process → release →
//     next) keep this at 0 or 1.
//   - `peakInFlightBodies` — the maximum value `inFlightBodies`
//     reached since the last `resetBodyMetrics()`. A streaming
//     consumer's peak is 1; a naive consumer that holds every body
//     sees peak == N.
//
// The metric does not prove memory residency. A caller can call
// `releaseBody()` and still hold a reference to the body string; V8
// keeps the string alive regardless of the counter. A caller can
// forget `releaseBody()` and drop the reference; the counter never
// decrements but GC still reclaims the string. The metric is a
// discipline tracker — it catches bugs where consumers accidentally
// accumulate bodies in an array, it does not measure heap pressure.
//
// Counters are PROCESS-GLOBAL. Tests that care about the value MUST
// call `resetBodyMetrics()` at the start of their scenario, and MUST
// not run in parallel with other metric-sensitive tests.
let _inFlightBodies = 0;
let _peakInFlightBodies = 0;
let _totalBodyLoads = 0;
// Parallel counter for the streaming frontmatter reader itself.
// Scale tests that need to prove `listChildren` went through
// `readFrontmatterStreaming` (and NOT a full-file readFileSync) read
// this counter to assert the rewire is still intact. Reset with
// `resetBodyMetrics()` so cross-test contamination cannot poison it.
let _totalFrontmatterReads = 0;

export function resetBodyMetrics() {
  _inFlightBodies = 0;
  _peakInFlightBodies = 0;
  _totalBodyLoads = 0;
  _totalFrontmatterReads = 0;
}

export function getBodyMetrics() {
  return {
    inFlightBodies: _inFlightBodies,
    peakInFlightBodies: _peakInFlightBodies,
    totalBodyLoads: _totalBodyLoads,
    totalFrontmatterReads: _totalFrontmatterReads,
  };
}

// Called by `loadBody` thunks immediately before returning the body
// string. Increments the in-flight counter and updates the peak.
function _markBodyLoadStart() {
  _inFlightBodies++;
  _totalBodyLoads++;
  if (_inFlightBodies > _peakInFlightBodies) {
    _peakInFlightBodies = _inFlightBodies;
  }
}

// Called by consumers when they have finished with a body string.
// Decrements `inFlightBodies`. Callers MUST call this after every
// matching `loadBody()` if they want the discipline metric to stay
// meaningful. An unbalanced release (more releases than loads)
// throws loudly so the bug surfaces instead of silently muddying
// the counter.
export function releaseBody() {
  if (_inFlightBodies === 0) {
    throw new Error(
      "chunk.mjs: releaseBody called without a matching loadBody — " +
        "consumer discipline bug",
    );
  }
  _inFlightBodies--;
}

// ── Streaming frontmatter reader ─────────────────────────────────────
//
// Reads bytes from the file in 4 KB chunks until we find the closing
// frontmatter fence OR exceed MAX_FRONTMATTER_BYTES. The reader
// operates purely on Buffers — it never decodes partial chunks as
// UTF-8, because a multi-byte codepoint split across chunk boundaries
// would emit replacement characters and corrupt both the decoded
// frontmatter and the byte offset used by `loadBody`. Only the final
// full frontmatter buffer is decoded once at the end.
//
// `bodyOffset` is authoritatively a BYTE offset (not a code-unit
// index) so `loadBody` can slice the raw file Buffer before decoding.
// Returns `null` for files that do not begin with a frontmatter
// fence; throws for files whose frontmatter has no closing fence
// within the pathology budget.
//
// Opening and closing fence line-endings must agree. A file that
// opens `---\n` must close `\n---\n`; a file that opens `---\r\n`
// must close `\r\n---\r\n`. Mixed line-endings are rejected loudly.
const OPEN_LF = Buffer.from("---\n");
const OPEN_CRLF = Buffer.from("---\r\n");
const CLOSE_LF = Buffer.from("\n---\n");
const CLOSE_CRLF = Buffer.from("\r\n---\r\n");

export function readFrontmatterStreaming(absPath) {
  _totalFrontmatterReads++;
  const fd = openSync(absPath, "r");
  try {
    const chunk = Buffer.alloc(READ_CHUNK_SIZE);
    let collected = Buffer.alloc(0);
    let pos = 0;
    // Style is set once the opening fence is confirmed, so we search
    // for the matching closing fence variant and never mix.
    let style = null; // "lf" | "crlf"
    while (collected.length < MAX_FRONTMATTER_BYTES) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) break;
      collected = Buffer.concat([collected, chunk.slice(0, n)]);
      pos += n;

      if (style === null) {
        // Fence detection needs at least 4 bytes. Once we have them:
        //   - `- - - \n` (bytes 0x2d 0x2d 0x2d 0x0a) → LF style.
        //   - `- - - \r` needs one more byte to confirm `\n` and
        //     become CRLF style; with only 4 bytes on a file that
        //     ends there, it's malformed.
        //   - Anything else at bytes 0-3 is a plain markdown file.
        if (collected.length < 4) continue;
        if (collected.slice(0, 4).equals(OPEN_LF)) {
          style = "lf";
        } else if (
          collected.length >= 5 &&
          collected.slice(0, 5).equals(OPEN_CRLF)
        ) {
          style = "crlf";
        } else if (collected[0] === 0x2d && collected[3] === 0x0d) {
          // We have `---\r` and are waiting for the next byte to
          // decide LF-vs-CRLF. Keep reading.
          continue;
        } else {
          // First 4 bytes are not a frontmatter opening. This is a
          // plain markdown file; skip silently.
          return null;
        }
      }

      const closeFence = style === "crlf" ? CLOSE_CRLF : CLOSE_LF;
      const searchFrom = style === "crlf" ? OPEN_CRLF.length : OPEN_LF.length;
      const idx = collected.indexOf(closeFence, searchFrom);
      if (idx !== -1) {
        const end = idx + closeFence.length;
        const frontmatterBytes = collected.slice(0, end);
        // Decode the frontmatter to UTF-8. For CRLF files we also
        // normalise to LF so downstream parsers (which are LF-only
        // on this codebase) see the expected line endings. The
        // `bodyOffset` stays as the original BYTE offset into the
        // file, independent of the text normalisation, so loadBody
        // still cuts the body at the right position.
        let text = frontmatterBytes.toString("utf8");
        if (style === "crlf") {
          text = text.replace(/\r\n/g, "\n");
        }
        return {
          frontmatterText: text,
          // `bodyOffset` is the number of bytes from the start of the
          // file to just after the closing fence. `loadBody` reads the
          // file as a Buffer and slices at this offset BEFORE decoding,
          // so multi-byte frontmatter characters cannot corrupt the
          // body boundary.
          bodyOffset: end,
          lineEnding: style,
        };
      }
    }

    // Distinguish three terminal states: empty file, short file, and
    // budget exhausted. The empty / short cases should NOT look like
    // "frontmatter too big" because the diagnostic would mislead a
    // user whose file is 4 bytes.
    if (collected.length === 0) {
      return null;
    }
    if (style === null) {
      // Too short to even confirm the opening fence — treat as plain.
      return null;
    }
    throw new Error(
      `chunk.mjs: frontmatter in ${absPath} has no closing --- fence ` +
        `within ${MAX_FRONTMATTER_BYTES} bytes`,
    );
  } finally {
    closeSync(fd);
  }
}

// ── Entry path collection ────────────────────────────────────────────
//
// Walks the wiki tree starting at `wikiRoot`, returning every `.md`
// file (including `index.md`) sorted by their absolute path. The walk
// is iterative with an explicit stack so we do not blow the call
// stack on deeply-nested corpora.
//
// Dot files and dot directories are skipped entirely. This is a
// blanket rule covering every metadata surface the skill owns
// (`.llmwiki/`, `.work/`, `.shape/`) plus any user dotfile the
// caller might reasonably not want yielded as an entry (`.git/`,
// `.github/`, `.DS_Store`, etc). There is no allow-list: if you
// want a dotfile indexed, rename it.
//
// The caller receives `onDirError(err, dir)` notifications for any
// directory that fails to enumerate (permission denied, etc).
// Default: silently swallow, because skipping an unreadable subdir
// is the safer behaviour for a walk over user-supplied paths. Tests
// use the callback to assert errors are raised for known-bad
// fixtures.
export function collectEntryPaths(wikiRoot, opts = {}) {
  const { onDirError = null } = opts;
  const out = [];
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (onDirError) onDirError(err, dir);
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.isFile() && e.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

// ── The iterator ─────────────────────────────────────────────────────
//
// Synchronous generator that yields one entry at a time in
// deterministic sorted-path order. Callers may drive it with either
// `for (const entry of iterEntries(...))` or
// `for await (const entry of iterEntries(...))` — for-await accepts
// sync iterables transparently, so existing async callers keep
// working.
//
// Each yielded entry carries:
//
//   path       absolute filesystem path to the .md file
//   relPath    path relative to wikiRoot (POSIX separators)
//   data       parsed frontmatter (same shape as parseFrontmatter.data)
//   type       "index" | "leaf"  (derived from filename basename)
//   loadBody   async () => string, reads and returns the body
//
// `loadBody()` is declared `async` on purpose: Phase 6's tiered AI
// may eventually back it with a remote fetch for partial-retrieval
// scenarios, and promoting the signature later is a breaking change.
// Phase 5's implementation is synchronous under the hood.
//
// `loadBody()` is NOT cached by the iterator: calling it twice reads
// the file twice. A caller that wants to hold a body does so in a
// local variable and knows exactly when it is retained.
//
// `opts.includeIndexFiles` (default: true) — set false when the
// caller only cares about leaves (operator-convergence detection).
//
// `opts.onMalformed` — callback invoked when a file has a `---`
// opening fence but reads or parses pathologically (missing closing
// fence, YAML parse error, non-object frontmatter). The callback's
// return value is ignored; to ABORT iteration on first bad file it
// must throw. The default behaviour is exactly that: the default
// callback throws, which propagates out of the generator and
// terminates the walk. To COLLECT errors and keep walking, pass an
// explicit non-throwing callback — the iterator then skips the bad
// file and continues. These are two distinct modes; choose which
// one you want by choosing whether the callback throws.
//
// `opts.onDirError` (default: null) — forwarded to
// `collectEntryPaths` for directory-level I/O errors.
export function* iterEntries(wikiRoot, opts = {}) {
  const {
    includeIndexFiles = true,
    onMalformed = (err) => {
      throw err;
    },
    onDirError = null,
  } = opts;

  const paths = collectEntryPaths(wikiRoot, { onDirError });
  for (const absPath of paths) {
    const rel = relative(wikiRoot, absPath).replace(/\\/g, "/");
    const isIndex = basename(absPath) === "index.md";
    if (isIndex && !includeIndexFiles) continue;

    let captured;
    try {
      captured = readFrontmatterStreaming(absPath);
    } catch (err) {
      onMalformed(err);
      continue;
    }
    if (captured === null) {
      // Not a frontmatter-bearing file. Skip silently: a wiki may
      // carry incidental markdown files (README snippets, etc.)
      // and we should not treat them as entries.
      continue;
    }

    let parsed;
    try {
      parsed = parseFrontmatter(captured.frontmatterText, absPath);
    } catch (err) {
      onMalformed(err);
      continue;
    }
    if (!parsed.data || typeof parsed.data !== "object") {
      onMalformed(
        new Error(
          `${absPath}: frontmatter parsed to non-object ${typeof parsed.data}`,
        ),
      );
      continue;
    }

    // `bodyOffset` is a byte offset. `loadBody` reads the file as a
    // Buffer, slices BEFORE decoding, and only then converts to
    // UTF-8 — so multi-byte frontmatter codepoints cannot misalign
    // the body boundary. The thunk captures both `absPath` and
    // `bodyOffset`, so repeated calls always seek past the
    // frontmatter correctly.
    const bodyOffset = captured.bodyOffset;
    const loadBody = async () => {
      const rawBuf = readFileSync(absPath);
      const bodyBuf = rawBuf.slice(bodyOffset);
      const body = bodyBuf.toString("utf8");
      _markBodyLoadStart();
      return body;
    };

    yield {
      path: absPath,
      relPath: rel,
      data: parsed.data,
      type: isIndex ? "index" : "leaf",
      loadBody,
    };
  }
}

// Convenience wrapper for callers that only want frontmatter (the
// common case for operator-convergence + classify). Returns an array
// of { path, relPath, data, type, loadBody } entries with the
// loadBody thunk included but never called by this helper.
export function collectFrontmatterOnly(wikiRoot, opts = {}) {
  const out = [];
  for (const entry of iterEntries(wikiRoot, opts)) {
    out.push(entry);
  }
  return out;
}

