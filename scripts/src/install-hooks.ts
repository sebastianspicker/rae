#!/usr/bin/env node
/** Install compiled Node hooks into the Git-reported hook directory for this worktree. */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, symlinkSync, unlinkSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./repository-files.js";
try {
  if (process.argv.length > 2) throw new Error("Usage: install-hooks");
  const destination = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  if (!existsSync(destination) || !lstatSync(destination).isDirectory())
    throw new Error("Git hooks directory is unavailable");
  const source = resolve(repositoryRoot, "scripts/dist/hooks/pre-commit.js"),
    target = resolve(destination, "pre-commit");
  if (!existsSync(source)) throw new Error("Build repository tools before installing hooks");
  chmodSync(source, 0o755);
  try {
    if (lstatSync(target).isDirectory()) throw new Error("Refusing to replace a hook directory");
    unlinkSync(target);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
      throw error;
  }
  symlinkSync(source, target);
  console.log(`installed: ${target} -> ${source}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
