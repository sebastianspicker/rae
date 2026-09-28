#!/usr/bin/env node
/** Retain only stable report fields without analyzer messages or workstation metadata. */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a report object");
  return value as RecordValue;
}
function rows(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Expected a report array");
  return value;
}
function fields(value: unknown, names: string[]): RecordValue {
  const source = record(value);
  return Object.fromEntries(names.map((name) => [name, source[name] ?? null]));
}
export function sanitizeCodacy(value: unknown): RecordValue {
  const report = record(value);
  return {
    schemaVersion: 1,
    metadata: fields(report.metadata ?? {}, [
      "startedAt",
      "completedAt",
      "durationMs",
      "executionMode",
    ]),
    toolResults: rows(report.toolResults).map((row) =>
      fields(row, ["toolId", "status", "issueCount", "errorCount", "durationMs", "filesAnalyzed"]),
    ),
    issues: rows(report.issues).map((row) =>
      fields(row, [
        "toolId",
        "patternId",
        "filePath",
        "line",
        "column",
        "endColumn",
        "severity",
        "category",
      ]),
    ),
    errors: rows(report.errors).map((row) =>
      fields(row, ["toolId", "filePath", "kind", "level", "phase"]),
    ),
  };
}
export function sanitizeCodeql(value: unknown): RecordValue[] {
  return rows(value)
    .flatMap((report) => rows(record(report).runs))
    .flatMap((run) => rows(record(run).results))
    .map((value) => {
      const result = record(value);
      return {
        ...fields(result, ["ruleId", "level"]),
        locations: rows(result.locations).map((value) => {
          const physical = record(record(value).physicalLocation ?? {});
          return {
            artifactUri: record(physical.artifactLocation ?? {}).uri ?? null,
            ...fields(physical.region ?? {}, ["startLine", "startColumn"]),
          };
        }),
      };
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [format, input, output, extra] = process.argv.slice(2);
    if (!["codacy", "codeql"].includes(format ?? "") || extra)
      throw new Error("Usage: sanitize-reports <codacy|codeql> [input.json] [output.json]");
    const source: unknown = JSON.parse(readFileSync(input ?? 0, "utf8"));
    const sanitized = `${JSON.stringify(format === "codacy" ? sanitizeCodacy(source) : sanitizeCodeql(source), null, 2)}\n`;
    if (output) writeFileSync(output, sanitized, { mode: 0o600 });
    else process.stdout.write(sanitized);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
