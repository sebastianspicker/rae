/** Validates PRD contracts and resolves story scope and report destinations. */
import { existsSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import { EXIT, RalphError } from "./errors.js";
import { readRelative } from "./safe-fs.js";
import { isWithin, safeRelativePath } from "./util.js";
import type { Mode, Prd, RuntimePaths, Story } from "./types.js";

const CREATED = /^Created\s+`?[^`\s]+`?(?:\s+.*)?$/;
const HIDDEN_CONTROL_RANGES = [
  [0, 8],
  [11, 12],
  [14, 31],
  [127, 159],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
] as const;
function hasHiddenControl(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (HIDDEN_CONTROL_RANGES.some(([lower, upper]) => code >= lower && code <= upper)) return true;
  }
  return false;
}
function assertVisibleValues(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === "string" && hasHiddenControl(current))
      throw new RalphError(
        "prd.json contains hidden control or bidirectional characters",
        EXIT.prd,
      );
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current && typeof current === "object")
      for (const [key, child] of Object.entries(current)) pending.push(key, child);
  }
}
function parsePrd(bytes: Buffer): unknown {
  let value: unknown;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new RalphError(`Invalid prd.json JSON: ${String(error)}`, EXIT.prd);
  }
  if (hasHiddenControl(text))
    throw new RalphError("prd.json contains hidden control or bidirectional characters", EXIT.prd);
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RalphError(`Invalid prd.json JSON: ${String(error)}`, EXIT.prd);
  }
  assertVisibleValues(value);
  return value;
}

const addFormats = createRequire(import.meta.url)("ajv-formats") as (validator: Ajv2020) => Ajv2020;

export function loadPrd(paths: RuntimePaths): Prd {
  for (const [path, label] of [
    [paths.prdFile, "PRD"],
    [paths.schemaFile, "PRD schema"],
    [paths.policyFile, "policy"],
  ] as const) {
    if (!existsSync(path)) throw new RalphError(`Missing ${label} file: ${path}`, EXIT.prd);
  }
  const packagePrefix = relative(paths.repoRoot, paths.packageRoot).split("\\").join("/");
  const fromRepo = (name: string): Buffer =>
    readRelative(
      paths.repoRoot,
      packagePrefix ? `${safeRelativePath(packagePrefix)}/${name}` : name,
      4 * 1024 * 1024,
    );
  const value = parsePrd(fromRepo("prd.json"));
  let schema: object;
  try {
    schema = JSON.parse(fromRepo("prd.schema.json").toString("utf8")) as object;
  } catch (error) {
    throw new RalphError(`Invalid PRD schema JSON: ${String(error)}`, EXIT.prd);
  }
  try {
    fromRepo("INSTRUCTIONS.md");
  } catch (error) {
    throw new RalphError(`Invalid policy file: ${String(error)}`, EXIT.prd);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    const details =
      validate.errors
        ?.map((item) => `${item.instancePath || "/"} ${item.message ?? "invalid"}`)
        .join("; ") ?? "schema validation failed";
    throw new RalphError(`Invalid prd.json structure or story constraints: ${details}`, EXIT.prd);
  }
  const prd = value as Prd;
  const ids = new Set<string>();
  for (const story of prd.stories) {
    if (ids.has(story.id)) throw new RalphError(`Duplicate story id: ${story.id}`, EXIT.prd);
    ids.add(story.id);
    const created = story.acceptance_criteria.filter((line) => CREATED.test(line));
    if (created.length !== 1)
      throw new RalphError(
        `Story ${story.id} must contain exactly one Created <path>.md acceptance criterion`,
        EXIT.prd,
      );
    extractReportPath(created[0] ?? "", prd, paths, false);
  }
  return prd;
}

export function openStories(prd: Prd, mode: Mode): Story[] {
  return prd.stories
    .filter((story) => story.mode === mode && story.passes !== true && story.skipped !== true)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function storyById(prd: Prd, id: string): Story {
  const story = prd.stories.find((item) => item.id === id);
  if (!story) throw new RalphError(`Unknown story id: ${id}`, EXIT.prd);
  return story;
}

export function createdLine(story: Story): string {
  const lines = story.acceptance_criteria.filter((line) => CREATED.test(line));
  if (lines.length !== 1)
    throw new RalphError(
      `Story ${story.id} must contain exactly one Created acceptance criterion`,
      EXIT.prd,
    );
  return lines[0] ?? "";
}

export function extractReportPath(
  line: string,
  prd: Prd,
  paths: RuntimePaths,
  strict = true,
): string {
  let first = line.slice("Created ".length).split(/\s/u)[0] ?? "";
  first = first.replace(/^`|`$/gu, "").replace(/^\.\//u, "");
  const relativePath = safeRelativePath(first, "Report path");
  if (!relativePath.endsWith(".md"))
    throw new RalphError(`Report path must end with .md: ${relativePath}`, EXIT.scope);
  const reportDir = safeRelativePath(prd.defaults.report_dir, "defaults.report_dir");
  if (strict && relativePath !== reportDir && !relativePath.startsWith(`${reportDir}/`)) {
    throw new RalphError(
      `Report path must stay under defaults.report_dir (${reportDir}): ${relativePath}`,
      EXIT.scope,
    );
  }
  const absolute = resolve(paths.repoRoot, relativePath);
  const nearest = nearestExisting(absolute);
  const realNearest = realpathSync.native(nearest);
  const effective = resolve(realNearest, absolute.slice(nearest.length).replace(/^\//u, ""));
  if (!isWithin(paths.repoRoot, effective))
    throw new RalphError(`Report path resolves outside repository: ${relativePath}`, EXIT.scope);
  if (
    !strict &&
    existsSync(absolute) &&
    relativePath !== reportDir &&
    !relativePath.startsWith(`${reportDir}/`) &&
    !relativePath.startsWith("audit/")
  ) {
    throw new RalphError(
      `Refusing to overwrite existing non-report file: ${relativePath}`,
      EXIT.scope,
    );
  }
  return relativePath;
}

function nearestExisting(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

function globRegex(pattern: string): RegExp {
  const clean = pattern.replace(/^\.\//u, "");
  let body = "";
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index] ?? "";
    if (char === "*") {
      if (clean[index + 1] === "*") {
        index++;
        if (clean[index + 1] === "/") {
          index++;
          body += "(?:.*/)?";
        } else body += ".*";
      } else body += "[^/]*";
    } else if (char === "?") body += "[^/]";
    else body += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${body}$`, "u");
}

export function pathMatchesScope(story: Story, path: string): boolean {
  const sawPositive = story.scope.some((raw) => raw.length > 0 && !raw.startsWith("!"));
  let matched = !sawPositive && story.scope.length > 0;
  for (const raw of story.scope) {
    if (!raw) continue;
    const negated = raw.startsWith("!");
    const pattern = negated ? raw.slice(1) : raw;
    if (globRegex(pattern).test(path)) matched = !negated;
  }
  return matched;
}

export function applyDefaults(
  prd: Prd,
  requested: { mode?: Mode; model?: string; reasoningEffort?: "low" | "medium" | "high" },
): {
  mode: Mode;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  maxStories: number | "all_open";
} {
  return {
    mode: requested.mode ?? prd.defaults.mode_default ?? "audit",
    model: requested.model ?? prd.defaults.model_default ?? "gpt-5.3",
    reasoningEffort: requested.reasoningEffort ?? prd.defaults.reasoning_effort_default ?? "high",
    maxStories: prd.defaults.max_stories_default ?? "all_open",
  };
}
