#!/usr/bin/env node
/** Parses every private engine module as a dependency-free build check. */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function moduleFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathValue = join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(pathValue);
    return entry.name.endsWith(".mjs") ? [pathValue] : [];
  });
}

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const files = moduleFiles(sourceRoot);
const fileSet = new Set(files.map((file) => normalize(file)));
const failures = [];
const dependencies = new Map();
const incoming = new Map(files.map((file) => [normalize(file), 0]));

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${file}\n${result.stderr}`);

  const imports = [];
  const source = readFileSync(file, "utf8");
  const importPattern = /(?:from\s+|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const target = normalize(resolve(dirname(file), match[1]));
    const resolvedTarget = fileSet.has(target) ? target : normalize(join(target, "index.mjs"));
    if (fileSet.has(resolvedTarget)) {
      imports.push(resolvedTarget);
      incoming.set(resolvedTarget, (incoming.get(resolvedTarget) ?? 0) + 1);
    }
  }
  dependencies.set(normalize(file), imports);
}

const visiting = new Set();
const visited = new Set();
function visit(file, trail) {
  if (visiting.has(file)) {
    const cycleStart = trail.indexOf(file);
    const cycle = [...trail.slice(cycleStart), file]
      .map((entry) => entry.slice(sourceRoot.length + 1))
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
  "/cli/",
  "/tests/",
  "/public/index.mjs",
  "/run/verification-broker.mjs",
];
for (const [file, count] of incoming) {
  const relativePath = file.slice(sourceRoot.length);
  if (count === 0 && !allowedEntrypoints.some((entrypoint) => relativePath.includes(entrypoint))) {
    failures.push(`orphan engine module: ${relativePath.slice(1)}`);
  }
}
if (failures.length) throw new Error(failures.join("\n"));
