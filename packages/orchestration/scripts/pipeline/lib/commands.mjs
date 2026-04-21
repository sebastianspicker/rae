import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { badInput } from "./errors.mjs";
import { assertReviewTransition, defaultReviewLoop, reviewLoopPath } from "./commands-review.mjs";
import { printUsage as printUsageImpl } from "./commands-usage.mjs";
import {
  getRunDir,
  loadPipelineState,
  readJson,
  resolveWithinRepo,
  resolveWorkspaceRootForRun,
  toWorkspaceRelative,
  withLockedState,
  writeJson,
} from "./state.mjs";
import { appendTraceEvent, ensureTraceFile, summarizeRun } from "./trace.mjs";
import { assertGateStatus, emitGate, emitRetryEventIfNeeded, readPhaseGate } from "./gates.mjs";

const PHASES = PHASE_ORDER;
const PHASE_END_STATUS_SET = new Set(["ok", "error"]);
const ARTIFACT_ACTION_SET = new Set(["read", "write"]);
const SUMMARY_FORMATS = new Set(["json", "text", "markdown"]);
const REVIEW_STATES = new Set(["explain", "fix", "ship"]);
const REVIEW_STATUS_SET = new Set([
  "not-started",
  "in-progress",
  "pending-approval",
  "approved",
  "rejected",
  "completed",
]);
export function runStartPhase(
  options,
  { requireOption, assertKnownPhase, ensureStateForRun, appendRunStartIfMissing },
) {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);

  withLockedState(root, (state) => {
    ensureStateForRun(state, runId);
    appendRunStartIfMissing(runId, state, root);
    emitRetryEventIfNeeded(runId, phase, root);

    appendTraceEvent(
      runId,
      {
        event: "phase_start",
        phase,
        status: "ok",
      },
      root,
    );

    state.current_phase = phase;
  });

  process.stdout.write(
    `${JSON.stringify({ success: true, run_id: runId, phase, event: "phase_start" }, null, 2)}\n`,
  );
}

export function runEndPhase(options, { requireOption, assertKnownPhase }) {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const status = options.status || "ok";
  if (!PHASE_END_STATUS_SET.has(status)) {
    throw badInput("--status must be one of: ok, error");
  }

  appendTraceEvent(
    runId,
    {
      event: "phase_end",
      phase,
      status,
    },
    root,
  );

  // Note: endPhase intentionally does NOT save pipeline state.
  // Unlike startPhase (which sets current_phase), endPhase has no state
  // to update — the trace event is the authoritative record of phase
  // completion. The next startPhase call will advance current_phase.

  process.stdout.write(
    `${JSON.stringify({ success: true, run_id: runId, phase, event: "phase_end", status }, null, 2)}\n`,
  );
}

export function runRecordArtifact(options, { requireOption, assertKnownPhase }) {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const artifactRef = requireOption(options, "artifact-ref");
  resolveWithinRepo(artifactRef, root);
  const requestedAction = options.action || "write";
  if (!ARTIFACT_ACTION_SET.has(requestedAction)) {
    throw badInput("--action must be one of: read, write");
  }
  const action = requestedAction === "read" ? "artifact_read" : "artifact_write";

  appendTraceEvent(
    runId,
    {
      event: action,
      phase,
      artifact_ref: artifactRef,
      status: "ok",
    },
    root,
  );

  process.stdout.write(
    `${JSON.stringify({ success: true, run_id: runId, phase, event: action, artifact_ref: artifactRef }, null, 2)}\n`,
  );
}

export function runRecordGate(options, { requireOption, assertKnownPhase }) {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const status = requireOption(options, "status");
  assertGateStatus(status, "--status");
  const gateId = options["gate-id"] || `${phase}-gate`;
  const artifactRef = options["artifact-ref"] || "n/a";

  const gate = emitGate({
    runId,
    phase,
    gateId,
    status,
    artifactRef,
    criteria: [],
    blockingFailures: status === "fail" ? [gateId] : [],
    metadata: {
      source: "record-gate",
    },
    gateFileOverride: options["gate-file"],
    root,
  });

  process.stdout.write(`${JSON.stringify({ success: true, run_id: runId, gate }, null, 2)}\n`);
}

export function runRecordReviewState(options, { requireOption }) {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const state = requireOption(options, "state");
  const status = requireOption(options, "status");
  if (!REVIEW_STATES.has(state)) {
    throw badInput("--state must be one of: explain, fix, ship");
  }
  if (!REVIEW_STATUS_SET.has(status)) {
    throw badInput(
      "--status must be one of: not-started, in-progress, pending-approval, approved, rejected, completed",
    );
  }

  let reviewLoop;
  const path = reviewLoopPath(runId, root);
  const phase = "release-readiness";
  withLockedState(root, (pipelineState) => {
    reviewLoop = readJson(path, defaultReviewLoop(runId));
    assertReviewTransition(reviewLoop, state, status);

    reviewLoop.current_state = state;
    reviewLoop.states[state].status = status;
    if (typeof options.note === "string" && options.note.length > 0) {
      reviewLoop.states[state].note = options.note;
    }
    reviewLoop.transition_log.push({
      state,
      status,
      changed_at: new Date().toISOString(),
      ...(typeof options.note === "string" && options.note.length > 0 ? { note: options.note } : {}),
    });
    reviewLoop.updated_at = new Date().toISOString();
    writeJson(path, reviewLoop);

    appendTraceEvent(
      runId,
      {
        event: "review_state_change",
        phase,
        status: "ok",
        artifact_ref: "review-loop.json",
        metadata: {
          review_state: state,
          review_status: status,
          code_mutation_allowed: reviewLoop.states[state].code_mutation_allowed,
          approval_required: reviewLoop.states[state].approval_required,
        },
      },
      root,
    );

    pipelineState.artifacts ??= {};
    pipelineState.artifacts.review_loop = "review-loop.json";
  });

  process.stdout.write(`${JSON.stringify({ success: true, run_id: runId, review_loop: reviewLoop }, null, 2)}\n`);
}

export function runSummarizeRun(
  options,
  { requireOption, ensureStateForRun },
) {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const format = options.format || "json";
  if (!SUMMARY_FORMATS.has(format)) {
    throw badInput("--format must be one of: json, text, markdown");
  }
  const outputRef = options.output;
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  ensureTraceFile(runId, root);
  const summary = summarizeRun(runId, root);

  const jsonPayload = { success: true, run_id: runId, summary };

  const gatePass = summary.gate_results?.pass ?? 0;
  const gateFail = summary.gate_results?.fail ?? 0;
  const gateWarn = summary.gate_results?.warn ?? 0;
  const issues = Array.isArray(summary.issues) ? summary.issues : [];
  const phaseDurations = summary.phase_durations_ms ?? {};
  const activePhases = PHASES.filter((p) => phaseDurations[p] !== undefined);

  const renderText = () => {
    const phaseLines = activePhases.map((p) => `  - ${p}: ${phaseDurations[p]} ms`);

    return [
      `Run summary: ${runId}`,
      `valid: ${summary.valid ? "true" : "false"}`,
      `events: ${summary.total_events ?? 0}`,
      `gates: pass=${gatePass} warn=${gateWarn} fail=${gateFail}`,
      `duration_s: ${summary.summed_phase_duration_s ?? summary.total_duration_s ?? 0}`,
      ...(summary.total_wall_clock_s !== undefined
        ? [`wall_clock_s: ${summary.total_wall_clock_s}`]
        : []),
      `cost_usd: ${summary.total_cost_usd ?? 0}`,
      `tokens: in=${summary.total_tokens_in ?? 0} out=${summary.total_tokens_out ?? 0}`,
      issues.length > 0 ? `issues (${issues.length}):` : "issues: none",
      ...(issues.length > 0 ? issues.map((issue) => `  - ${issue}`) : []),
      phaseLines.length > 0 ? "phase_durations_ms:" : "phase_durations_ms: none",
      ...phaseLines,
      "",
    ].join("\n");
  };

  const renderMarkdown = () => {
    const phaseRows = activePhases.map((p) => `| ${p} | ${phaseDurations[p]} |`);

    return [
      `# Run Summary: ${runId}`,
      "",
      `- Valid: \`${summary.valid ? "true" : "false"}\``,
      `- Total events: \`${summary.total_events ?? 0}\``,
      `- Gates: pass=\`${gatePass}\`, warn=\`${gateWarn}\`, fail=\`${gateFail}\``,
      `- Duration (s): \`${summary.summed_phase_duration_s ?? summary.total_duration_s ?? 0}\``,
      ...(summary.total_wall_clock_s !== undefined
        ? [`- Wall clock (s): \`${summary.total_wall_clock_s}\``]
        : []),
      `- Cost (USD): \`${summary.total_cost_usd ?? 0}\``,
      `- Tokens: in=\`${summary.total_tokens_in ?? 0}\`, out=\`${summary.total_tokens_out ?? 0}\``,
      "",
      "## Phase Durations",
      "",
      "| Phase | Duration (ms) |",
      "| --- | ---: |",
      ...(phaseRows.length > 0 ? phaseRows : ["| (none) | 0 |"]),
      "",
      "## Issues",
      "",
      ...(issues.length > 0 ? issues.map((issue) => `- ${issue}`) : ["- None"]),
      "",
    ].join("\n");
  };

  let rendered = "";
  if (format === "text") {
    rendered = renderText();
  } else if (format === "markdown") {
    rendered = renderMarkdown();
  }

  let outputPath;
  if (outputRef) {
    const outputAbs = resolveWithinRepo(outputRef, root);
    mkdirSync(dirname(outputAbs), { recursive: true });
    if (format === "json") {
      writeFileSync(outputAbs, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
    } else {
      writeFileSync(outputAbs, rendered, "utf8");
    }
    outputPath = toWorkspaceRelative(outputAbs, root);
  }

  if (format === "json") {
    const payload = outputPath ? { ...jsonPayload, format, output_ref: outputPath } : jsonPayload;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (outputPath) {
    process.stdout.write(
      `${JSON.stringify({ success: true, run_id: runId, format, output_ref: outputPath }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write(rendered);
}

export function runSummarizeProgress(
  options,
  { requireOption, ensureStateForRun },
) {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const format = options.format || "json";
  if (!SUMMARY_FORMATS.has(format)) {
    throw badInput("--format must be one of: json, text, markdown");
  }
  const outputRef = options.output;
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  ensureTraceFile(runId, root);

  const summary = summarizeRun(runId, root);
  const phaseOrder = Array.isArray(state.phase_order) ? state.phase_order : PHASES;
  const completedGates = new Set(Array.isArray(state.completed_gates) ? state.completed_gates : []);
  const phaseStatus = phaseOrder.map((phase) => {
    const gate = readPhaseGate(runId, phase);
    const gateStatus = gate?.status ?? "pending";
    const status =
      gateStatus === "fail"
        ? "blocked"
        : completedGates.has(`${phase}-gate`) || gateStatus !== "pending"
            ? "completed"
            : state.current_phase === phase
              ? "active"
            : "pending";
    return {
      phase,
      status,
      gate_status: gateStatus,
    };
  });

  const gateTotals = phaseStatus.reduce(
    (acc, entry) => {
      acc[entry.gate_status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, pending: 0 },
  );
  const blockers = phaseStatus
    .filter((entry) => entry.status === "blocked")
    .map((entry) => `${entry.phase}:${entry.gate_status}`);
  const nextPending = phaseStatus.find((entry) => entry.status === "pending");
  const nextAction =
    blockers.length > 0
      ? `Resolve blockers in ${blockers.join(", ")}`
      : nextPending
        ? `Start phase ${nextPending.phase}`
        : `Continue or inspect phase ${state.current_phase}`;

  const artifact = {
    run_id: runId,
    current_phase: state.current_phase,
    workspace_mode: state.workspace?.mode ?? "main-repo",
    phase_status: phaseStatus,
    gate_totals: gateTotals,
    blockers,
    activity_summary: summary.activity_resolutions ?? [],
    cost_summary: {
      total_cost_usd: summary.total_cost_usd ?? 0,
      total_tokens_in: summary.total_tokens_in ?? 0,
      total_tokens_out: summary.total_tokens_out ?? 0,
    },
    next_action: nextAction,
    updated_at: new Date().toISOString(),
  };

  const path = `${getRunDir(runId, root)}/progress.summary.json`;
  writeJson(path, artifact);

  withLockedState(root, (lockedState) => {
    ensureStateForRun(lockedState, runId);
    lockedState.artifacts ??= {};
    lockedState.artifacts.progress_summary = "progress.summary.json";
  });

  appendTraceEvent(
    runId,
    {
      event: "artifact_write",
      phase: state.current_phase,
      status: "ok",
      artifact_ref: "progress.summary.json",
      metadata: {
        artifact_kind: "progress_summary",
      },
    },
    root,
  );

  const renderText = () =>
    [
      `Progress summary: ${runId}`,
      `current_phase: ${artifact.current_phase}`,
      `workspace_mode: ${artifact.workspace_mode}`,
      `gates: pass=${gateTotals.pass} warn=${gateTotals.warn} fail=${gateTotals.fail} pending=${gateTotals.pending}`,
      `next_action: ${artifact.next_action}`,
      blockers.length > 0 ? `blockers (${blockers.length}):` : "blockers: none",
      ...(blockers.length > 0 ? blockers.map((blocker) => `  - ${blocker}`) : []),
      "phase_status:",
      ...artifact.phase_status.map(
        (entry) => `  - ${entry.phase}: ${entry.status} (gate=${entry.gate_status})`,
      ),
      "",
    ].join("\n");

  const renderMarkdown = () =>
    [
      `# Progress Summary: ${runId}`,
      "",
      `- Current phase: \`${artifact.current_phase}\``,
      `- Workspace mode: \`${artifact.workspace_mode}\``,
      `- Gates: pass=\`${gateTotals.pass}\`, warn=\`${gateTotals.warn}\`, fail=\`${gateTotals.fail}\`, pending=\`${gateTotals.pending}\``,
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
      ...(blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : ["- None"]),
      "",
    ].join("\n");

  const jsonPayload = {
    success: true,
    run_id: runId,
    progress_ref: "progress.summary.json",
    summary: artifact,
  };

  if (outputRef) {
    const outputAbs = resolveWithinRepo(outputRef, root);
    mkdirSync(dirname(outputAbs), { recursive: true });
    if (format === "json") {
      writeFileSync(outputAbs, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
    } else if (format === "text") {
      writeFileSync(outputAbs, renderText(), "utf8");
    } else {
      writeFileSync(outputAbs, renderMarkdown(), "utf8");
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          success: true,
          run_id: runId,
          progress_ref: "progress.summary.json",
          format,
          output_ref: toWorkspaceRelative(outputAbs, root),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(jsonPayload, null, 2)}\n`);
    return;
  }

  process.stdout.write(format === "text" ? renderText() : renderMarkdown());
}

export function printUsage() {
  printUsageImpl(PHASES);
}
