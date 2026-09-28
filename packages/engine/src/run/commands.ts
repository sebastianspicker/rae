/**
 * Implements runner subcommands and their stateful artifact, gate, and review transitions.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PHASE_ORDER } from "./constants.js";
import { badInput } from "../primitives/errors.js";
import {
  assertReviewTransition,
  defaultReviewLoop,
  reviewLoopPath,
  type ReviewLoop,
  type ReviewState,
  type ReviewStatus,
} from "./commands-review.js";
import {
  buildProgressArtifact,
  progressPhases,
  progressView,
  renderProgressSummary,
  type ProgressArtifact,
} from "./commands-summary-progress.js";
import { printUsage as printUsageImpl } from "./commands-usage.js";
import {
  getRunDir,
  loadPipelineState,
  readJson,
  resolveWithinRepo,
  resolveWorkspaceRootForRun,
  toWorkspaceRelative,
  withLockedState,
  writeJson,
  type PipelineState,
} from "./state.js";
import { appendTraceEvent, ensureTraceFile, summarizeRun } from "./trace.js";
import { assertGateStatus, emitGate, emitRetryEventIfNeeded, readPhaseGate } from "./gates.js";

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

export interface CommandOptions extends Record<string, string | boolean | string[] | undefined> {}
type RequireOption = (options: CommandOptions, key: string) => string;
type AssertKnownPhase = (phase: string, source?: string) => void;
type EnsureStateForRun = (state: PipelineState, runId: string) => void;
interface BasicCommandDependencies {
  requireOption: RequireOption;
  assertKnownPhase: AssertKnownPhase;
}
interface StartCommandDependencies extends BasicCommandDependencies {
  ensureStateForRun: EnsureStateForRun;
  appendRunStartIfMissing: (runId: string, state: PipelineState, root: string) => void;
}
interface SummaryDependencies {
  requireOption: RequireOption;
  ensureStateForRun: EnsureStateForRun;
}
interface RunSummary extends Record<string, unknown> {
  valid?: unknown;
  issues?: unknown;
  gate_results?: unknown;
  phase_durations_ms?: unknown;
  summed_phase_duration_s?: unknown;
  total_duration_s?: unknown;
  total_wall_clock_s?: unknown;
  total_events?: unknown;
  total_cost_usd?: unknown;
  total_tokens_in?: unknown;
  total_tokens_out?: unknown;
}
interface RunSummaryView {
  runId: string;
  summary: RunSummary;
  gatePass: unknown;
  gateFail: unknown;
  gateWarn: unknown;
  issues: unknown[];
  phaseDurations: Record<string, unknown>;
  activePhases: string[];
}
interface SummaryEmission {
  format: string;
  outputRef?: string;
  root: string;
  runId: string;
  jsonPayload: Record<string, unknown>;
  rendered: string;
}
function optionString(options: CommandOptions, key: string, fallback: string): string {
  return typeof options[key] === "string" ? options[key] : fallback;
}
export function runStartPhase(
  options: CommandOptions,
  {
    requireOption,
    assertKnownPhase,
    ensureStateForRun,
    appendRunStartIfMissing,
  }: StartCommandDependencies,
): void {
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

export function runEndPhase(
  options: CommandOptions,
  { requireOption, assertKnownPhase }: BasicCommandDependencies,
): void {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const status = optionString(options, "status", "ok");
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
  // to update: the trace event is the authoritative record of phase
  // completion. The next startPhase call will advance current_phase.

  process.stdout.write(
    `${JSON.stringify({ success: true, run_id: runId, phase, event: "phase_end", status }, null, 2)}\n`,
  );
}

export function runRecordArtifact(
  options: CommandOptions,
  { requireOption, assertKnownPhase }: BasicCommandDependencies,
): void {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const artifactRef = requireOption(options, "artifact-ref");
  resolveWithinRepo(artifactRef, root);
  const requestedAction = optionString(options, "action", "write");
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

export function runRecordGate(
  options: CommandOptions,
  { requireOption, assertKnownPhase }: BasicCommandDependencies,
): void {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  assertKnownPhase(phase, "--phase");
  const root = resolveWorkspaceRootForRun(runId);
  const status = requireOption(options, "status");
  assertGateStatus(status, "--status");
  const gateId = optionString(options, "gate-id", `${phase}-gate`);
  const artifactRef = optionString(options, "artifact-ref", "n/a");

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
    ...(typeof options["gate-file"] === "string" ? { gateFileOverride: options["gate-file"] } : {}),
    root,
  });

  process.stdout.write(`${JSON.stringify({ success: true, run_id: runId, gate }, null, 2)}\n`);
}

export function runRecordReviewState(
  options: CommandOptions,
  { requireOption }: Pick<BasicCommandDependencies, "requireOption">,
): void {
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

  let reviewLoop: ReviewLoop | undefined;
  const path = reviewLoopPath(runId, root);
  const phase = "release-readiness";
  withLockedState(root, (pipelineState) => {
    reviewLoop = readJson(path, defaultReviewLoop(runId)) as ReviewLoop;
    const reviewState = state as ReviewState;
    const reviewStatus = status as ReviewStatus;
    assertReviewTransition(reviewLoop, reviewState, reviewStatus);

    reviewLoop.current_state = reviewState;
    reviewLoop.states[reviewState].status = reviewStatus;
    if (typeof options.note === "string" && options.note.length > 0) {
      reviewLoop.states[reviewState].note = options.note;
    }
    reviewLoop.transition_log.push({
      state: reviewState,
      status: reviewStatus,
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
          code_mutation_allowed: reviewLoop.states[reviewState].code_mutation_allowed,
          approval_required: reviewLoop.states[reviewState].approval_required,
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

function valueOr<T>(value: T | null | undefined, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

function optionalLines(condition: boolean, lines: string[]): string[] {
  return condition ? lines : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function runSummaryView(runId: string, summary: RunSummary): RunSummaryView {
  const gateResults = recordValue(summary.gate_results);
  const issues = Array.isArray(summary.issues) ? summary.issues : [];
  const phaseDurations = recordValue(summary.phase_durations_ms);
  return {
    runId,
    summary,
    gatePass: valueOr(gateResults.pass, 0),
    gateFail: valueOr(gateResults.fail, 0),
    gateWarn: valueOr(gateResults.warn, 0),
    issues,
    phaseDurations,
    activePhases: PHASES.filter((phase) => phaseDurations[phase] !== undefined),
  };
}

function runDurationSeconds(summary: RunSummary): unknown {
  return valueOr(summary.summed_phase_duration_s, valueOr(summary.total_duration_s, 0));
}

function renderRunSummaryText(view: RunSummaryView): string {
  const { runId, summary, gatePass, gateWarn, gateFail, issues, phaseDurations, activePhases } =
    view;
  const phaseLines = activePhases.map((phase) => `  - ${phase}: ${phaseDurations[phase]} ms`);
  return [
    `Run summary: ${runId}`,
    `valid: ${summary.valid ? "true" : "false"}`,
    `events: ${valueOr(summary.total_events, 0)}`,
    `gates: pass=${gatePass} warn=${gateWarn} fail=${gateFail}`,
    `duration_s: ${runDurationSeconds(summary)}`,
    ...optionalLines(summary.total_wall_clock_s !== undefined, [
      `wall_clock_s: ${summary.total_wall_clock_s}`,
    ]),
    `cost_usd: ${valueOr(summary.total_cost_usd, 0)}`,
    `tokens: in=${valueOr(summary.total_tokens_in, 0)} out=${valueOr(summary.total_tokens_out, 0)}`,
    issues.length > 0 ? `issues (${issues.length}):` : "issues: none",
    ...optionalLines(
      issues.length > 0,
      issues.map((issue) => `  - ${String(issue)}`),
    ),
    phaseLines.length > 0 ? "phase_durations_ms:" : "phase_durations_ms: none",
    ...phaseLines,
    "",
  ].join("\n");
}

function renderRunSummaryMarkdown(view: RunSummaryView): string {
  const { runId, summary, gatePass, gateWarn, gateFail, issues, phaseDurations, activePhases } =
    view;
  const phaseRows = activePhases.map((phase) => `| ${phase} | ${phaseDurations[phase]} |`);
  return [
    `# Run Summary: ${runId}`,
    "",
    `- Valid: \`${summary.valid ? "true" : "false"}\``,
    `- Total events: \`${valueOr(summary.total_events, 0)}\``,
    `- Gates: pass=\`${gatePass}\`, warn=\`${gateWarn}\`, fail=\`${gateFail}\``,
    `- Duration (s): \`${runDurationSeconds(summary)}\``,
    ...optionalLines(summary.total_wall_clock_s !== undefined, [
      `- Wall clock (s): \`${summary.total_wall_clock_s}\``,
    ]),
    `- Cost (USD): \`${valueOr(summary.total_cost_usd, 0)}\``,
    `- Tokens: in=\`${valueOr(summary.total_tokens_in, 0)}\`, out=\`${valueOr(summary.total_tokens_out, 0)}\``,
    "",
    "## Phase Durations",
    "",
    "| Phase | Duration (ms) |",
    "| --- | ---: |",
    ...(phaseRows.length > 0 ? phaseRows : ["| (none) | 0 |"]),
    "",
    "## Issues",
    "",
    ...(issues.length > 0 ? issues.map((issue) => `- ${String(issue)}`) : ["- None"]),
    "",
  ].join("\n");
}

function emitRunSummary({
  format,
  outputRef,
  root,
  runId,
  jsonPayload,
  rendered,
}: SummaryEmission): void {
  let outputPath: string | undefined;
  if (outputRef) {
    const outputAbs = resolveWithinRepo(outputRef, root);
    mkdirSync(dirname(outputAbs), { recursive: true });
    const output = format === "json" ? `${JSON.stringify(jsonPayload, null, 2)}\n` : rendered;
    writeFileSync(outputAbs, output, "utf8");
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

export function runSummarizeRun(
  options: CommandOptions,
  { requireOption, ensureStateForRun }: SummaryDependencies,
): void {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const format = optionString(options, "format", "json");
  if (!SUMMARY_FORMATS.has(format)) {
    throw badInput("--format must be one of: json, text, markdown");
  }
  const outputRef = typeof options.output === "string" ? options.output : undefined;
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  ensureTraceFile(runId, root);
  const summary = summarizeRun(runId, root) as RunSummary;
  const jsonPayload = { success: true, run_id: runId, summary };
  const view = runSummaryView(runId, summary);
  const rendered = format === "text" ? renderRunSummaryText(view) : renderRunSummaryMarkdown(view);
  emitRunSummary({ format, outputRef, root, runId, jsonPayload, rendered });
}

function persistProgressSummary({
  runId,
  root,
  state,
  artifact,
  ensureStateForRun,
}: {
  runId: string;
  root: string;
  state: PipelineState;
  artifact: ProgressArtifact;
  ensureStateForRun: EnsureStateForRun;
}): void {
  writeJson(`${getRunDir(runId, root)}/progress.summary.json`, artifact);
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
      metadata: { artifact_kind: "progress_summary" },
    },
    root,
  );
}

function emitProgressSummary({
  format,
  outputRef,
  root,
  runId,
  jsonPayload,
  rendered,
}: SummaryEmission): void {
  if (outputRef) {
    const outputAbs = resolveWithinRepo(outputRef, root);
    mkdirSync(dirname(outputAbs), { recursive: true });
    const output = format === "json" ? `${JSON.stringify(jsonPayload, null, 2)}\n` : rendered;
    writeFileSync(outputAbs, output, "utf8");
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
  process.stdout.write(rendered);
}

export function runSummarizeProgress(
  options: CommandOptions,
  { requireOption, ensureStateForRun }: SummaryDependencies,
): void {
  const runId = requireOption(options, "run-id");
  const root = resolveWorkspaceRootForRun(runId);
  const format = optionString(options, "format", "json");
  if (!SUMMARY_FORMATS.has(format)) {
    throw badInput("--format must be one of: json, text, markdown");
  }
  const outputRef = typeof options.output === "string" ? options.output : undefined;
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  ensureTraceFile(runId, root);

  const summary = summarizeRun(runId, root) as RunSummary;
  const progress = progressView(state, summary, progressPhases(state, PHASES), (phase) =>
    readPhaseGate(runId, phase),
  );
  const artifact = buildProgressArtifact(runId, state, summary, progress, new Date().toISOString());
  persistProgressSummary({ runId, root, state, artifact, ensureStateForRun });
  const jsonPayload = {
    success: true,
    run_id: runId,
    progress_ref: "progress.summary.json",
    summary: artifact,
  };
  emitProgressSummary({
    format,
    outputRef,
    root,
    runId,
    jsonPayload,
    rendered: renderProgressSummary(runId, artifact, format),
  });
}

export function printUsage(): void {
  printUsageImpl(PHASES);
}
