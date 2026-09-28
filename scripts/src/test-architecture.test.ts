/** Purpose: preserve one-way engine layering and reject non-TypeScript source outside dist. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { engineLayerViolations, nonTypescriptSourceViolations } from "./check-architecture.js";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";

/** Builds an engine source path without embedding a literal internal-import string. */
function enginePath(...segments: string[]): string {
  return ["packages", "engine", "src", ...segments].join("/");
}

test("engineLayerViolations accepts an import from a lower engine layer", () => {
  const files = new Map([
    [enginePath("run", "example.ts"), 'import { isWithinRoot } from "../primitives/paths.js";\n'],
  ]);
  assert.deepEqual(engineLayerViolations(files), []);
});

test("engineLayerViolations rejects a lower layer importing a higher layer", () => {
  const files = new Map([
    [
      enginePath("primitives", "example.ts"),
      'import { runAgentPhase } from "../agents/agent-executor.js";\n',
    ],
  ]);
  assert.deepEqual(engineLayerViolations(files), [
    `Engine layer primitives imports disallowed layer agents: ${enginePath("primitives", "example.ts")}`,
  ]);
});

test("engineLayerViolations rejects agents importing run or workflow", () => {
  const files = new Map([
    [
      enginePath("agents", "example.ts"),
      'import { runProcess } from "../run/autonomous-git.js";\n',
    ],
  ]);
  assert.deepEqual(engineLayerViolations(files), [
    `Engine layer agents imports disallowed layer run: ${enginePath("agents", "example.ts")}`,
  ]);
});

test("engineLayerViolations passes the current repository engine sources", () => {
  const enginePrefix = `${enginePath()}/`;
  const engineFiles = new Map<string, string>();
  for (const path of repositoryFiles()) {
    if (path.startsWith(enginePrefix) && path.endsWith(".ts"))
      engineFiles.set(path, readFileSync(resolve(repositoryRoot, path), "utf8"));
  }
  assert.ok(engineFiles.size > 0);
  assert.deepEqual(engineLayerViolations(engineFiles), []);
});

test("nonTypescriptSourceViolations rejects non-TypeScript source under maintained trees", () => {
  assert.deepEqual(
    nonTypescriptSourceViolations([
      "scripts/benchmarks/example.mjs",
      "packages/ralph/ralph.sh",
      "integrations/agent-adapters/scripts/generate.py",
      "apps/operator/static/app.js",
      "scripts/src/example.ts",
    ]),
    [
      "Source must be TypeScript: scripts/benchmarks/example.mjs",
      "Source must be TypeScript: packages/ralph/ralph.sh",
      "Source must be TypeScript: integrations/agent-adapters/scripts/generate.py",
      "Source must be TypeScript: apps/operator/static/app.js",
    ],
  );
});

test("nonTypescriptSourceViolations ignores trees outside maintained source", () => {
  assert.deepEqual(nonTypescriptSourceViolations(["docs/example.mjs", "README.md"]), []);
});
