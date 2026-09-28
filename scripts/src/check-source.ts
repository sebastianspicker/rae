/** Require purpose headers and reject tracked editor residue in maintained source. */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";
export function sourceViolations(): string[] {
  const errors: string[] = [];
  for (const path of repositoryFiles(true))
    if (/(^|\/)(?:\.DS_Store|Thumbs\.db|.*\.(?:swp|swo|tmp|bak|orig))$/.test(path))
      errors.push(`Tracked editor residue: ${path}`);
  for (const path of repositoryFiles()) {
    if (
      !/^(?:scripts|evals|packages|profiles|tools|tests|docs|apps|integrations)\//.test(path) ||
      /(?:^|\/)(?:node_modules|dist|build|\.pipeline|\.runtime)\//.test(path)
    )
      continue;
    if (!/\.(?:[cm]?js|[cm]?ts|c|h)$/.test(path) && basename(path) !== "Dockerfile") continue;
    const source = readFileSync(resolve(repositoryRoot, path), "utf8")
      .replace(/^#![^\n]*\n/, "")
      .trimStart();
    if (
      basename(path) === "Dockerfile" ? !/^#\s*.{12}/.test(source) : !/^(?:\/\*|\/\/)/.test(source)
    )
      errors.push(`Missing source purpose header: ${path}`);
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = sourceViolations();
  console.log(
    errors.length
      ? `FAIL: source documentation\n${errors.join("\n")}`
      : "PASS: source headers and repository hygiene",
  );
  process.exitCode = errors.length ? 1 : 0;
}
