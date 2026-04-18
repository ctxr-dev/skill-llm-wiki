// tmp.mjs — shared tmp-directory helper for unit tests.
//
// Callers did `join(tmpdir(), \`tag-${process.pid}-${Date.now()}\`)`
// inline across three files, which is both duplication and fragile:
// under parallel `node --test` runs, `process.pid` is constant
// across workers and `Date.now()` has 1ms resolution, so two
// simultaneous calls with the same tag can collide. `mktmp` appends
// 8 hex characters from `crypto.randomBytes` to guarantee
// uniqueness.
//
// Use `withTmp(tag, fn)` to get automatic try/finally cleanup. Use
// `mktmp(tag)` when the test needs to manage the lifecycle itself.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function mktmp(tag) {
  const suffix = randomBytes(4).toString("hex");
  const p = join(
    tmpdir(),
    `skill-llm-wiki-${tag}-${process.pid}-${Date.now()}-${suffix}`,
  );
  mkdirSync(p, { recursive: true });
  return p;
}

export async function withTmp(tag, fn) {
  const dir = mktmp(tag);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
