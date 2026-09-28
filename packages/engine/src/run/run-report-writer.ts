/** Builds durable autonomous run reports from gate and workspace state. */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { PHASE_ORDER } from "./constants.js";
import { changedPaths } from "./autonomous-git.js";
import { documentationAssessment } from "./autonomous-phase-contract.js";
import { readJsonStrict, writeJson } from "./state.js";
import type { DocumentationAssessment } from "./autonomous-phase-contract.js";
import type { AutonomousLifecycleContext } from "./autonomous-lifecycle.js";

interface RunOutcome extends Record<string, unknown> {
  provider?: unknown;
  status?: unknown;
  error?: unknown;
}
interface GateRow {
  phase: string;
  status: unknown;
  artifact_ref: unknown;
}
interface ReportData {
  context: AutonomousLifecycleContext;
  outcome: RunOutcome;
  runDir: string;
  changes: string[];
  gates: GateRow[];
  state: Record<string, unknown>;
  docs: DocumentationAssessment;
  cleanupCommand: unknown;
  status: string;
  agentEventLogs: string[];
  graphNative: boolean;
}
export interface RunReportResult {
  status: string;
  changes: string[];
  gates: GateRow[];
  docs: DocumentationAssessment;
  reportPath: string;
  runDir: string;
  cleanupCommand: unknown;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function writeRunReport(
  context: AutonomousLifecycleContext,
  outcome: RunOutcome,
): RunReportResult {
  const data = reportData(context, outcome);
  writeDocumentationReport(data);
  writeMarkdownReport(data);
  return reportResult(data);
}

function reportData(context: AutonomousLifecycleContext, outcome: RunOutcome): ReportData {
  const runDir = resolve(context.workspaceRoot, ".pipeline", "runs", context.runId);
  const changes = changedPaths(context.workspaceRoot);
  const graphNative = context.workflowMode === "graph-native";
  const gates = graphNative ? graphRows(runDir) : gateRows(runDir);
  const state = readJsonStrict(resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"));
  const plan = graphNative ? readGraphPlan(context, runDir) : readPlan(runDir);
  const docs = documentationAssessment(
    plan,
    changes,
    graphNative ? changes.length > 0 : buildExecuted(gates),
  );
  return {
    context,
    outcome,
    runDir,
    changes,
    gates,
    state,
    docs,
    cleanupCommand: recordValue(state.workspace).cleanup_command ?? null,
    status: reportStatus(outcome, gates, graphNative),
    agentEventLogs: graphNative
      ? graphEventLogs(context.workspaceRoot, runDir)
      : eventLogs(context.workspaceRoot, runDir),
    graphNative,
  };
}

function workflowEnvelopeFiles(runDir: string): string[] {
  const root = resolve(runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(resolve(root, entry.name))
        .filter((name) => name.endsWith(".json"))
        .map((name) => resolve(root, entry.name, name)),
    );
}

function readGraphPlan(
  context: AutonomousLifecycleContext,
  runDir: string,
): { documentation?: { required: boolean; paths: string[]; rationale: string } | null } | null {
  const nodeId = context.workflow?.nodes.find((node) => node.ownership_plan === true)?.id;
  if (!nodeId) return null;
  const envelopes = workflowEnvelopeFiles(runDir)
    .map((pathValue) => readJsonStrict(pathValue))
    .filter((envelope) => envelope.node_id === nodeId && envelope.status === "passed")
    .sort((left, right) => Number(left.loop_iteration ?? 1) - Number(right.loop_iteration ?? 1));
  const payload = envelopes.at(-1)?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as {
        documentation?: { required: boolean; paths: string[]; rationale: string } | null;
      })
    : null;
}

function graphRows(runDir: string): GateRow[] {
  const latest = new Map<unknown, GateRow & { attempt: number }>();
  for (const pathValue of workflowEnvelopeFiles(runDir)) {
    const envelope = readJsonStrict(pathValue);
    const instanceId = envelope.instance_id ?? envelope.node_id;
    const prior = latest.get(instanceId);
    const attempt = typeof envelope.attempt === "number" ? envelope.attempt : 0;
    if (!prior || attempt >= prior.attempt) {
      latest.set(instanceId, {
        phase: String(instanceId),
        status: envelope.status,
        artifact_ref: relative(runDir, pathValue),
        attempt,
      });
    }
  }
  return [...latest.values()].sort((left, right) => left.phase.localeCompare(right.phase));
}

function readPlan(
  runDir: string,
): { documentation?: { required: boolean; paths: string[]; rationale: string } | null } | null {
  const pathValue = resolve(runDir, "plan.json");
  return existsSync(pathValue)
    ? (readJsonStrict(pathValue) as {
        documentation?: { required: boolean; paths: string[]; rationale: string } | null;
      })
    : null;
}

function buildExecuted(gates: GateRow[]): boolean {
  return gates.some((gate) => gate.phase === "build" && gate.status !== "not-run");
}
function eventLogs(workspaceRoot: string, runDir: string): string[] {
  return PHASE_ORDER.map((phase) => resolve(runDir, "agent-outputs", `${phase}.events.jsonl`))
    .filter(existsSync)
    .map((pathValue) => relative(workspaceRoot, pathValue));
}
function graphEventLogs(workspaceRoot: string, runDir: string): string[] {
  const directory = resolve(runDir, "workflow", "agent-outputs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".events.jsonl"))
    .sort()
    .map((name) => relative(workspaceRoot, resolve(directory, name)));
}
function reportStatus(outcome: RunOutcome, gates: GateRow[], graphNative: boolean): string {
  if (outcome.error) return "blocked";
  if (outcome.status === "waiting") return "waiting-for-human-checkpoint";
  if (outcome.status === "stopped") return "stopped-by-operator";
  if (graphNative) return "implemented-awaiting-human-release-review";
  return gates.filter((gate) => gate.status === "pass" || gate.status === "warn").length ===
    PHASE_ORDER.length
    ? "implemented-awaiting-human-release-review"
    : "stopped-at-requested-phase";
}

function gateRows(runDir: string): GateRow[] {
  return PHASE_ORDER.map((phase) => {
    const gateName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
    const pathValue = resolve(runDir, "gates", gateName);
    if (!existsSync(pathValue)) return { phase, status: "not-run", artifact_ref: "" };
    const gate = readJsonStrict(pathValue);
    return { phase, status: gate.status, artifact_ref: gate.artifact_ref };
  });
}

function writeDocumentationReport(data: ReportData): void {
  const { context, docs, runDir } = data;
  writeJson(resolve(runDir, "documentation-report.json"), {
    schema_version: "1.0.0",
    run_id: context.runId,
    status: docs.status,
    required: docs.required,
    expected_paths: docs.expected_paths,
    changed_files: docs.changed_files,
    missing_paths: docs.missing_paths,
    run_report: `.pipeline/runs/${context.runId}/run-report.md`,
    rationale: docs.rationale,
  });
}

function writeMarkdownReport(data: ReportData): void {
  const reportPath = resolve(data.runDir, "run-report.md");
  writeFileSync(reportPath, markdownLines(data).join("\n"), { encoding: "utf8", mode: 0o600 });
}

function markdownLines(data: ReportData): string[] {
  return [
    ...reportHeader(data),
    ...taskSection(data.context.task),
    ...gateSection(data.gates),
    ...evidenceSection(data.agentEventLogs),
    ...changesSection(data.changes),
    ...documentationSection(data.docs),
    ...residualSection(data.outcome),
    ...nextAction(data.context.workspaceRoot, data.cleanupCommand),
    "",
  ];
}

function reportHeader(data: ReportData): string[] {
  const { context, state, status, outcome, cleanupCommand } = data;
  return [
    `# RAE Autonomous Run ${context.runId}`,
    "",
    `- Status: **${status}**`,
    workspaceLine(context),
    workspaceModeLine(state),
    branchLine(state),
    cleanupLine(cleanupCommand),
    providerLine(outcome),
    policyLine(context),
    "- Release action: `none` (RAE does not commit, push, publish, or deploy)",
    "",
  ];
}

function cleanupLine(cleanupCommand: unknown): string {
  return `- Cleanup command: ${cleanupCommand ? `\`${cleanupCommand}\`` : "not applicable"}`;
}
function workspaceLine(context: AutonomousLifecycleContext): string {
  return `- Workspace: \`${context.workspaceRoot}\``;
}
function workspaceModeLine(state: Record<string, unknown>): string {
  return `- Workspace mode: \`${String(recordValue(state.workspace).mode ?? "unknown")}\``;
}
function branchLine(state: Record<string, unknown>): string {
  return `- Branch: \`${String(recordValue(state.workspace).branch || "(detached or unchanged)")}\``;
}
function providerLine(outcome: RunOutcome): string {
  return `- Provider: \`${outcome.provider ?? "unknown"}\``;
}
function policyLine(context: AutonomousLifecycleContext): string {
  return `- Policy: \`${context.policy?.policy_id ?? "default"}\` (\`${context.policyDigest ?? "legacy"}\`)`;
}

function taskSection(task: string): string[] {
  return ["## Task", "", ...task.split("\n").map((line) => `> ${line}`), ""];
}
function gateSection(gates: GateRow[]): string[] {
  return [
    "## Gates and node instances",
    "",
    "| Phase | Status | Artifact |",
    "| --- | --- | --- |",
    ...gates.map((gate) => `| ${gate.phase} | ${gate.status} | ${gate.artifact_ref || "None"} |`),
    "",
  ];
}
function evidenceSection(logs: string[]): string[] {
  return [
    "## Agent execution evidence",
    "",
    ...(logs.length
      ? logs.map((pathValue) => `- \`${pathValue}\``)
      : ["- No Codex event logs (test provider or no completed agent call)."]),
    "",
  ];
}
function changesSection(changes: string[]): string[] {
  return [
    "## Changed files",
    "",
    ...(changes.length ? changes.map((pathValue) => `- \`${pathValue}\``) : ["- None"]),
    "",
  ];
}
function documentationSection(docs: DocumentationAssessment): string[] {
  return [
    "## Documentation",
    "",
    `- Status: \`${docs.status}\``,
    `- Required by plan: ${docs.required === null ? "undecided" : docs.required}`,
    ...docs.expected_paths.map((pathValue) => `- Expected: \`${pathValue}\``),
    ...docs.changed_files.map((pathValue) => `- \`${pathValue}\``),
    ...docs.missing_paths.map((pathValue) => `- Missing: \`${pathValue}\``),
    "",
  ];
}
function residualSection(outcome: RunOutcome): string[] {
  return [
    "## Residual state",
    "",
    ...(outcome.error
      ? [`- Blocker: ${outcome.error}`]
      : ["- Human diff/release review remains required."]),
    "",
  ];
}
function nextAction(workspaceRoot: string, cleanupCommand: unknown): string[] {
  return [
    "## Next action",
    "",
    `Inspect the workspace with \`git -C "${workspaceRoot}" diff\` and review the gate artifacts before deciding whether to commit or release.`,
    ...(cleanupCommand
      ? [`After preserving any wanted change, clean up with \`${cleanupCommand}\`.`]
      : []),
  ];
}
function reportResult(data: ReportData): RunReportResult {
  return {
    status: data.status,
    changes: data.changes,
    gates: data.gates,
    docs: data.docs,
    reportPath: resolve(data.runDir, "run-report.md"),
    runDir: data.runDir,
    cleanupCommand: data.cleanupCommand,
  };
}
