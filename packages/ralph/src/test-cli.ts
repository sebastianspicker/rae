#!/usr/bin/env node
/** Runs Ralph's compiled Node tests with the legacy optional filter behavior. */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const testRoot = join(packageRoot, "dist", "tests");
const allFiles = readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testRoot, name));
const filter = process.argv
  .slice(2)
  .filter((argument) => argument !== "--")
  .join(" ");
const files = filter ? allFiles.filter((file) => file.includes(filter)) : allFiles;
if (!files.length) {
  process.stderr.write(`No Ralph tests matched filter: ${filter}\n`);
  process.exit(1);
}
const args = ["--test", ...files];
const result = spawnSync(process.execPath, args, { cwd: packageRoot, stdio: "inherit" });
process.exitCode = result.status ?? 1;
