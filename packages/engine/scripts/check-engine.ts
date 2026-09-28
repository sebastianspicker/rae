#!/usr/bin/env node
/** Parses every private engine module as a dependency-free build check. */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function moduleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathValue = join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(pathValue);
    return entry.name.endsWith(".js") ? [pathValue] : [];
  });
}

const engineRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const sourceRoot = resolve(engineRoot, "src");
const files = moduleFiles(sourceRoot);
const fileSet = new Set(files.map((file) => normalize(file)));
const failures: string[] = [];
const dependencies = new Map<string, string[]>();
const incoming = new Map<string, number>(files.map((file) => [normalize(file), 0]));

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}\n${result.stderr}`);

  const imports: string[] = [];
  const source = readFileSync(file, "utf8");
  const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) continue;
    const target = normalize(resolve(dirname(file), specifier));
    const resolvedTarget = fileSet.has(target) ? target : normalize(join(target, "index.js"));
    if (fileSet.has(resolvedTarget)) {
      imports.push(resolvedTarget);
      incoming.set(resolvedTarget, (incoming.get(resolvedTarget) ?? 0) + 1);
    }
  }
  dependencies.set(normalize(file), imports);
}

const visiting = new Set<string>();
const visited = new Set<string>();
function visit(file: string, trail: string[]): void {
  if (visiting.has(file)) {
    const cycleStart = trail.indexOf(file);
    const cycle = [...trail.slice(cycleStart), file]
      .map((entry) => relative(engineRoot, entry))
      .join(" -> ");
    failures.push(`engine import cycle: ${cycle}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of dependencies.get(file) ?? []) visit(dependency, [...trail, file]);
  visiting.delete(file);
  visited.add(file);
}

for (const file of dependencies.keys()) visit(file, []);

const allowedEntrypoints = [
  "/src/cli/",
  "/src/public/index.js",
  "/src/run/verification-broker.js",
  "/src/workflow/workflow-proposal-helper.js",
];
for (const [file, count] of incoming) {
  const relativePath = `/${relative(engineRoot, file)}`;
  if (count === 0 && !allowedEntrypoints.some((entrypoint) => relativePath.includes(entrypoint))) {
    failures.push(`orphan engine module: ${relativePath.slice(1)}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
