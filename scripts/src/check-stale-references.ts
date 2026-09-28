/** Reject obsolete public references while leaving explicitly archived content alone. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";
const forbidden = [
  "skills/dev-tools/ts-optimize",
  "skills/dev-tools/ps1-optimize",
  "dev-tools.ts-optimize",
  "dev-tools.ps1-optimize",
  "agents/dev-tools/",
  "Haiku proxy",
  "Kimi API",
  "GLM API",
];
export function staleReferences(): string[] {
  const matches: string[] = [];
  for (const path of repositoryFiles()) {
    if (
      /^(?:_archive\/|\.codex\/skills-archive\/)/.test(path) ||
      /(?:^|\/)(?:node_modules|dist|\.git|\.pipeline)\//.test(path) ||
      path === "scripts/src/check-stale-references.ts"
    )
      continue;
    const bytes = readFileSync(resolve(repositoryRoot, path));
    if (bytes.includes(0)) continue;
    bytes
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (
          forbidden.some((pattern) =>
            /[A-Z]/.test(pattern) ? line.includes(pattern) : line.toLowerCase().includes(pattern),
          )
        )
          matches.push(`${path}:${index + 1}:${line}`);
      });
  }
  return matches;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matches = staleReferences();
  console.log(
    matches.length
      ? `FAIL: stale references detected\n${matches.join("\n")}`
      : "OK: no stale references found",
  );
  process.exitCode = matches.length ? 1 : 0;
}
