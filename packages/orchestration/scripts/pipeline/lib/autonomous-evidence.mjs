/** Enforces recorded Codex command evidence against the approved verification plan. */
import { isAbsolute, relative, resolve, sep } from "node:path";

const EVIDENCE_PHASES = new Set(["build", "quality-static", "quality-tests", "post-build"]);

function normalizeCommand(command) {
  return String(command ?? "").trim();
}

function containedPath(value) {
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function normalizeWorkingDirectory(value, workspaceRoot) {
  if (typeof value !== "string" || !value.trim()) return null;
  const base = resolve(workspaceRoot ?? process.cwd());
  const relativePath = relative(base, isAbsolute(value) ? resolve(value) : resolve(base, value));
  if (!relativePath) return ".";
  return containedPath(relativePath) ? relativePath.split(sep).join("/") : null;
}

function plannedCommands(plan, phase) {
  return (plan?.verification_commands ?? []).filter(
    (entry) =>
      Array.isArray(entry.evidence_roles) &&
      entry.evidence_roles.includes(phase) &&
      (phase !== "quality-tests" || entry.evidence_kind === "tests"),
  );
}

function successfulKeys(result, phase, workspaceRoot) {
  return new Set(
    (result.commandEvents ?? [])
      .filter(
        (event) =>
          event.successful === true &&
          event.exit_code === 0 &&
          event.phase === phase &&
          normalizeWorkingDirectory(event.working_directory, workspaceRoot) !== null,
      )
      .map(
        (event) =>
          `${normalizeWorkingDirectory(event.working_directory, workspaceRoot)}\0${normalizeCommand(event.command)}`,
      ),
  );
}

function recordMissingEvidence(phase, artifact) {
  if (phase === "build") {
    recordMissingBuildEvidence(artifact);
    return;
  }
  recordMissingQualityEvidence(phase, artifact);
}

function recordMissingBuildEvidence(artifact) {
  artifact.groups = [...(artifact.groups ?? []), {
    group_id: "runtime-command-evidence", status: "fail", tasks_completed: 0, tasks_total: 1,
    errors: ["Codex emitted no command_execution event for build verification"],
  }];
}

function recordMissingQualityEvidence(phase, artifact) {
  artifact.violations = [
    ...(artifact.violations ?? []),
    {
      rule: "command-execution-evidence",
      severity: "high",
      file: ".pipeline",
      evidence: `Codex emitted no command_execution event during ${phase}`,
      remediation: "Execute the required project verification and return its evidence",
      status: "open",
      ...(phase === "post-build" ? { category: "production-exposure" } : {}),
    },
  ];
  artifact.summary = {
    ...(artifact.summary ?? {}),
    fail: Math.max(1, artifact.summary?.fail ?? 0),
    open: Math.max(1, artifact.summary?.open ?? 0),
  };
  artifact.evidence_bundle = {
    status: "partial",
    references: artifact.evidence_bundle?.references ?? [],
    missing_types: [
      ...new Set([...(artifact.evidence_bundle?.missing_types ?? []), "codex-command-event"]),
    ],
    residual_gaps: [
      ...new Set([
        ...(artifact.evidence_bundle?.residual_gaps ?? []),
        `No successful completed plan.verification_commands execution was captured for ${phase}`,
      ]),
    ],
  };
}

/** Requires every role-bound planned command to have a successful Codex event. */
export function enforceCommandEvidence(phase, result, artifact, plan, workspaceRoot) {
  if (result.provider !== "codex" || !EVIDENCE_PHASES.has(phase))
    return { required: result.provider === "codex", status: "not-applicable" };
  const required = plannedCommands(plan, phase);
  const keys = successfulKeys(result, phase, workspaceRoot);
  const matched = required.filter((entry) => {
    const workingDirectory = normalizeWorkingDirectory(entry.working_directory, workspaceRoot);
    return (
      workingDirectory !== null &&
      keys.has(`${workingDirectory}\0${normalizeCommand(entry.command)}`)
    );
  });
  if (required.length > 0 && matched.length === required.length) {
    return {
      required: true,
      status: "present",
      command_event_count: result.commandEventCount,
      successful_command_event_count: keys.size,
      matched_planned_command_count: matched.length,
      required_planned_command_count: required.length,
    };
  }
  recordMissingEvidence(phase, artifact);
  return { required: true, status: "missing", command_event_count: 0 };
}
