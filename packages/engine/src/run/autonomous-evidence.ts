/** Enforces recorded Codex command evidence against the approved verification plan. */
import { isAbsolute, relative, resolve, sep } from "node:path";

const EVIDENCE_PHASES = new Set(["build", "quality-static", "quality-tests", "post-build"]);
interface VerificationCommand extends Record<string, unknown> {
  command?: unknown;
  working_directory?: unknown;
  evidence_roles?: unknown;
  evidence_kind?: unknown;
}
interface CommandEvent extends Record<string, unknown> {
  successful?: unknown;
  exit_code?: unknown;
  phase?: unknown;
  working_directory?: unknown;
  command?: unknown;
}
interface AgentEvidenceResult extends Record<string, unknown> {
  provider?: unknown;
  commandEvents?: CommandEvent[];
  commandEventCount?: unknown;
}
export interface CommandEvidenceAssessment extends Record<string, unknown> {
  required: boolean;
  status: "not-applicable" | "present" | "missing";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function normalizeCommand(command: unknown): string {
  return String(command ?? "").trim();
}

function containedPath(value: string): boolean {
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function normalizeWorkingDirectory(value: unknown, workspaceRoot: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const base = resolve(workspaceRoot ?? process.cwd());
  const relativePath = relative(base, isAbsolute(value) ? resolve(value) : resolve(base, value));
  if (!relativePath) return ".";
  return containedPath(relativePath) ? relativePath.split(sep).join("/") : null;
}

function plannedCommands(plan: unknown, phase: string): VerificationCommand[] {
  return recordArray(recordValue(plan).verification_commands).filter(
    (entry): entry is VerificationCommand =>
      Array.isArray(entry.evidence_roles) &&
      entry.evidence_roles.includes(phase) &&
      (phase !== "quality-tests" || entry.evidence_kind === "tests"),
  );
}

function successfulKeys(
  result: AgentEvidenceResult,
  phase: string,
  workspaceRoot: string,
): Set<string> {
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

function recordMissingEvidence(phase: string, artifact: Record<string, unknown>): void {
  if (phase === "build") {
    const groups = Array.isArray(artifact.groups) ? artifact.groups : [];
    artifact.groups = [
      ...groups,
      {
        group_id: "runtime-command-evidence",
        status: "fail",
        tasks_completed: 0,
        tasks_total: 1,
        errors: ["Codex emitted no command_execution event for build verification"],
      },
    ];
    return;
  }
  const violations = Array.isArray(artifact.violations) ? artifact.violations : [];
  artifact.violations = [
    ...violations,
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
  const summary = recordValue(artifact.summary);
  artifact.summary = {
    ...summary,
    fail: Math.max(1, typeof summary.fail === "number" ? summary.fail : 0),
    open: Math.max(1, typeof summary.open === "number" ? summary.open : 0),
  };
  const bundle = recordValue(artifact.evidence_bundle);
  const references = Array.isArray(bundle.references) ? bundle.references : [];
  const missingTypes = Array.isArray(bundle.missing_types) ? bundle.missing_types : [];
  const residualGaps = Array.isArray(bundle.residual_gaps) ? bundle.residual_gaps : [];
  artifact.evidence_bundle = {
    status: "partial",
    references,
    missing_types: [...new Set([...missingTypes, "codex-command-event"])],
    residual_gaps: [
      ...new Set([
        ...residualGaps,
        `No successful completed plan.verification_commands execution was captured for ${phase}`,
      ]),
    ],
  };
}

/** Requires every role-bound planned command to have a successful Codex event. */
export function enforceCommandEvidence(
  phase: string,
  result: AgentEvidenceResult,
  artifact: Record<string, unknown>,
  plan: unknown,
  workspaceRoot: string,
): CommandEvidenceAssessment {
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
