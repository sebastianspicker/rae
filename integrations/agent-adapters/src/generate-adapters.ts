#!/usr/bin/env node
/** Render runner guidance from the manifest, rejecting paths outside the repository. */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

type Mapping = Record<string, unknown>;
function mapping(value: unknown, label: string): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Mapping;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
export function resolveRepoPath(root: string, raw: string): string {
  if (isAbsolute(raw)) throw new Error(`Repository-relative path required: ${raw}`);
  let candidate = resolve(root, raw);
  const pending: string[] = [];
  while (!existsSync(candidate)) {
    pending.unshift(basename(candidate));
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("Unresolvable root");
    candidate = parent;
  }
  candidate = resolve(realpathSync(candidate), ...pending);
  const child = relative(realpathSync(root), candidate);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error(`Path escapes repository root: ${raw}`);
  return candidate;
}
export function renderTemplate(path: string, values: Record<string, string>): string {
  let content = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(values))
    content = content.replaceAll(`{{${key}}}`, value);
  const unresolved = [
    ...new Set([...content.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1])),
  ].sort();
  if (unresolved.length)
    throw new Error(`${path}: unresolved template tokens: ${unresolved.join(", ")}`);
  return content.endsWith("\n") ? content : `${content}\n`;
}
interface GenerationOptions {
  check: boolean;
  runners?: string[];
  manifest: string;
}
export function generate(
  root: string,
  options: GenerationOptions,
): { writes: number; mismatches: string[] } {
  const manifest = mapping(
    JSON.parse(readFileSync(resolveRepoPath(root, options.manifest), "utf8")),
    "manifest",
  );
  if (!Array.isArray(manifest.runners) || !manifest.runners.length)
    throw new Error("Manifest has no runners");
  if (!Array.isArray(manifest.stage_order) || !manifest.stage_order.length)
    throw new Error("Manifest missing stage_order");
  const stages = manifest.stage_order.map((stage) => string(stage, "stage"));
  const runners = manifest.runners.map((runner) => mapping(runner, "runner"));
  const available = new Set(runners.map((runner) => string(runner.name, "runner name")));
  const requested = new Set(options.runners ?? available);
  for (const runner of requested)
    if (!available.has(runner)) throw new Error(`Unknown runner: ${runner}`);
  const generation = mapping(manifest.generation ?? {}, "generation");
  const templates = resolveRepoPath(
    root,
    string(
      generation.template_root ?? "integrations/agent-adapters/content/templates",
      "template_root",
    ),
  );
  const mirrors = mapping(generation.legacy_mirrors ?? {}, "legacy_mirrors");
  const roots = mapping(mirrors.root_entries ?? {}, "root_entries");
  const result = { writes: 0, mismatches: [] as string[] };
  function write(target: string, content: string, optional = false): void {
    const path = resolveRepoPath(root, target);
    if (optional && !existsSync(path)) return;
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === content) return;
    if (options.check) {
      result.mismatches.push(target);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    result.writes++;
  }
  for (const runner of runners) {
    const id = string(runner.name, "runner name");
    if (!requested.has(id)) continue;
    const values = {
      RUNNER_TITLE: string(
        runner.title || id[0].toUpperCase() + id.slice(1).toLowerCase(),
        "runner title",
      ),
      ADAPTER_ROOT: string(
        runner.skills_root || `integrations/agent-adapters/content/${id}/skills`,
        "skills_root",
      ),
    };
    resolveRepoPath(root, values.ADAPTER_ROOT);
    const stageMap = mapping(runner.stage_adapters ?? {}, "stage_adapters");
    for (const stage of stages) {
      const target = string(stageMap[stage], `runner ${id} stage ${stage}`);
      const stageDirectory = basename(dirname(target));
      const content = renderTemplate(
        resolve(templates, "skills", stageDirectory, "SKILL.md.tmpl"),
        values,
      );
      write(target, content);
      if (id === "cursor" && mirrors.cursor_skills_root)
        write(
          `${string(mirrors.cursor_skills_root, "cursor_skills_root")}/${stageDirectory}/SKILL.md`,
          content,
          true,
        );
    }
    if (runner.pipeline_skill)
      write(
        string(runner.pipeline_skill, "pipeline_skill"),
        renderTemplate(resolve(templates, "skills/orchestration-pipeline/SKILL.md.tmpl"), values),
      );
    if (id === "codex" && mirrors.codex_playbook)
      write(
        string(mirrors.codex_playbook, "codex_playbook"),
        renderTemplate(resolve(templates, "skills/orchestration/SKILL.md.tmpl"), values),
        true,
      );
    if (roots[id])
      write(
        string(roots[id], "root entry"),
        renderTemplate(resolve(templates, "root", `${id.toUpperCase()}.md.tmpl`), values),
        true,
      );
  }
  return result;
}
export function main(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      runner: { type: "string", multiple: true },
      manifest: {
        type: "string",
        default: "integrations/agent-adapters/content/spec/adapter-manifest.json",
      },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Generate adapters: [--check] [--runner ID] [--manifest repository/path.json]");
    return 0;
  }
  const root = resolve(import.meta.dirname, "../../..");
  const result = generate(root, {
    check: values.check,
    runners: values.runner,
    manifest: values.manifest,
  });
  if (result.mismatches.length) {
    console.error(`FAIL: adapter sync check failed:\n${result.mismatches.join("\n")}`);
    return 1;
  }
  console.log(
    values.check
      ? "OK: adapter templates and generated files are in sync"
      : `OK: generated adapter files (${result.writes} file(s) updated)`,
  );
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
