/** Persists fingerprinted PRD state and derived Ralph operational artifacts. */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { atomicWriteRelative } from "./safe-fs.js";
import { readRelative } from "./safe-fs.js";
import { EXIT, RalphError } from "./errors.js";
import { isoUtc, safeRelativePath, sha256 } from "./util.js";
import { loadPrd, storyById } from "./prd.js";
import type { Mode, Prd, RuntimePaths, Story } from "./types.js";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function definitions(prd: Prd): unknown[] {
  return prd.stories
    .map((story) => ({
      id: story.id,
      title: story.title,
      priority: story.priority,
      mode: story.mode,
      scope: story.scope,
      acceptance_criteria: story.acceptance_criteria,
      objective: story.objective ?? "",
      steps: story.steps ?? [],
      verification: story.verification ?? [],
      out_of_scope: story.out_of_scope ?? [],
      notes: story.notes ?? "",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function fingerprints(prd: Prd): { project: string; ids: string; definitions: string } {
  return {
    project: sha256(`${stable({ project: prd.project ?? "" })}\n`),
    ids: sha256(`${stable(prd.stories.map((story) => story.id).sort())}\n`),
    definitions: sha256(`${stable(definitions(prd))}\n`),
  };
}

export function exportState(prd: Prd): object {
  const marks = fingerprints(prd);
  return {
    project: prd.project ?? "",
    project_fingerprint_sha256: marks.project,
    story_ids_fingerprint_sha256: marks.ids,
    story_definitions_fingerprint_sha256: marks.definitions,
    stories: prd.stories.map((story) => ({
      id: story.id,
      passes: story.passes,
      skipped: story.skipped === true,
      report_path: story.report_path ?? "",
      completed_at: story.completed_at ?? "",
      skip_reason: story.skip_reason ?? "",
      skipped_at: story.skipped_at ?? "",
    })),
    exported_at: isoUtc(),
  };
}

interface ImportedStory {
  id: string;
  passes?: boolean;
  skipped?: boolean;
  report_path?: string;
  completed_at?: string;
  skip_reason?: string;
  skipped_at?: string;
}
interface ImportedState {
  project: string;
  project_fingerprint_sha256: string;
  story_ids_fingerprint_sha256: string;
  story_definitions_fingerprint_sha256: string;
  stories: ImportedStory[];
}

export function importState(paths: RuntimePaths, prd: Prd, file: string): Prd {
  let imported: ImportedState;
  try {
    imported = JSON.parse(readFileSync(file, "utf8")) as ImportedState;
  } catch {
    throw new RalphError(`Invalid import-state payload: ${file}`, EXIT.prd);
  }
  if (!imported || typeof imported.project !== "string" || !Array.isArray(imported.stories))
    throw new RalphError(
      "Invalid import-state payload: expected fingerprinted story status objects",
      EXIT.prd,
    );
  const ids = new Set<string>();
  for (const item of imported.stories) {
    if (
      !item ||
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      [item.passes, item.skipped].some(
        (value) => value !== undefined && typeof value !== "boolean",
      ) ||
      [item.report_path, item.completed_at, item.skip_reason, item.skipped_at].some(
        (value) => value !== undefined && typeof value !== "string",
      )
    )
      throw new RalphError(
        "Invalid import-state payload: expected unique ids and boolean/string fields only",
        EXIT.prd,
      );
    ids.add(item.id);
  }
  const marks = fingerprints(prd);
  if (
    imported.project_fingerprint_sha256 !== marks.project ||
    imported.story_ids_fingerprint_sha256 !== marks.ids ||
    imported.story_definitions_fingerprint_sha256 !== marks.definitions
  )
    throw new RalphError(
      "Import-state fingerprints do not match the current project/story definitions",
      EXIT.prd,
    );
  const updates = new Map(imported.stories.map((item) => [item.id, item]));
  const next = structuredClone(prd);
  for (const story of next.stories) {
    const update = updates.get(story.id);
    if (!update) continue;
    Object.assign(story, update);
    if (story.passes !== true) {
      delete story.report_path;
      delete story.completed_at;
    }
    if (story.skipped !== true) {
      delete story.skip_reason;
      delete story.skipped_at;
    }
  }
  writePrd(paths, next);
  loadPrd(paths);
  return next;
}

export function writePrd(paths: RuntimePaths, prd: Prd, writeRoot = paths.repoRoot): void {
  const relativePath = safeRelativePath(
    relative(paths.repoRoot, paths.prdFile).split("\\").join("/"),
  );
  atomicWriteRelative(writeRoot, relativePath, `${JSON.stringify(prd, null, 2)}\n`);
}

export function markPassed(
  paths: RuntimePaths,
  prd: Prd,
  id: string,
  reportPath: string,
  writeRoot = paths.repoRoot,
): void {
  const story = storyById(prd, id);
  story.passes = true;
  story.skipped = false;
  story.report_path = reportPath;
  story.completed_at = isoUtc();
  delete story.skip_reason;
  delete story.skipped_at;
  writePrd(paths, prd, writeRoot);
}

export function resetStory(paths: RuntimePaths, prd: Prd, id: string): void {
  const story = storyById(prd, id);
  story.passes = false;
  story.skipped = false;
  delete story.report_path;
  delete story.completed_at;
  delete story.skip_reason;
  delete story.skipped_at;
  writePrd(paths, prd);
  clearFailure(paths, id);
}

export function resetSkipped(paths: RuntimePaths, prd: Prd): number {
  let count = 0;
  for (const story of prd.stories)
    if (story.skipped) {
      count++;
      story.passes = false;
      story.skipped = false;
      delete story.report_path;
      delete story.completed_at;
      delete story.skip_reason;
      delete story.skipped_at;
    }
  if (count) writePrd(paths, prd);
  atomicWriteRelative(
    paths.repoRoot,
    safeRelativePath(
      relative(paths.repoRoot, join(paths.stateDir, "story-failures.tsv")).split("\\").join("/"),
    ),
    "",
  );
  return count;
}

function failureFile(paths: RuntimePaths): string {
  return join(paths.stateDir, ".story-failures.tsv");
}
function failures(paths: RuntimePaths): Map<string, number> {
  try {
    const rel = safeRelativePath(
      relative(paths.repoRoot, failureFile(paths)).split("\\").join("/"),
    );
    const result = new Map<string, number>();
    for (const line of readRelative(paths.repoRoot, rel, 1024 * 1024)
      .toString("utf8")
      .split("\n")
      .filter(Boolean)) {
      const match = /^([^\t]+)\t([1-9]\d*)$/u.exec(line);
      if (!match || result.has(match[1] ?? "") || !Number.isSafeInteger(Number(match[2])))
        throw new RalphError("Story failure state is invalid", EXIT.scope);
      result.set(match[1] ?? "", Number(match[2]));
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}
function writeFailures(paths: RuntimePaths, values: Map<string, number>): void {
  const text = [...values]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${id}\t${count}`)
    .join("\n");
  atomicWriteRelative(
    paths.repoRoot,
    safeRelativePath(relative(paths.repoRoot, failureFile(paths)).split("\\").join("/")),
    text ? `${text}\n` : "",
  );
}
export function incrementFailure(paths: RuntimePaths, id: string): number {
  const values = failures(paths);
  const count = (values.get(id) ?? 0) + 1;
  values.set(id, count);
  writeFailures(paths, values);
  return count;
}
export function clearFailure(paths: RuntimePaths, id: string): void {
  const values = failures(paths);
  values.delete(id);
  writeFailures(paths, values);
}
export function skipStory(paths: RuntimePaths, prd: Prd, id: string, reason: string): void {
  const story = storyById(prd, id);
  story.passes = false;
  story.skipped = true;
  story.skip_reason = reason;
  story.skipped_at = isoUtc();
  delete story.report_path;
  delete story.completed_at;
  writePrd(paths, prd);
}

export function writeProgress(
  paths: RuntimePaths,
  prd: Prd,
  output = join(paths.packageRoot, "progress.txt"),
): void {
  const passed = prd.stories.filter((story) => story.passes).length;
  const skipped = prd.stories.filter((story) => story.skipped).length;
  const lines = [
    "# Ralph Audit Progress (Generated)",
    "",
    `Source of truth: \`${basename(paths.prdFile)}\` (\`stories[].passes\`).`,
    "This file is generated. Regenerate with: `ralph-helper generate-progress`.",
    "",
    `Generated at (UTC): ${isoUtc()}`,
    "",
    "## Runtime Snapshot",
    "",
    `- Stories passed: \`${passed}/${prd.stories.length}\``,
    `- Stories skipped: \`${skipped}\``,
    `- Remaining: \`${prd.stories.length - passed - skipped}\``,
    "",
    "## Mode Breakdown",
    "",
  ];
  for (const mode of [...new Set(prd.stories.map((story) => story.mode))].sort()) {
    const items = prd.stories.filter((story) => story.mode === mode);
    lines.push(
      `- \`${mode}\`: total=${items.length}, passed=${items.filter((story) => story.passes).length}, skipped=${items.filter((story) => story.skipped).length}, remaining=${items.filter((story) => !story.passes && !story.skipped).length}`,
    );
  }
  lines.push("", "## Story Status", "");
  for (const story of [...prd.stories].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  ))
    lines.push(
      `- [${story.passes ? "x" : story.skipped ? "-" : " "}] \`${story.id}\` (\`${story.mode}\`, priority=${story.priority}, steps=${story.steps?.length ?? 0}${story.skipped ? ", skipped" : ""})`,
    );
  const rel = relative(paths.repoRoot, output).split("\\").join("/");
  atomicWriteRelative(paths.repoRoot, safeRelativePath(rel), `${lines.join("\n")}\n`, 0o600);
}

export function appendProgress(
  paths: RuntimePaths,
  story: Story,
  mode: Mode,
  report: string,
  output = join(paths.packageRoot, "progress.log.md"),
): void {
  const file = resolve(output);
  const header = existsSync(file)
    ? ""
    : "# Ralph Progress Log (Append-Only)\n\n## Codebase Patterns\n\n- Add reusable patterns here over time.\n\n## Entries\n";
  appendSafe(
    paths,
    file,
    `${header}\n### ${isoUtc()} UTC | ${story.id}\n- Mode: ${mode}\n- Title: ${story.title}\n- Report: ${report}\n`,
  );
}

export function recordLearning(
  paths: RuntimePaths,
  id: string,
  note: string,
  files = "",
  output = join(paths.packageRoot, "learnings.md"),
): void {
  const header = existsSync(output)
    ? ""
    : "# Ralph Learnings (Append-Only)\n\nThis file stores durable, reusable learnings across iterations.\nDo not rewrite history; append new entries only.\n\n## Codebase Patterns\n\n- Add stable cross-story patterns here (short bullets).\n\n## Learning Log\n\n<!-- Append entries below this line -->\n";
  appendSafe(
    paths,
    output,
    `${header}\n### ${isoUtc()} UTC | ${id}\n- Note: ${note}\n${files ? `- Files: ${files}\n` : ""}`,
  );
}

function appendSafe(paths: RuntimePaths, file: string, content: string): void {
  const absolute = resolve(file);
  if (!absolute.startsWith(`${paths.repoRoot}/`))
    throw new RalphError(`append target escapes repository: ${file}`, EXIT.scope);
  const rel = safeRelativePath(relative(paths.repoRoot, absolute).split("\\").join("/"));
  let existing = "";
  try {
    existing = readRelative(paths.repoRoot, rel, 16 * 1024 * 1024).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  atomicWriteRelative(paths.repoRoot, rel, `${existing}${content}`);
}

export function aggregateReports(paths: RuntimePaths, prd: Prd): string | null {
  const reportDir = safeRelativePath(prd.defaults.report_dir, "defaults.report_dir");
  const absolute = join(paths.repoRoot, reportDir);
  if (!existsSync(absolute)) return null;
  if (realpathSync.native(absolute) !== absolute)
    throw new RalphError("defaults.report_dir must be a canonical directory", EXIT.scope);
  const reports: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "summary.md")
        reports.push(relative(absolute, path).split("\\").join("/"));
    }
  };
  walk(absolute);
  reports.sort();
  const output = join(absolute, "summary.md");
  const content = `# Ralph Reports Summary\n\nGenerated at (UTC): ${isoUtc()}\n\n## Reports\n\n${reports.map((item) => `- [${item}](${item})`).join("\n")}\n`;
  atomicWriteRelative(
    paths.repoRoot,
    safeRelativePath(relative(paths.repoRoot, output).split("\\").join("/")),
    content,
  );
  return output;
}
