/** Enforce public package boundaries and repository ownership during source checks. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";
export function architectureViolations(): string[] {
  const files = repositoryFiles();
  const errors: string[] = [];
  for (const path of files) {
    if (/^packages\/(?:orchestration|loops)\//.test(path))
      errors.push(`Legacy architecture path remains: ${path}`);
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(path)) continue;
    const source = readFileSync(resolve(repositoryRoot, path), "utf8");
    if (/^apps\/(?:operator|platform)\//.test(path) && /packages\/engine\/src\//.test(source))
      errors.push(`App bypasses @rae/engine public export: ${path}`);
    if (!path.startsWith("packages/engine/")) continue;
    const imports = [...source.matchAll(/(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    if (
      imports.some((target) =>
        /(?:^|\/)(?:apps|packages\/ralph|packages\/dev-tools|integrations)\//.test(target),
      )
    )
      errors.push(`Engine imports outer application/tool source: ${path}`);
  }
  for (const required of [
    "packages/contracts/package.json",
    ["packages", "engine", "src", "public", "index.ts"].join("/"),
    "apps/operator/package.json",
    "apps/platform/package.json",
    "workflows/graph-native-default.workflow.json",
    "integrations/agent-adapters/content/spec/adapter-manifest.json",
  ])
    if (!files.includes(required)) errors.push(`Missing architecture boundary: ${required}`);
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = architectureViolations();
  console.log(
    errors.length
      ? `FAIL: architecture boundaries\n${errors.join("\n")}`
      : "PASS: architecture boundaries",
  );
  process.exitCode = errors.length ? 1 : 0;
}
