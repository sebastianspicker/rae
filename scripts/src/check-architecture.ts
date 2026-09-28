/** Enforce public package boundaries and repository ownership during source checks. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";

const ENGINE_LAYERS = [
  "primitives",
  "graph",
  "agents",
  "run",
  "workflow",
  "cli",
  "public",
] as const;
export type EngineLayer = (typeof ENGINE_LAYERS)[number];

/** Documented internal direction: cli -> {run, workflow} -> {agents, graph} -> primitives. */
const ENGINE_LAYER_ALLOWED_TARGETS: Record<EngineLayer, readonly EngineLayer[]> = {
  primitives: [],
  graph: ["primitives"],
  agents: ["primitives", "graph"],
  run: ["agents", "graph", "primitives", "run", "workflow"],
  workflow: ["agents", "graph", "primitives", "run", "workflow"],
  cli: ["agents", "graph", "primitives", "run", "workflow", "cli"],
  public: ENGINE_LAYERS,
};
const ENGINE_FILE_PATTERN = /^packages\/engine\/src\/([a-z]+)\/.+\.ts$/;
const ENGINE_RELATIVE_IMPORT_PATTERN = /(?:from\s+|import\s*(?:\(\s*)?)["']\.\.\/([a-z]+)\//g;

function isEngineLayer(value: string): value is EngineLayer {
  return (ENGINE_LAYERS as readonly string[]).includes(value);
}

const NON_TYPESCRIPT_SOURCE_PATTERN =
  /^(?:packages|apps|integrations|profiles|tools|scripts)\/.*\.(?:mjs|cjs|js|sh|py|jq)$/;

/** Rejects JavaScript, shell, Python and jq source under maintained trees; build output is excluded upstream. */
export function nonTypescriptSourceViolations(files: readonly string[]): string[] {
  return files
    .filter((path) => NON_TYPESCRIPT_SOURCE_PATTERN.test(path))
    .map((path) => `Source must be TypeScript: ${path}`);
}

/** Enforces one-way engine layering from relative imports in packages/engine/src. */
export function engineLayerViolations(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, source] of files) {
    const match = ENGINE_FILE_PATTERN.exec(path);
    if (!match?.[1] || !isEngineLayer(match[1])) continue;
    const layer = match[1];
    const allowed = ENGINE_LAYER_ALLOWED_TARGETS[layer];
    for (const importMatch of source.matchAll(ENGINE_RELATIVE_IMPORT_PATTERN)) {
      const targetLayer = importMatch[1];
      if (!targetLayer || !isEngineLayer(targetLayer) || targetLayer === layer) continue;
      if (!allowed.includes(targetLayer))
        errors.push(`Engine layer ${layer} imports disallowed layer ${targetLayer}: ${path}`);
    }
  }
  return errors;
}

export function architectureViolations(): string[] {
  const files = repositoryFiles();
  const errors: string[] = [];
  const engineFiles = new Map<string, string>();
  errors.push(...nonTypescriptSourceViolations(files));
  for (const path of files) {
    if (/^packages\/(?:orchestration|loops)\//.test(path))
      errors.push(`Legacy architecture path remains: ${path}`);
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(path)) continue;
    const source = readFileSync(resolve(repositoryRoot, path), "utf8");
    if (/^apps\/(?:operator|platform)\//.test(path) && /packages\/engine\/src\//.test(source))
      errors.push(`App bypasses @rae/engine public export: ${path}`);
    if (!path.startsWith("packages/engine/")) continue;
    if (ENGINE_FILE_PATTERN.test(path)) engineFiles.set(path, source);
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
  errors.push(...engineLayerViolations(engineFiles));
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
