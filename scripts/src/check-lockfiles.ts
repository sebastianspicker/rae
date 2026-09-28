#!/usr/bin/env node
/** Refuse cached-checkout verification when local package manifests diverge from either npm lock. */
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
type ObjectValue = Record<string, unknown>;
const fields = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "engines",
  "workspaces",
];
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Package metadata must be an object");
  return value as ObjectValue;
}
function read(path: string): ObjectValue {
  return object(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
}
export function manifestLockDifferences(
  manifest: ObjectValue,
  locked: ObjectValue | undefined,
): string[] {
  if (!locked) return ["missing package entry"];
  return fields.filter(
    (field) => canonical(manifest[field] ?? null) !== canonical(locked[field] ?? null),
  );
}
function localDependencies(directory: string, manifest: ObjectValue): string[] {
  const dependencies: string[] = [];
  if (Array.isArray(manifest.workspaces)) {
    for (const workspace of manifest.workspaces) {
      if (typeof workspace !== "string" || /[*?{}]/.test(workspace))
        throw new Error("Lock verification requires explicit workspace directories");
      dependencies.push(resolve(directory, workspace));
    }
  }
  for (const group of ["dependencies", "optionalDependencies", "devDependencies"]) {
    for (const specifier of Object.values(object(manifest[group] ?? {}))) {
      if (typeof specifier === "string" && specifier.startsWith("file:"))
        dependencies.push(resolve(directory, specifier.slice(5)));
    }
  }
  return dependencies;
}
export function checkLockfiles(root = repositoryRoot): string[] {
  const failures: string[] = [];
  for (const lockDirectory of [root, resolve(root, "apps/platform")]) {
    const lock = read(resolve(lockDirectory, "package-lock.json"));
    if (lock.lockfileVersion !== 3) throw new Error("Expected npm lockfileVersion 3");
    const packages = object(lock.packages);
    const visited = new Set<string>();
    const pending = [lockDirectory];
    while (pending.length) {
      const directory = pending.shift();
      if (!directory || visited.has(directory)) continue;
      visited.add(directory);
      const manifest = read(resolve(directory, "package.json"));
      const key = relative(lockDirectory, directory).split(sep).join("/");
      const entry = packages[key];
      const differences = manifestLockDifferences(
        manifest,
        entry === undefined ? undefined : object(entry),
      );
      if (differences.length)
        failures.push(
          `${relative(root, lockDirectory) || "root"} lock: ${key || "."}: ${differences.join(", ")}`,
        );
      pending.push(...localDependencies(directory, manifest));
    }
  }
  return failures;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = checkLockfiles();
    if (failures.length) throw new Error(`Dependency locks are stale:\n${failures.join("\n")}`);
    console.log("Both npm locks match local package manifests");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
