import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { badInput } from "./errors.mjs";
import { renderRunSummary, runSummaryView } from "./commands-summary-run.mjs";
import {
  buildProgressArtifact,
  progressPhases,
  progressView,
  renderProgressSummary,
} from "./commands-summary-progress.mjs";
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
      ...(typeof options.note === "string" && options.note.length > 0
        ? { note: options.note }
        : {}),
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

  process.stdout.write(
    `${JSON.stringify({ success: true, run_id: runId, review_loop: reviewLoop }, null, 2)}\n`,
  );
}

export function runSummarizeRun(options, { requireOption, ensureStateForRun }) {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const format = options.format || "json";
  validateSummaryFormat(format);
  const outputRef = options.output;
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  ensureTraceFile(runId, root);
  const summary = summarizeRun(runId, root);

  const jsonPayload = { success: true, run_id: runId, summary };
  const rendered =
    format === "json" ? "" : renderRunSummary(runSummaryView(runId, summary, PHASES), format);
  const outputPath = writeRunSummaryOutput(outputRef, root, format, jsonPayload, rendered);
  emitRunSummary({ format, outputPath, jsonPayload, runId, rendered });
}

function validateSummaryFormat(format) {
  if (!SUMMARY_FORMATS.has(format)) {
    throw badInput("--format must be one of: json, text, markdown");
  }
}

function writeRunSummaryOutput(outputRef, root, format, jsonPayload, rendered) {
  if (!outputRef) return null;
  const outputAbs = resolveWithinRepo(outputRef, root);
  mkdirSync(dirname(outputAbs), { recursive: true });
  const content = format === "json" ? `${JSON.stringify(jsonPayload, null, 2)}\n` : rendered;
  writeFileSync(outputAbs, content, "utf8");
  return toWorkspaceRelative(outputAbs, root);
}

function emitRunSummary({ format, outputPath, jsonPayload, runId, rendered }) {
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

export function runSummarizeProgress(options, { requireOption, ensureStateForRun }) {
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
  const progress = progressView(state, summary, progressPhases(state, PHASES), (phase) =>
    readPhaseGate(runId, phase),
  );
  const artifact = buildProgressArtifact(runId, state, summary, progress, new Date().toISOString());

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

  const rendered = renderProgressSummary(runId, artifact, format);
  emitProgressSummary({ runId, root, format, outputRef, artifact, rendered });
}

function emitProgressSummary({ runId, root, format, outputRef, artifact, rendered }) {
  const jsonPayload = {
    success: true,
    run_id: runId,
    progress_ref: "progress.summary.json",
    summary: artifact,
  };
  if (!outputRef) {
    process.stdout.write(
      format === "json" ? `${JSON.stringify(jsonPayload, null, 2)}\n` : rendered,
    );
    return;
  }
  const outputAbs = resolveWithinRepo(outputRef, root);
  mkdirSync(dirname(outputAbs), { recursive: true });
  const content = format === "json" ? `${JSON.stringify(jsonPayload, null, 2)}\n` : rendered;
  writeFileSync(outputAbs, content, "utf8");
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
}

export function printUsage() {
  printUsageImpl(PHASES);
}
