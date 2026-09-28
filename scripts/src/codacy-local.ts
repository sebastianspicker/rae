#!/usr/bin/env node
/** Run pinned Node/native quality tools and retain sanitized Codacy results. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
import { sanitizeCodacy } from "./sanitize-reports.js";
import { checkComplexity } from "./check-complexity.js";
import { writeQualityFile, readQualityJson } from "./quality-files.js";

interface ToolPolicy {
  toolId: string;
  patterns: unknown[];
}
interface ToolResult {
  toolId: string;
  status?: string;
  version?: string;
}
const ADAPTERS = ["Hadolint", "markdownlint", "Trivy", "Semgrep", "jackson"];
const NATIVE_VERSION = "2.5.2";
const PINNED_VERSIONS = { Hadolint: "2.14.0", Trivy: "0.72.0", Semgrep: "1.25.0" };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid quality report object");
  return value as Record<string, unknown>;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Missing quality report array");
  return value;
}
function toolResult(value: unknown): ToolResult {
  const item = record(value);
  if (typeof item.toolId !== "string") throw new Error("Missing quality tool identifier");
  return {
    toolId: item.toolId,
    ...(typeof item.status === "string" ? { status: item.status } : {}),
    ...(typeof item.version === "string" ? { version: item.version } : {}),
  };
}
export function assertInspection(value: unknown): void {
  const report = record(value);
  const capability = record(report.capability);
  if (rows(report.errors).length || rows(capability.unavailable).length)
    throw new Error("Codacy inspect found unavailable or failed configured tools");
  const ready = rows(capability.ready).map(toolResult);
  for (const id of ADAPTERS)
    if (!ready.some((tool) => tool.toolId === id))
      throw new Error(`Codacy adapter unavailable: ${id}`);
  for (const [id, expected] of Object.entries(PINNED_VERSIONS))
    if (ready.find((tool) => tool.toolId === id)?.version !== expected)
      throw new Error(`Codacy adapter ${id} must be ${expected}`);
}
export function assertCompleteAnalysis(value: unknown): number {
  const report = record(value);
  const tools = rows(report.toolResults).map(toolResult);
  if (
    rows(report.errors).length ||
    !tools.length ||
    tools.some((tool) => tool.status !== "success") ||
    ADAPTERS.some((id) => !tools.some((tool) => tool.toolId === id && tool.status === "success"))
  )
    throw new Error("Codacy analysis has failed or partial tools");
  return rows(report.issues).length;
}
function run(command: string, args: string[], capture = false): { output: string; status: number } {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status === null)
    throw new Error(`${command} did not finish normally`);
  return { output: capture ? result.stdout : "", status: result.status };
}
function requireSuccess(command: string, args: string[]): void {
  if (run(command, args).status !== 0) throw new Error(`${command} failed`);
}
export function runCodacy(args: string[] = []): void {
  const config = record(
    JSON.parse(readFileSync(join(repositoryRoot, ".codacy/codacy.config.json"), "utf8")) as unknown,
  );
  const tools = rows(config.tools).map((value): ToolPolicy => {
    const item = record(value);
    if (typeof item.toolId !== "string") throw new Error("Invalid tool policy");
    return { toolId: item.toolId, patterns: rows(item.patterns) };
  });
  for (const id of ADAPTERS)
    if (!tools.some((tool) => tool.toolId === id))
      throw new Error(`Missing required policy: ${id}`);
  const reportRoot = join(repositoryRoot, ".codacy/reports");
  const temporary = join(repositoryRoot, ".codacy/tmp");
  const biome = join(repositoryRoot, "node_modules/.bin/biome");
  const version = run(biome, ["--version"], true);
  if (version.status !== 0 || version.output.match(/\d+\.\d+\.\d+/)?.[0] !== NATIVE_VERSION)
    throw new Error(`Native Biome must be ${NATIVE_VERSION}`);
  requireSuccess(biome, ["check", "."]);
  checkComplexity();
  // Trivy's native misconfiguration scanner replaces the Python Checkov runtime.
  const trivy = join(process.env.HOME ?? "", ".codacy/tools/Trivy/trivy");
  const trivyVersion = run(trivy, ["--version"], true);
  if (
    trivyVersion.status !== 0 ||
    trivyVersion.output.match(/\d+\.\d+\.\d+/)?.[0] !== PINNED_VERSIONS.Trivy
  )
    throw new Error(`Native Trivy must be ${PINNED_VERSIONS.Trivy}`);
  requireSuccess(trivy, [
    "config",
    "--exit-code",
    "1",
    "--severity",
    "MEDIUM,HIGH,CRITICAL",
    "--skip-dirs",
    ".git,node_modules,.cache,apps/platform/node_modules",
    ".",
  ]);
  writeQualityFile(
    "reports",
    "codacy-local-native-tool-versions.json",
    `${JSON.stringify(
      {
        nativePolicyToolVersions: [
          { toolId: "Biome", version: NATIVE_VERSION },
          { toolId: "Trivy-config", version: PINNED_VERSIONS.Trivy },
        ],
        analysisStatus: "passed",
      },
      null,
      2,
    )}\n`,
  );
  const supported = join(temporary, "codacy-supported-tools.config.json");
  writeQualityFile(
    "tmp",
    "codacy-supported-tools.config.json",
    JSON.stringify({ ...config, tools: tools.filter((tool) => ADAPTERS.includes(tool.toolId)) }),
  );
  const launcher = [
    "exec",
    "--yes",
    "--package=@codacy/analysis-cli@0.11.0",
    "--",
    "codacy-analysis",
  ];
  const inspect = run(
    "npm",
    [...launcher, "analyze", "--config-file", supported, "--inspect", "--output-format", "json"],
    true,
  );
  if (inspect.status !== 0) throw new Error("Codacy inspection failed");
  writeQualityFile("tmp", "codacy-local-inspect.json", inspect.output);
  assertInspection(JSON.parse(inspect.output) as unknown);
  const rawPath = join(temporary, "codacy-local-raw.json");
  writeQualityFile("tmp", "codacy-local-raw.json", "");
  const analysis = run("npm", [
    ...launcher,
    "analyze",
    "--config-file",
    supported,
    "--fail-if-missing",
    "--output-format",
    "json",
    "--output",
    rawPath,
    ...args,
  ]);
  const raw = readQualityJson("tmp", "codacy-local-raw.json");
  const sanitizedPath = join(reportRoot, "codacy-local-sanitized.json");
  writeQualityFile(
    "reports",
    "codacy-local-sanitized.json",
    `${JSON.stringify(sanitizeCodacy(raw), null, 2)}\n`,
  );
  const issues = assertCompleteAnalysis(raw);
  if (issues)
    throw new Error(`Codacy found ${issues} issue(s); sanitized report: ${sanitizedPath}`);
  if (analysis.status !== 0)
    throw new Error(`Codacy exited ${analysis.status} without reported issues`);
  console.log(`Codacy local analysis passed; sanitized report: ${sanitizedPath}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCodacy(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
