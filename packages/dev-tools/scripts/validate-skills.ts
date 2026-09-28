#!/usr/bin/env node
/** Validate generated AgentSkills names, frontmatter and bounded content contracts. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
interface SkillError {
  path: string;
  message: string;
}
export function validateSkill(directory: string): SkillError[] {
  const path = join(directory, "SKILL.md");
  if (!existsSync(path)) return [{ path: directory, message: "Missing SKILL.md" }];
  const body = readFileSync(path, "utf8"),
    lines = body.split(/\r?\n/),
    errors: SkillError[] = [];
  let name: string | undefined, description: string | undefined;
  const report = (message: string): void => {
    errors.push({ path, message });
  };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (lines[0]?.trim() !== "---") report("Missing YAML frontmatter (must start with ---).");
  else if (end < 0) report("Unterminated YAML frontmatter (missing closing ---).");
  else {
    for (const raw of lines.slice(1, end)) {
      const line = raw.trim();
      const match = line.match(/^(name|description):\s*(.+?)\s*$/);
      if (!match) continue;
      const value = match[2]
        .trim()
        .replace(/^"+|"+$/g, "")
        .replace(/^'+|'+$/g, "");
      if (match[1] === "name" && name === undefined) name = value;
      if (match[1] === "description" && description === undefined) description = value;
    }
    if (name === undefined) report("Frontmatter missing required field: name");
    if (description === undefined) report("Frontmatter missing required field: description");
  }
  if (name !== undefined) {
    if (name.length > 64) report(`name too long (${name.length} > 64)`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) report(`Invalid name: ${JSON.stringify(name)}`);
    if (name !== basename(directory))
      report(
        `name ${JSON.stringify(name)} does not match directory ${JSON.stringify(basename(directory))}`,
      );
  }
  if (description !== undefined && (!description.length || description.length > 1024))
    report(`description length out of range (${description.length}; must be 1..1024)`);
  const lineCount = body.split("\n").length;
  if (lineCount > 500) report(`SKILL.md too long (${lineCount} lines > 500)`);
  const deep = body.match(/\b(?:assets|references|scripts)\/[^\s)]+\/[^\s)]+/);
  if (deep) report(`Deep file reference found: ${JSON.stringify(deep[0])}`);
  return errors;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseRoots(args: readonly string[]): string[] {
  const manifestRoots: string[] = [],
    roots: string[] = [],
    repeated: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!["--root", "--roots", "--manifest"].includes(argument) || !args[index + 1])
      throw new Error(
        `Usage: validate-skills [--root PATH] [--roots PATH,PATH] [--manifest PATH]; invalid ${argument}`,
      );
    const value = args[++index];
    if (argument === "--roots") roots.push(...value.split(","));
    else if (argument === "--root") repeated.push(value);
    else {
      const manifest: unknown = JSON.parse(readFileSync(value, "utf8"));
      if (!record(manifest) || !Array.isArray(manifest.runners))
        throw new Error("Adapter manifest requires runners");
      for (const runner of manifest.runners) {
        if (
          !record(runner) ||
          (runner.skills_root !== undefined && typeof runner.skills_root !== "string")
        )
          throw new Error("Invalid runner skills_root");
        if (typeof runner.skills_root === "string" && runner.skills_root)
          manifestRoots.push(runner.skills_root);
      }
    }
  }
  const combined = [...manifestRoots, ...roots, ...repeated];
  return [
    ...new Set(
      (combined.length ? combined : [".codex/skills"]).map((value) => value.trim()).filter(Boolean),
    ),
  ];
}
export function validateRoots(roots: readonly string[]): number {
  const errors: SkillError[] = [],
    missing: string[] = [];
  let count = 0;
  for (const root of roots) {
    const directories = existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => join(root, entry.name))
          .sort()
      : [];
    if (!directories.length) missing.push(root);
    count += directories.length;
    for (const directory of directories) errors.push(...validateSkill(directory));
  }
  if (missing.length) {
    for (const root of missing) console.error(`${root}: no skill directories found`);
    console.error(`FAIL: ${missing.length} root(s) missing or empty`);
    return 2;
  }
  if (errors.length) {
    for (const error of errors) console.error(`${error.path}: ${error.message}`);
    console.error(`FAIL: ${errors.length} error(s)`);
    return 1;
  }
  console.log(`OK: validated ${count} skill(s) across ${roots.length} root(s)`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const roots = parseRoots(process.argv.slice(2));
    if (!roots.length) throw new Error("No skill roots resolved from arguments.");
    process.exitCode = validateRoots(roots);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
