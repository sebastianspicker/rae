/** Prevents consumers from bypassing the engine's supported public import boundary. */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const sourceRoots = ["apps", "packages", "scripts"];
const sourceExtensions = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathValue = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || pathValue === resolve(repositoryRoot, "packages/engine")) return [];
      return sourceFiles(pathValue);
    }
    return sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [pathValue] : [];
  });
}

test("outside consumers import engine only through the package export", () => {
  const violations = [];
  for (const root of sourceRoots) {
    const directory = resolve(repositoryRoot, root);
    for (const file of sourceFiles(directory)) {
      const contents = readFileSync(file, "utf8");
      const directInternalImport = /["'][^"']*packages\/engine\/src\//.test(contents);
      if (directInternalImport) violations.push(relative(repositoryRoot, file));
    }
  }
  assert.deepEqual(violations, []);
});
