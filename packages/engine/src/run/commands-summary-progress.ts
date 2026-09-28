/** Builds the operator-facing pipeline progress summary. */
import type { PipelineState } from "./state.js";

type SummaryRecord = Record<string, unknown>;
type GateStatus = "pass" | "warn" | "fail" | "pending";
interface PhaseProgress {
  phase: string;
  status: "blocked" | "completed" | "active" | "pending";
  gate_status: GateStatus;
}
interface ProgressView {
  phaseStatus: PhaseProgress[];
  totals: Record<GateStatus, number>;
  blockers: string[];
  nextAction: string;
  summary: SummaryRecord;
}
export interface ProgressArtifact extends Record<string, unknown> {
  run_id: string;
  current_phase: string | undefined;
  workspace_mode: unknown;
  phase_status: PhaseProgress[];
  gate_totals: Record<GateStatus, number>;
  blockers: string[];
  activity_summary: unknown;
  cost_summary: Record<string, unknown>;
  next_action: string;
  updated_at: string;
}

export function progressView(
  state: PipelineState,
  summary: SummaryRecord,
  phases: string[],
  readGate: (phase: string) => { status?: unknown } | null | undefined,
): ProgressView {
  const completed = new Set(Array.isArray(state.completed_gates) ? state.completed_gates : []);
  const phaseStatus = phases.map((phase) => progressPhase(phase, state, completed, readGate));
  const totals = { pass: 0, warn: 0, fail: 0, pending: 0 };
  for (const entry of phaseStatus) {
    totals[entry.gate_status] += 1;
  }
  const blockers = phaseStatus
    .filter((entry) => entry.status === "blocked")
    .map((entry) => `${entry.phase}:${entry.gate_status}`);
  const pending = phaseStatus.find((entry) => entry.status === "pending");
  return {
    phaseStatus,
    totals,
    blockers,
    nextAction: blockers.length
      ? `Resolve blockers in ${blockers.join(", ")}`
      : pending
        ? `Start phase ${pending.phase}`
        : `Continue or inspect phase ${state.current_phase}`,
    summary,
  };
}

export const progressPhases = (state: PipelineState, defaults: readonly string[]): string[] =>
  Array.isArray(state.phase_order)
    ? state.phase_order.filter((phase): phase is string => typeof phase === "string")
    : [...defaults];

export function buildProgressArtifact(
  runId: string,
  state: PipelineState,
  summary: SummaryRecord,
  progress: ProgressView,
  updatedAt: string,
): ProgressArtifact {
  return {
    run_id: runId,
    current_phase: state.current_phase,
    workspace_mode: state.workspace?.mode ?? "main-repo",
    phase_status: progress.phaseStatus,
    gate_totals: progress.totals,
    blockers: progress.blockers,
    activity_summary: summary.activity_resolutions ?? [],
    cost_summary: progressCostSummary(summary),
    next_action: progress.nextAction,
    updated_at: updatedAt,
  };
}

function progressCostSummary(summary: SummaryRecord): Record<string, unknown> {
  return {
    total_cost_usd: summary.total_cost_usd ?? 0,
    total_tokens_in: summary.total_tokens_in ?? 0,
    total_tokens_out: summary.total_tokens_out ?? 0,
  };
}

function progressPhase(
  phase: string,
  state: PipelineState,
  completed: Set<unknown>,
  readGate: (phase: string) => { status?: unknown } | null | undefined,
): PhaseProgress {
  const candidate = readGate(phase)?.status;
  const gateStatus: GateStatus =
    candidate === "pass" || candidate === "warn" || candidate === "fail" ? candidate : "pending";
  const status =
    gateStatus === "fail"
      ? "blocked"
      : completed.has(`${phase}-gate`) || gateStatus !== "pending"
        ? "completed"
        : state.current_phase === phase
          ? "active"
          : "pending";
  return { phase, status, gate_status: gateStatus };
}

export function renderProgressSummary(
  runId: string,
  artifact: ProgressArtifact,
  format: string,
): string {
  if (format === "json") return "";
  return format === "text"
    ? renderProgressText(runId, artifact)
    : renderProgressMarkdown(runId, artifact);
}

function renderProgressText(runId: string, artifact: ProgressArtifact): string {
  const blockers = artifact.blockers;
  const totals = artifact.gate_totals;
  return [
    `Progress summary: ${runId}`,
    `current_phase: ${artifact.current_phase}`,
    `workspace_mode: ${artifact.workspace_mode}`,
    `gates: pass=${totals.pass} warn=${totals.warn} fail=${totals.fail} pending=${totals.pending}`,
    `next_action: ${artifact.next_action}`,
    blockers.length > 0 ? `blockers (${blockers.length}):` : "blockers: none",
    ...blockerTextRows(blockers),
    "phase_status:",
    ...artifact.phase_status.map(
      (entry) => `  - ${entry.phase}: ${entry.status} (gate=${entry.gate_status})`,
    ),
    "",
  ].join("\n");
}

function renderProgressMarkdown(runId: string, artifact: ProgressArtifact): string {
  const totals = artifact.gate_totals;
  return [
    `# Progress Summary: ${runId}`,
    "",
    `- Current phase: \`${artifact.current_phase}\``,
    `- Workspace mode: \`${artifact.workspace_mode}\``,
    `- Gates: pass=\`${totals.pass}\`, warn=\`${totals.warn}\`, fail=\`${totals.fail}\`, pending=\`${totals.pending}\``,
    `- Next action: ${artifact.next_action}`,
    "",
    "## Phase Status",
    "",
    "| Phase | Status | Gate |",
    "| --- | --- | --- |",
    ...artifact.phase_status.map(
      (entry) => `| ${entry.phase} | ${entry.status} | ${entry.gate_status} |`,
    ),
    "",
    "## Blockers",
    "",
    ...blockerMarkdownRows(artifact.blockers),
    "",
  ].join("\n");
}

const blockerTextRows = (blockers: string[]): string[] =>
  blockers.map((blocker) => `  - ${blocker}`);
const blockerMarkdownRows = (blockers: string[]): string[] =>
  blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : ["- None"];
