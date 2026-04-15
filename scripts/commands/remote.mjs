// remote.mjs — `skill-llm-wiki remote <wiki> <subcommand> [args]`
//
// Thin wrapper around git's remote management, routed through the
// private repo's isolation env. Subcommands:
//
//   add <name> <url>    register a new remote
//   remove <name>       delete a configured remote
//   list                list all remotes with (fetch, push) URLs
//
// The skill never talks to a remote on its own. `remote add` just
// records the URL in the private repo's config; nothing is fetched,
// pushed, or authenticated here. The user invokes `skill-llm-wiki
// sync <wiki>` explicitly to actually exchange objects with the
// remote.
//
// All operations fail loudly on collision, missing args, or git
// errors — there is no silent "remote already exists, overwrite"
// behavior. If a caller needs idempotent add-or-replace they do
// `remove` then `add`.

import {
  gitRemoteAdd,
  gitRemoteList,
  gitRemoteRemove,
  redactUrl,
} from "../lib/git.mjs";

const REMOTE_SUBCOMMANDS = new Set(["add", "remove", "list"]);

export function cmdRemote(wikiRoot, { subcommand, args = [] }) {
  if (!wikiRoot) {
    process.stderr.write("remote: <wiki> is required\n");
    return 1;
  }
  if (!subcommand || !REMOTE_SUBCOMMANDS.has(subcommand)) {
    process.stderr.write(
      `remote: subcommand must be one of ${[...REMOTE_SUBCOMMANDS].join(", ")}; got "${subcommand}"\n`,
    );
    return 1;
  }
  try {
    switch (subcommand) {
      case "add": {
        const [name, url] = args;
        // Defence in depth: reject whitespace-only or empty after
        // trim so we never hand garbage to git.
        if (!name || !name.trim() || !url || !url.trim()) {
          process.stderr.write(
            "remote add: <name> <url> are both required and non-empty\n",
          );
          return 1;
        }
        gitRemoteAdd(wikiRoot, name.trim(), url.trim());
        // Always redact the URL before echoing — https URLs with
        // embedded credentials like `https://token@host/repo.git`
        // are common and must never surface on stdout.
        process.stdout.write(
          `remote ${name.trim()} added (${redactUrl(url.trim())})\n`,
        );
        return 0;
      }
      case "remove": {
        const [name] = args;
        if (!name) {
          process.stderr.write("remote remove: <name> is required\n");
          return 1;
        }
        gitRemoteRemove(wikiRoot, name);
        process.stdout.write(`remote ${name} removed\n`);
        return 0;
      }
      case "list": {
        const remotes = gitRemoteList(wikiRoot);
        if (remotes.length === 0) {
          process.stdout.write("(no remotes configured)\n");
          return 0;
        }
        for (const r of remotes) {
          process.stdout.write(
            `${r.name}\n` +
              `  fetch: ${redactUrl(r.fetch ?? "(none)")}\n` +
              `  push:  ${redactUrl(r.push ?? "(none)")}\n`,
          );
        }
        return 0;
      }
    }
  } catch (err) {
    process.stderr.write(`remote ${subcommand}: ${err.message}\n`);
    return 1;
  }
  return 0;
}
