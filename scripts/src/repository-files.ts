/** Enumerate tracked and publishable untracked inputs for repository verification. */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
export const repositoryRoot = resolve(import.meta.dirname, "../..");
export function repositoryFiles(trackedOnly = false): string[] {
  const args = trackedOnly ? ["ls-files", "-z"] : ["ls-files", "-co", "--exclude-standard", "-z"];
  const output = execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter(Boolean))]
    .filter(
      (path) =>
        existsSync(resolve(repositoryRoot, path)) &&
        lstatSync(resolve(repositoryRoot, path)).isFile(),
    )
    .sort();
}
