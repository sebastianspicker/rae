export function progressView(state, summary, phases, readGate) {
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

export const progressPhases = (state, defaults) =>
  Array.isArray(state.phase_order) ? state.phase_order : defaults;

export function buildProgressArtifact(runId, state, summary, progress, updatedAt) {
  return {
    run_id: runId,
    current_phase: state.current_phase,
    workspace_mode: state.workspace?.mode ?? "main-repo",
    phase_status: progress.phaseStatus,
    gate_totals: progress.totals,
    blockers: progress.blockers,
    activity_summary: summary.activity_resolutions ?? [],
    cost_summary: {
      total_cost_usd: summary.total_cost_usd ?? 0,
      total_tokens_in: summary.total_tokens_in ?? 0,
      total_tokens_out: summary.total_tokens_out ?? 0,
    },
    next_action: progress.nextAction,
    updated_at: updatedAt,
  };
}

function progressPhase(phase, state, completed, readGate) {
  const gateStatus = readGate(phase)?.status ?? "pending";
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

export function renderProgressSummary(runId, artifact, format) {
  if (format === "json") return "";
  return format === "text"
    ? renderProgressText(runId, artifact)
    : renderProgressMarkdown(runId, artifact);
}

function renderProgressText(runId, artifact) {
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

function renderProgressMarkdown(runId, artifact) {
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

const blockerTextRows = (blockers) => blockers.map((blocker) => `  - ${blocker}`);
const blockerMarkdownRows = (blockers) =>
  blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : ["- None"];
