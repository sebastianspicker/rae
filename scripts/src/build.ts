#!/usr/bin/env node
/** Build maintained packages in dependency order before application and CLI verification. */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
import { assertNodeRuntime } from "./node-runtime.js";
const packages = [
  ["@rae/contracts", "build"],
  ["@rae/dev-tools-shared", "build"],
  ["quality-gate-skill", "build"],
  ["multi-model-review-skill", "build"],
  ["trace-collector-skill", "build"],
  ["@rae/engine", "build"],
  ["@rae/operator", "build"],
  ["@rae/ralph", "build"],
  ["@rae/agent-profiles", "build"],
  ["@rae/coauthor-trailer-cleaner", "build"],
  ["@rae/agent-adapters", "build"],
  ["@rae/dev-tool-verification", "build"],
] as const;
export function buildPackages(): void {
  assertNodeRuntime();
  for (const [name, command] of packages) {
    console.log(`Building ${name}`);
    const result = spawnSync("npm", ["--workspace", name, "run", command], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`${name} build failed (${result.signal ?? result.status})`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    buildPackages();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
