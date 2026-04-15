// url-redaction.test.mjs — `redactUrl` + `redactArgs` from git.mjs.
//
// Every code path that echoes a remote URL MUST run it through
// `redactUrl` first. These tests pin the redaction contract so a
// future refactor that loses the redaction fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactArgs, redactUrl } from "../../scripts/lib/git.mjs";

test("redactUrl: https URL with token is redacted", () => {
  const input = "https://ghp_abcdef1234567890@github.com/owner/repo.git";
  const out = redactUrl(input);
  assert.ok(
    !out.includes("ghp_abcdef1234567890"),
    `token must be stripped, got: ${out}`,
  );
  assert.equal(out, "https://<redacted>@github.com/owner/repo.git");
});

test("redactUrl: https URL with user:pass is redacted", () => {
  const out = redactUrl("https://alice:secret123@git.example.com/repo.git");
  assert.ok(!out.includes("secret123"));
  assert.ok(!out.includes("alice"));
  assert.equal(out, "https://<redacted>@git.example.com/repo.git");
});

test("redactUrl: ssh URL with username is redacted", () => {
  const out = redactUrl("ssh://git@github.com/owner/repo.git");
  // SSH user is typically non-sensitive (just `git`) but the
  // redactor is conservative — strip it anyway.
  assert.equal(out, "ssh://<redacted>@github.com/owner/repo.git");
});

test("redactUrl: URL without userinfo passes through unchanged", () => {
  const input = "https://github.com/owner/repo.git";
  assert.equal(redactUrl(input), input);
});

test("redactUrl: local file path passes through unchanged", () => {
  assert.equal(redactUrl("/tmp/bare.git"), "/tmp/bare.git");
});

test("redactUrl: non-string input returned as-is", () => {
  assert.equal(redactUrl(null), null);
  assert.equal(redactUrl(undefined), undefined);
  assert.equal(redactUrl(42), 42);
});

test("redactUrl: mixed strings with a URL inside preserve non-URL text", () => {
  const out = redactUrl(
    "error: could not push to https://tok@host/repo.git — see log",
  );
  assert.ok(!out.includes("tok@"));
  assert.ok(out.includes("could not push"));
  assert.ok(out.includes("— see log"));
});

test("redactUrl: handles multiple URLs in the same string", () => {
  const out = redactUrl(
    "fetch https://a:b@host1/r.git then push https://c:d@host2/r.git",
  );
  assert.ok(!out.includes("a:b@"));
  assert.ok(!out.includes("c:d@"));
  assert.equal(
    out,
    "fetch https://<redacted>@host1/r.git then push https://<redacted>@host2/r.git",
  );
});

test("redactArgs: preserves argv shape, redacts URL elements", () => {
  const argv = [
    "push",
    "https://ghp_token@host/repo.git",
    "refs/tags/op/*",
  ];
  const out = redactArgs(argv);
  assert.equal(out.length, 3);
  assert.equal(out[0], "push");
  assert.equal(out[1], "https://<redacted>@host/repo.git");
  assert.equal(out[2], "refs/tags/op/*");
});

test("redactArgs: empty argv returns empty array", () => {
  assert.deepEqual(redactArgs([]), []);
});
