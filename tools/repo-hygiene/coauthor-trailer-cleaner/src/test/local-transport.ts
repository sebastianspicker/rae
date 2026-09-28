#!/usr/bin/env node
/** Route the fixed synthetic GitHub URL exclusively into a disposable local bare remote. */
import { spawnSync } from "node:child_process";
const command = process.argv.at(-1),
  bare = process.env.RAE_FIXTURE_BARE;
if (!bare || !command || !/^git-(?:upload|receive)-pack 'acme\/demo'$/.test(command))
  process.exit(2);
const child = spawnSync(
  command.startsWith("git-upload") ? "git-upload-pack" : "git-receive-pack",
  [bare],
  { stdio: "inherit" },
);
if (child.error) throw child.error;
process.exit(child.status ?? 1);
