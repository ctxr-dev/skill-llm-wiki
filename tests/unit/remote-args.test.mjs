// remote-args.test.mjs — `cmdRemote` argument validation + dispatch.
//
// Uses a temp wiki with an initialised private git repo so the
// underlying `git remote` calls actually land. Covers every
// subcommand, every error path, and round-trip of add → list →
// remove → list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preOpSnapshot } from "../../scripts/lib/snapshot.mjs";
import { cmdRemote } from "../../scripts/commands/remote.mjs";

function tmpWiki(tag) {
  const d = join(
    tmpdir(),
    `skill-llm-wiki-remote-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function initWiki(tag) {
  const wiki = tmpWiki(tag);
  preOpSnapshot(wiki, `remote-test-${tag}`);
  return wiki;
}

// Capture stdout/stderr across a command invocation without
// clobbering the test runner's own streams.
function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    out.push(chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("cmdRemote: missing wikiRoot returns 1 with a clear error", () => {
  const { result, stderr } = capture(() =>
    cmdRemote(null, { subcommand: "list", args: [] }),
  );
  assert.equal(result, 1);
  assert.match(stderr, /remote: <wiki> is required/);
});

test("cmdRemote: unknown subcommand returns 1", () => {
  const wiki = initWiki("unknown");
  try {
    const { result, stderr } = capture(() =>
      cmdRemote(wiki, { subcommand: "bogus", args: [] }),
    );
    assert.equal(result, 1);
    assert.match(stderr, /subcommand must be one of add, remove, list/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("cmdRemote add: missing name or url returns 1", () => {
  const wiki = initWiki("add-missing");
  try {
    const r1 = capture(() => cmdRemote(wiki, { subcommand: "add", args: [] }));
    assert.equal(r1.result, 1);
    const r2 = capture(() =>
      cmdRemote(wiki, { subcommand: "add", args: ["only-name"] }),
    );
    assert.equal(r2.result, 1);
    assert.match(r2.stderr, /name.*url/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("cmdRemote list: empty wiki reports no remotes", () => {
  const wiki = initWiki("empty-list");
  try {
    const { result, stdout } = capture(() =>
      cmdRemote(wiki, { subcommand: "list", args: [] }),
    );
    assert.equal(result, 0);
    assert.match(stdout, /no remotes configured/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("cmdRemote: full add → list → remove → list round-trip", () => {
  const wiki = initWiki("round-trip");
  try {
    // Add
    const add = capture(() =>
      cmdRemote(wiki, {
        subcommand: "add",
        args: ["origin", "/tmp/fake-remote.git"],
      }),
    );
    assert.equal(add.result, 0);
    assert.match(add.stdout, /origin added/);

    // List shows the remote
    const list1 = capture(() =>
      cmdRemote(wiki, { subcommand: "list", args: [] }),
    );
    assert.equal(list1.result, 0);
    assert.match(list1.stdout, /origin/);
    assert.match(list1.stdout, /fake-remote\.git/);

    // Remove
    const remove = capture(() =>
      cmdRemote(wiki, { subcommand: "remove", args: ["origin"] }),
    );
    assert.equal(remove.result, 0);
    assert.match(remove.stdout, /origin removed/);

    // List shows empty again
    const list2 = capture(() =>
      cmdRemote(wiki, { subcommand: "list", args: [] }),
    );
    assert.equal(list2.result, 0);
    assert.match(list2.stdout, /no remotes configured/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("cmdRemote add: duplicate name returns 1 with git's error", () => {
  const wiki = initWiki("dup");
  try {
    cmdRemote(wiki, {
      subcommand: "add",
      args: ["origin", "/tmp/fake1.git"],
    });
    const { result, stderr } = capture(() =>
      cmdRemote(wiki, {
        subcommand: "add",
        args: ["origin", "/tmp/fake2.git"],
      }),
    );
    assert.equal(result, 1);
    assert.match(stderr, /remote add/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});

test("cmdRemote remove: unknown name returns 1", () => {
  const wiki = initWiki("remove-unknown");
  try {
    const { result, stderr } = capture(() =>
      cmdRemote(wiki, { subcommand: "remove", args: ["does-not-exist"] }),
    );
    assert.equal(result, 1);
    assert.match(stderr, /remote remove/);
  } finally {
    rmSync(wiki, { recursive: true, force: true });
  }
});
