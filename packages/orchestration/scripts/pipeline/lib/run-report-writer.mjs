/** Builds durable autonomous run reports from gate and workspace state. */
import { existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { changedPaths } from "./autonomous-git.mjs";
import { documentationAssessment } from "./autonomous-phase-contract.mjs";
import { readJsonStrict, writeJson } from "./state.mjs";

export function writeRunReport(context, outcome) {
  const data = reportData(context, outcome);
  writeDocumentationReport(data);
  writeMarkdownReport(data);
  return reportResult(data);
}

function reportData(context, outcome) {
  const runDir = resolve(context.workspaceRoot, ".pipeline", "runs", context.runId);
  const changes = changedPaths(context.workspaceRoot);
  const gates = gateRows(runDir);
  const state = readJsonStrict(resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"));
  const plan = readPlan(runDir);
  const docs = documentationAssessment(plan, changes, buildExecuted(gates));
  return { context, outcome, runDir, changes, gates, state, docs, cleanupCommand: state.workspace?.cleanup_command ?? null, status: reportStatus(outcome, gates), agentEventLogs: eventLogs(context.workspaceRoot, runDir) };
}

function readPlan(runDir) {
  const pathValue = resolve(runDir, "plan.json");
  return existsSync(pathValue) ? readJsonStrict(pathValue) : null;
}

function buildExecuted(gates) { return gates.some((gate) => gate.phase === "build" && gate.status !== "not-run"); }
function eventLogs(workspaceRoot, runDir) { return PHASE_ORDER.map((phase) => resolve(runDir, "agent-outputs", `${phase}.events.jsonl`)).filter(existsSync).map((pathValue) => relative(workspaceRoot, pathValue)); }
function reportStatus(outcome, gates) {
  if (outcome.error) return "blocked";
  if (outcome.status === "waiting") return "waiting-for-human-checkpoint";
  if (outcome.status === "stopped") return "stopped-by-operator";
  return gates.filter((gate) => ["pass", "warn"].includes(gate.status)).length === PHASE_ORDER.length ? "implemented-awaiting-human-release-review" : "stopped-at-requested-phase";
}

function gateRows(runDir) {
  return PHASE_ORDER.map((phase) => {
    const gateName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
    const pathValue = resolve(runDir, "gates", gateName);
    if (!existsSync(pathValue)) return { phase, status: "not-run", artifact_ref: "" };
    const gate = readJsonStrict(pathValue);
    return { phase, status: gate.status, artifact_ref: gate.artifact_ref };
  });
}

function writeDocumentationReport(data) {
  const { context, docs, runDir } = data;
  writeJson(resolve(runDir, "documentation-report.json"), {
    schema_version: "1.0.0", run_id: context.runId, status: docs.status, required: docs.required,
    expected_paths: docs.expected_paths, changed_files: docs.changed_files, missing_paths: docs.missing_paths,
    run_report: `.pipeline/runs/${context.runId}/run-report.md`, rationale: docs.rationale,
  });
}

function writeMarkdownReport(data) {
  const reportPath = resolve(data.runDir, "run-report.md");
  writeFileSync(reportPath, markdownLines(data).join("\n"), { encoding: "utf8", mode: 0o600 });
}

function markdownLines(data) {
  return [...reportHeader(data), ...taskSection(data.context.task), ...gateSection(data.gates), ...evidenceSection(data.agentEventLogs), ...changesSection(data.changes), ...documentationSection(data.docs), ...residualSection(data.outcome), ...nextAction(data.context.workspaceRoot, data.cleanupCommand), ""];
}

function reportHeader(data) {
  const { context, state, status, outcome, cleanupCommand } = data;
  return [
    `# RAE Autonomous Run ${context.runId}`, "", `- Status: **${status}**`, workspaceLine(context),
    workspaceModeLine(state), branchLine(state), cleanupLine(cleanupCommand), providerLine(outcome), policyLine(context),
    "- Release action: `none` (RAE does not commit, push, publish, or deploy)", "",
  ];
}

function cleanupLine(cleanupCommand) { return `- Cleanup command: ${cleanupCommand ? `\`${cleanupCommand}\`` : "not applicable"}`; }
function workspaceLine(context) { return `- Workspace: \`${context.workspaceRoot}\``; }
function workspaceModeLine(state) { return `- Workspace mode: \`${state.workspace?.mode ?? "unknown"}\``; }
function branchLine(state) { return `- Branch: \`${state.workspace?.branch || "(detached or unchanged)"}\``; }
function providerLine(outcome) { return `- Provider: \`${outcome.provider ?? "unknown"}\``; }
function policyLine(context) { return `- Policy: \`${context.policy?.policy_id ?? "default"}\` (\`${context.policyDigest ?? "legacy"}\`)`; }

function taskSection(task) { return ["## Task", "", ...task.split("\n").map((line) => `> ${line}`), ""]; }
function gateSection(gates) { return ["## Phase gates", "", "| Phase | Status | Artifact |", "| --- | --- | --- |", ...gates.map((gate) => `| ${gate.phase} | ${gate.status} | ${gate.artifact_ref || "None"} |`), ""]; }
function evidenceSection(logs) { return ["## Agent execution evidence", "", ...(logs.length ? logs.map((pathValue) => `- \`${pathValue}\``) : ["- No Codex event logs (test provider or no completed agent call)."]), ""]; }
function changesSection(changes) { return ["## Changed files", "", ...(changes.length ? changes.map((pathValue) => `- \`${pathValue}\``) : ["- None"]), ""]; }
function documentationSection(docs) { return ["## Documentation", "", `- Status: \`${docs.status}\``, `- Required by plan: ${docs.required === null ? "undecided" : docs.required}`, ...docs.expected_paths.map((pathValue) => `- Expected: \`${pathValue}\``), ...docs.changed_files.map((pathValue) => `- \`${pathValue}\``), ...docs.missing_paths.map((pathValue) => `- Missing: \`${pathValue}\``), ""]; }
function residualSection(outcome) { return ["## Residual state", "", ...(outcome.error ? [`- Blocker: ${outcome.error}`] : ["- Human diff/release review remains required."]), ""]; }
function nextAction(workspaceRoot, cleanupCommand) { return ["## Next action", "", `Inspect the workspace with \`git -C "${workspaceRoot}" diff\` and review the gate artifacts before deciding whether to commit or release.`, ...(cleanupCommand ? [`After preserving any wanted change, clean up with \`${cleanupCommand}\`.`] : [])]; }
function reportResult(data) { return { status: data.status, changes: data.changes, gates: data.gates, docs: data.docs, reportPath: resolve(data.runDir, "run-report.md"), runDir: data.runDir, cleanupCommand: data.cleanupCommand }; }
