#!/usr/bin/env node
/** Check staged TypeScript and JavaScript paths with the repository's pinned Biome. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const staged = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => /\.(?:[cm]?ts|[cm]?js)$/.test(path));
  if (staged.length) {
    console.log("pre-commit: biome lint + format check on staged files...");
    const biome = resolve(root, "node_modules/.bin/biome");
    execFileSync(biome, ["lint", "--config-path", "biome.json", "--", ...staged], {
      cwd: root,
      stdio: "inherit",
    });
    execFileSync(
      biome,
      [
        "check",
        "--formatter-enabled=true",
        "--linter-enabled=false",
        "--config-path",
        "biome.json",
        "--",
        ...staged,
      ],
      { cwd: root, stdio: "inherit" },
    );
    console.log("pre-commit: ok");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
