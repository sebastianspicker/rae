/** Implements Ralph's local authoring, archive, and embedded-bootstrap helpers. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { RalphError } from "./errors.js";
import { atomicWriteRelative } from "./safe-fs.js";
import { appendProgress, recordLearning, writeProgress } from "./state.js";
import { isoUtc, isoUtcCompact, safeRelativePath } from "./util.js";
import type { Mode, Prd, RuntimePaths, Story } from "./types.js";

const EMBEDDED_FILES = [
  "INSTRUCTIONS.md",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "learnings.md",
  "prd.json.example",
  "prd.schema.json",
  "skills/prd/SKILL.md",
  "skills/ralph/SKILL.md",
] as const;
const EMBEDDED_DEPENDENCIES = [
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
] as const;
const require = createRequire(import.meta.url);

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function existingDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory())
    throw new RalphError(`${label} does not exist: ${path}`);
  return realpathSync.native(absolute);
}

function helperPaths(root: string, prdFile = join(root, "prd.json")): RuntimePaths {
  return {
    packageRoot: root,
    repoRoot: root,
    prdFile,
    schemaFile: join(root, "prd.schema.json"),
    policyFile: join(root, "INSTRUCTIONS.md"),
    stateDir: join(root, ".runtime"),
    runLog: join(root, ".runtime", "run.log"),
    eventLog: join(root, ".runtime", "events.log"),
  };
}

function canonicalDestination(path: string): string {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return join(realpathSync.native(cursor), ...missing);
}

export function bootstrap(target: string, force = false): string {
  const targetRoot = existingDirectory(target, "target repo");
  const sourceRoot = packageRoot();
  const claude = join(targetRoot, ".claude");
  const destination = join(claude, "ralph-audit");
  if (existsSync(claude)) {
    const entry = lstatSync(claude);
    if (entry.isSymbolicLink()) throw new RalphError(`.claude must not be a symlink: ${claude}`);
    if (!entry.isDirectory()) throw new RalphError(`.claude must be a directory: ${claude}`);
  }
  if (existsSync(destination) && !force)
    throw new RalphError(`destination already exists: ${destination} (use --force to overwrite)`);
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relativePath of EMBEDDED_FILES) {
    const source = join(sourceRoot, relativePath);
    const output = join(destination, relativePath);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    cpSync(source, output, { preserveTimestamps: true });
  }
  const compiled = join(sourceRoot, "dist", "src");
  if (!existsSync(join(compiled, "cli.js")))
    throw new RalphError("compiled Ralph runtime is missing; run npm run build first");
  cpSync(compiled, join(destination, "dist", "src"), { recursive: true });
  const bridgeRoot = resolve(sourceRoot, "../fs-bridge");
  for (const item of ["package.json", "dist", "build"])
    cpSync(join(bridgeRoot, item), join(destination, "node_modules", "@rae", "fs-bridge", item), {
      recursive: true,
    });
  for (const dependency of EMBEDDED_DEPENDENCIES) {
    const dependencyRoot = dirname(require.resolve(`${dependency}/package.json`));
    cpSync(dependencyRoot, join(destination, "node_modules", dependency), {
      recursive: true,
      dereference: true,
    });
  }
  atomicWriteRelative(
    destination,
    "package.json",
    `${JSON.stringify(
      {
        name: "ralph-audit",
        private: true,
        version: "0.4.0",
        type: "module",
        engines: { node: ">=24.0.0" },
        bin: { ralph: "dist/src/cli.js", "ralph-helper": "dist/src/helper-cli.js" },
        scripts: { ralph: "node ./dist/src/cli.js" },
      },
      null,
      2,
    )}\n`,
  );
  return destination;
}

export function generateProgress(prdPath: string, outputPath: string): void {
  const absolutePrd = resolve(prdPath);
  if (!existsSync(absolutePrd)) throw new RalphError(`missing prd file: ${prdPath}`);
  const prd = JSON.parse(readFileSync(absolutePrd, "utf8")) as Prd;
  const root = existingDirectory(dirname(absolutePrd), "PRD parent");
  const paths = helperPaths(root, absolutePrd);
  const output = canonicalDestination(outputPath);
  const rel = relative(root, output);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new RalphError(`progress output escapes Ralph root: ${output}`);
  writeProgress(paths, prd, output);
}

export function syncAgents(rootPath: string): void {
  const root = existingDirectory(rootPath, "Ralph root");
  const learnings = join(root, "learnings.md");
  const agents = join(root, "AGENTS.md");
  if (!existsSync(learnings) || !existsSync(agents)) return;
  const latest = readFileSync(learnings, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("- Note: "))
    .at(-1);
  if (!latest) return;
  const current = readFileSync(agents, "utf8");
  if (current.split("\n").includes(latest)) return;
  const heading = "## Learned Patterns";
  const next = current.includes(heading)
    ? current.replace(heading, `${heading}\n\n${latest}`)
    : `${current.trimEnd()}\n\n${heading}\n\n${latest}\n`;
  atomicWriteRelative(root, "AGENTS.md", next);
}

export function recordLearningEntry(
  rootPath: string,
  id: string,
  note: string,
  files = "",
  outputPath?: string,
): string {
  const root = existingDirectory(rootPath, "Ralph root");
  const output = resolve(outputPath ?? join(root, "learnings.md"));
  recordLearning(helperPaths(root), id, note, files, output);
  return output;
}

export function appendProgressEntry(
  rootPath: string,
  id: string,
  mode: Mode,
  title: string,
  report: string,
  outputPath?: string,
): string {
  const root = existingDirectory(rootPath, "Ralph root");
  const story: Story = {
    id,
    mode,
    title,
    priority: 0,
    scope: [],
    acceptance_criteria: [],
    passes: false,
  };
  const output = resolve(outputPath ?? join(root, "progress.log.md"));
  appendProgress(helperPaths(root), story, mode, report, output);
  return output;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "run"
  );
}

export function archiveState(
  sourcePath: string,
  archivePath: string,
  label = "",
  reason = "",
  force = false,
): string {
  const source = existingDirectory(sourcePath, "source root");
  const archive = resolve(archivePath);
  if (archive === dirname(archive))
    throw new RalphError("archive root must not be filesystem root");
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const canonicalArchive = realpathSync.native(archive);
  const prdFile = join(source, "prd.json");
  const prd = existsSync(prdFile) ? (JSON.parse(readFileSync(prdFile, "utf8")) as Prd) : undefined;
  const target = join(
    canonicalArchive,
    `${isoUtcCompact()}-${slug(label || prd?.project || "run")}`,
  );
  if (existsSync(target) && !force)
    throw new RalphError(`archive target already exists: ${target} (use --force)`);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { mode: 0o700 });
  const items = ["prd.json", "progress.txt", "learnings.md"];
  if (prd?.defaults.report_dir) items.push(safeRelativePath(prd.defaults.report_dir));
  for (const item of items)
    if (existsSync(join(source, item)))
      cpSync(join(source, item), join(target, item), { recursive: true });
  const metadata = `archived_at_utc=${isoUtc()}\n${reason ? `reason=${reason}\n` : ""}source_root=${source}\n`;
  atomicWriteRelative(target, "archive.meta", metadata);
  return target;
}
