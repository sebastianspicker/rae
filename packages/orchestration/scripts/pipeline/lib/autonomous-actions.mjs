/** Handles autonomous workflow execution and operator control commands. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import {
  acquireWorkflowLock,
  initializeOrResume,
  mergeResumeOptions,
} from "./autonomous-lifecycle.mjs";
import {
  assertGitRepository,
  assertGitStateInvariant,
  refreshResumeRefBaseline,
  requireDirectory,
} from "./autonomous-git.mjs";
import { completeReviewLoop, invokeRunner, runOnePhase } from "./autonomous-execution.mjs";
import { printFinal, writeRunReport } from "./autonomous-report.mjs";
import { appendTraceEvent, projectOperatorEvents } from "./trace.mjs";
import { getRunDir, readJsonStrict, writeJson } from "./state.mjs";
import {
  checkpointPolicy,
  createCheckpoint,
  listCheckpoints,
  readOperatorControl,
  requestStop,
  resolveCheckpointById,
  setRunStatus,
} from "./operator-control.mjs";
import { ensureRuntimeStateReadable } from "./runtime-state-guard.mjs";
import { projectGraph, recordRunMemory } from "./graph.mjs";
import { runGraphWorkflow } from "./workflow-runtime.mjs";

const DEFAULT_TIMEOUT_SECONDS = 1800;

function checkpointPause(context, phase, purpose) {
  const checkpoint = createCheckpoint(
    context.runId,
    {
      phase,
      purpose,
      message:
        purpose === "mutation"
          ? "Human approval is required before the build phase may modify the workspace."
          : "Human review is required before recording autonomous run completion.",
    },
    context.workspaceRoot,
  );
  if (readOperatorControl(context.runId, context.workspaceRoot).stop_requested) {
    return "stopped";
  }
  if (checkpoint.status === "approved") return "continue";
  if (checkpoint.status !== "pending") {
    throw new Error(`checkpoint ${checkpoint.checkpoint_id} was ${checkpoint.status}`);
  }
  const waitingControl = setRunStatus(context.runId, "waiting", context.workspaceRoot, {
    waiting_checkpoint_id: checkpoint.checkpoint_id,
    stop_requested: false,
  });
  if (waitingControl.stop_requested) return "stopped";
  appendTraceEvent(
    context.runId,
    { event: "checkpoint_requested", phase, status: "waiting", metadata: { purpose } },
    context.workspaceRoot,
  );
  appendTraceEvent(
    context.runId,
    { event: "run_waiting", phase, status: "waiting" },
    context.workspaceRoot,
  );
  return "waiting";
}

function publishStoppedRun(context, provider, phase, runOptions) {
  setRunStatus(context.runId, "stopped", context.workspaceRoot, { stop_requested: true });
  appendTraceEvent(
    context.runId,
    { event: "run_stopped", phase, status: "stopped" },
    context.workspaceRoot,
  );
  const report = writeRunReport(context, { provider, status: "stopped" });
  printFinal(context, report, runOptions);
}

function validateOptions(options) {
  validateCheckpointOption(options);
  validateThroughOption(options);
  validateProviderOptions(options);
  validateExecutionProfileOptions(options);
  validateGraphMemoryOption(options);
  validateBoundedOption(options, "max-concurrency", 4, 4);
  validateBoundedOption(options, "max-repair-rounds", 5, 5);
}

function validateExecutionProfileOptions(options) {
  if (options["execution-profile"] && (options.model || options["reasoning-effort"])) {
    throw new Error(
      "--execution-profile is mutually exclusive with --model and --reasoning-effort",
    );
  }
}

function validateGraphMemoryOption(options) {
  if (!["off", "read", "read-write"].includes(options["graph-memory"] ?? "off")) {
    throw new Error("--graph-memory must be off, read, or read-write");
  }
}

function validateBoundedOption(options, name, fallback, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`--${name} must be an integer between 1 and ${maximum}`);
  }
}

function validateCheckpointOption(options) {
  checkpointPolicy(options["checkpoint-policy"]);
  const timeout = Number(options["timeout-seconds"] ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 86_400) {
    throw new Error("--timeout-seconds must be an integer between 1 and 86400");
  }
  if (
    options["reasoning-effort"] &&
    !["low", "medium", "high", "xhigh"].includes(options["reasoning-effort"])
  ) {
    throw new Error("--reasoning-effort must be low, medium, high, or xhigh");
  }
}

function validateThroughOption(options) {
  const through = options.through ?? "release-readiness";
  if (
    options["legacy-linear"] !== true &&
    (options.provider !== "command" || Boolean(options.workflow))
  ) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(through))
      throw new Error("--through must be a valid workflow node id");
    return;
  }
  if (!PHASE_ORDER.includes(through)) {
    throw new Error(`--through must be one of: ${PHASE_ORDER.join(", ")}`);
  }
}

function validateProviderOptions(options) {
  const provider = options.provider ?? "auto";
  if (!["auto", "codex", "command"].includes(provider)) {
    throw new Error("--provider must be auto, codex, or command");
  }
  if (provider === "command") return validateCommandProvider(options);
  if (
    options["allow-unsafe-command-provider"] ||
    options["agent-command"] ||
    options.agentArgs?.length
  ) {
    throw new Error("command-provider options require --provider command");
  }
}

function validateCommandProvider(options) {
  if (options["allow-unsafe-command-provider"] !== true) {
    throw new Error(
      "--provider command is an unsandboxed test-integration surface and requires --allow-unsafe-command-provider",
    );
  }
  if (!options["agent-command"])
    throw new Error("--provider command requires --agent-command <executable>");
}

function validateFreshCommandResume(options) {
  if (options.provider !== "command") return;
  if (
    options["allow-unsafe-command-provider"] !== true ||
    !options["agent-command"] ||
    !options.agentArgs?.length
  ) {
    throw new Error(
      "command-provider resume requires --allow-unsafe-command-provider and fresh --provider command, --agent-command, and at least one --agent-arg",
    );
  }
}

/**
 * Preserve Git-state enforcement even when a phase gate rejects its artifact.
 * A provider must not be able to make a forbidden Git mutation and hide it
 * behind a lower-priority gate failure.
 */
function runPhaseWithGitInvariant(context, phase, options) {
  let result;
  try {
    result = runOnePhase(context, phase, options);
  } catch (error) {
    assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
    throw error;
  }
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
  return result;
}

function recordFreshCommandResume(context, command, options) {
  if (command !== "resume" || options.provider !== "command") return;
  const requestPath = resolve(getRunDir(context.runId, context.workspaceRoot), "request.json");
  const request = readJsonStrict(requestPath);
  writeJson(requestPath, {
    ...request,
    agent: {
      ...request.agent,
      provider: "command",
      command: options["agent-command"],
      command_args: options.agentArgs,
      allow_unsafe_command_provider: true,
    },
  });
}

function controlCommandContext(options) {
  if (!options["run-id"]) throw new Error("control command requires --run-id <id>");
  const workspaceRoot = requireDirectory(options["project-root"] ?? process.cwd(), "project root");
  assertGitRepository(workspaceRoot);
  ensureRuntimeStateReadable(workspaceRoot, { expectedRunId: options["run-id"] });
  const state = readJsonStrict(resolve(workspaceRoot, ".pipeline", "pipeline-state.json"));
  if (state.run_id !== options["run-id"]) {
    throw new Error(`run-id mismatch: workspace has ${state.run_id}`);
  }
  return { workspaceRoot, runId: state.run_id, state };
}

function nextRunPhase(state) {
  const completed = new Set(state.completed_gates ?? []);
  return PHASE_ORDER.find((phase) => !completed.has(`${phase}-gate`)) ?? "release-readiness";
}

function emitControlResult(result, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const [key, value] of Object.entries(result)) {
    process.stdout.write(`${key}: ${typeof value === "object" ? JSON.stringify(value) : value}\n`);
  }
}

function emitReadableControlResult(context, result, options) {
  ensureRuntimeStateReadable(context.workspaceRoot, { expectedRunId: context.runId });
  emitControlResult(result, options);
}

export function runControlCommand(command, options) {
  const context = controlCommandContext(options);
  const handler = CONTROL_COMMAND_HANDLERS[command];
  if (!handler) throw new Error(`unsupported control command: ${command}`);
  handler(context, options);
}

function reportControlStatus(context, options) {
  const runDir = getRunDir(context.runId, context.workspaceRoot);
  emitReadableControlResult(context, {
    schema_version: "1.0.0", run_id: context.runId, workspace_root: context.workspaceRoot,
    active_lock: existsSync(resolve(runDir, "autonomous.lock")), completed_gates: context.state.completed_gates ?? [],
    operator_control: readOperatorControl(context.runId, context.workspaceRoot), checkpoints: listCheckpoints(context.runId, context.workspaceRoot),
  }, options);
}

function requestControlStop(context, options) {
  const previous = readOperatorControl(context.runId, context.workspaceRoot);
  const control = requestStop(context.runId, context.workspaceRoot);
  if (!["stop-requested", "stopped"].includes(previous.status)) {
    appendTraceEvent(context.runId, { event: "run_stop_requested", phase: nextRunPhase(context.state), status: "ok" }, context.workspaceRoot);
  }
  emitReadableControlResult(context, { success: true, run_id: context.runId, operator_control: control }, options);
}

function requiredCheckpointDecision(options) {
  const decision = options.decision;
  if (!["approved", "rejected", "escalated"].includes(decision)) throw new Error("--decision must be approved, rejected, or escalated");
  for (const key of ["checkpoint-id", "decision-id", "actor", "rationale"]) if (!options[key]) throw new Error(`resolve-checkpoint requires --${key}`);
  return decision;
}

function resolveControlCheckpoint(context, options) {
  const decision = requiredCheckpointDecision(options);
  const checkpoint = resolveCheckpointById(context.runId, options["checkpoint-id"], { status: decision, decisionId: options["decision-id"], actor: options.actor, rationale: options.rationale }, context.workspaceRoot);
  appendTraceEvent(context.runId, { event: "checkpoint_resolved", phase: checkpoint.phase, status: decision === "approved" ? "ok" : "blocked", metadata: { checkpoint_id: checkpoint.checkpoint_id, outcome: decision } }, context.workspaceRoot);
  if (decision !== "approved") appendTraceEvent(context.runId, { event: "run_blocked", phase: checkpoint.phase, status: "blocked" }, context.workspaceRoot);
  emitReadableControlResult(context, { success: true, run_id: context.runId, checkpoint }, options);
}

function validEventRange(options) {
  const afterSeq = Number(options["after-seq"] ?? 0);
  const limit = Number(options.limit ?? 100);
  assertEventRange(afterSeq, limit);
  return { afterSeq, limit };
}

function assertEventRange(afterSeq, limit) {
  if (!validAfterSequence(afterSeq)) throw new Error("--after-seq must be a non-negative integer");
  if (!validEventLimit(limit)) throw new Error("--limit must be an integer between 1 and 1000");
}

function validAfterSequence(value) { return Number.isInteger(value) && value >= 0; }
function validEventLimit(value) { return Number.isInteger(value) && value >= 1 && value <= 1000; }

function reportControlEvents(context, options) {
  const { afterSeq, limit } = validEventRange(options);
  const all = projectOperatorEvents(context.runId, context.workspaceRoot).filter((event) => event.seq > afterSeq);
  const events = all.slice(0, limit);
  emitReadableControlResult(context, { schema_version: "1.0.0", run_id: context.runId, after_seq: afterSeq, next_after_seq: events.at(-1)?.seq ?? afterSeq, has_more: all.length > events.length, events }, { ...options, json: true });
}

const CONTROL_COMMAND_HANDLERS = {
  status: reportControlStatus,
  stop: requestControlStop,
  "resolve-checkpoint": resolveControlCheckpoint,
  events: reportControlEvents,
};

function waitingReport(context, provider, runOptions) {
  const report = writeRunReport(context, { provider, status: "waiting" });
  printFinal(context, report, runOptions);
}

function reconcileResumeCheckpoint(context, previousControl, provider, runOptions) {
  const checkpoints = listCheckpoints(context.runId, context.workspaceRoot);
  const terminal = checkpoints.find(({ status }) => ["rejected", "escalated"].includes(status));
  if (terminal) {
    if (previousControl.status === "waiting") {
      setRunStatus(context.runId, "blocked", context.workspaceRoot, {
        waiting_checkpoint_id: null,
        stop_requested: false,
      });
    }
    throw new Error(
      `cannot resume after checkpoint ${terminal.checkpoint_id} was ${terminal.status}`,
    );
  }
  const waiting = checkpoints.find(
    ({ checkpoint_id }) => checkpoint_id === previousControl.waiting_checkpoint_id,
  );
  if (previousControl.status !== "waiting") return false;
  if (waiting?.status === "pending") {
    waitingReport(context, provider, runOptions);
    return true;
  }
  if (waiting?.status !== "approved") {
    setRunStatus(context.runId, "blocked", context.workspaceRoot, {
      waiting_checkpoint_id: null,
      stop_requested: false,
    });
    throw new Error("cannot resume an unreconciled checkpoint state");
  }
  setRunStatus(context.runId, "running", context.workspaceRoot, {
    waiting_checkpoint_id: null,
    stop_requested: false,
  });
  return false;
}

function prepareLegacyRun(context, command, runOptions, completed, state, provider) {
  recordFreshCommandResume(context, command, runOptions);
  const previousControl = readOperatorControl(context.runId, context.workspaceRoot);
  const allPhasesCompleted = PHASE_ORDER.every((phase) => completed.has(`${phase}-gate`));
  if (command === "resume" && previousControl.status === "completed" && allPhasesCompleted) {
    throw new Error(`cannot resume terminal run status: ${previousControl.status}`);
  }
  if (
    command === "resume" &&
    reconcileResumeCheckpoint(context, previousControl, provider, runOptions)
  ) {
    return false;
  }
  setRunStatus(context.runId, "running", context.workspaceRoot, { stop_requested: false });
  if (command === "resume") {
    appendTraceEvent(
      context.runId,
      { event: "run_resumed", phase: nextRunPhase(state), status: "ok" },
      context.workspaceRoot,
    );
    refreshResumeRefBaseline(context.workspaceRoot, context.initialGitState);
  } else {
    assertGitStateInvariant(context.workspaceRoot, context.initialGitState, "run preflight");
  }
  return true;
}

function checkpointOutcome(context, provider, phase, kind, runOptions) {
  const result = checkpointPause(context, phase, kind);
  if (result === "stopped") publishStoppedRun(context, provider, phase, runOptions);
  if (result === "waiting") waitingReport(context, provider, runOptions);
  return result;
}

function runLegacyPhases(context, phases, controlPolicy, runOptions, initialProvider) {
  let provider = initialProvider;
  for (const phase of phases) {
    if (readOperatorControl(context.runId, context.workspaceRoot).stop_requested) {
      publishStoppedRun(context, provider, phase, runOptions);
      return null;
    }
    const mutationCheckpoint =
      phase === "build" && ["before-mutation", "before-mutation-and-ship"].includes(controlPolicy);
    if (mutationCheckpoint) {
      const outcome = checkpointOutcome(context, provider, phase, "mutation", runOptions);
      if (["stopped", "waiting"].includes(outcome)) return null;
    }
    if (phase === "release-readiness") completeReviewLoop(context.workspaceRoot, context.runId);
    const result = runPhaseWithGitInvariant(context, phase, runOptions);
    provider = result.agent_provider;
    process.stderr.write(`RAE phase ${phase}: ${result.gate.status}\n`);
  }
  return provider;
}

function writeLegacySummaries(context) {
  invokeRunner(context.workspaceRoot, ["summarize-progress", "--run-id", context.runId]);
  invokeRunner(context.workspaceRoot, [
    "summarize-run",
    "--run-id",
    context.runId,
    "--format",
    "markdown",
    "--output",
    `.pipeline/runs/${context.runId}/trace-summary.md`,
  ]);
}

function persistGraphMemory(context, runOptions) {
  const mode = runOptions["graph-memory"] ?? "off";
  if (mode !== "off") projectGraph({ projectRoot: context.workspaceRoot, runId: context.runId });
  if (mode === "read-write") {
    recordRunMemory({ projectRoot: context.workspaceRoot, runId: context.runId });
  }
}

function finalizeLegacyRun(context, through, controlPolicy, provider, runOptions) {
  if (through === "release-readiness") writeLegacySummaries(context);
  if (through === "release-readiness" && controlPolicy === "before-mutation-and-ship") {
    const outcome = checkpointOutcome(context, provider, "release-readiness", "ship", runOptions);
    if (["stopped", "waiting"].includes(outcome)) return;
  }
  if (readOperatorControl(context.runId, context.workspaceRoot).stop_requested) {
    publishStoppedRun(context, provider, through, runOptions);
    return;
  }
  const completedControl = setRunStatus(context.runId, "completed", context.workspaceRoot, {
    stop_requested: false,
  });
  if (completedControl.stop_requested) {
    publishStoppedRun(context, provider, through, runOptions);
    return;
  }
  appendTraceEvent(
    context.runId,
    { event: "run_completed", phase: through, status: "completed" },
    context.workspaceRoot,
  );
  persistGraphMemory(context, runOptions);
  printFinal(context, writeRunReport(context, { provider }), runOptions);
}

function handleLegacyFailure(context, provider, runOptions, error) {
  if (error.pipelineStateUnsafe === true) {
    const payload = {
      success: false,
      status: "pipeline-state-unreadable",
      run_id: context.runId,
      workspace_root: context.workspaceRoot,
      report: null,
      cleanup_command: null,
      changed_files: [],
      documentation: null,
      error: error.message,
    };
    if (runOptions.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`RAE pipeline state is unreadable: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const failedControl = readOperatorControl(context.runId, context.workspaceRoot);
  if (!["completed", "blocked"].includes(failedControl.status)) {
    setRunStatus(context.runId, "blocked", context.workspaceRoot, { stop_requested: false });
    const currentState = readJsonStrict(
      resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"),
    );
    appendTraceEvent(
      context.runId,
      { event: "run_blocked", phase: nextRunPhase(currentState), status: "blocked" },
      context.workspaceRoot,
    );
  }
  printFinal(
    context,
    writeRunReport(context, { provider, error: error.message }),
    runOptions,
    error,
  );
  process.exitCode = 1;
}

function legacyRunConfiguration(context, runOptions) {
  const through = runOptions.through ?? "release-readiness";
  const controlPolicy = checkpointPolicy(runOptions["checkpoint-policy"]);
  const state = readJsonStrict(resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"));
  const completed = new Set(state.completed_gates ?? []);
  const phases = PHASE_ORDER.slice(0, PHASE_ORDER.indexOf(through) + 1).filter(
    (phase) => !completed.has(`${phase}-gate`),
  );
  return { through, controlPolicy, state, completed, phases };
}

function runLegacyWorkflow(command, context, runOptions) {
  const { through, controlPolicy, state, completed, phases } = legacyRunConfiguration(
    context,
    runOptions,
  );
  const initialProvider = runOptions.provider || "auto";
  const releaseLock = acquireWorkflowLock(context.workspaceRoot, context.runId);
  try {
    if (!prepareLegacyRun(context, command, runOptions, completed, state, initialProvider)) return;
    const provider = runLegacyPhases(context, phases, controlPolicy, runOptions, initialProvider);
    if (provider) finalizeLegacyRun(context, through, controlPolicy, provider, runOptions);
  } catch (error) {
    handleLegacyFailure(context, initialProvider, runOptions, error);
  } finally {
    releaseLock();
  }
}

export async function runWorkflow(command, options) {
  if (command === "run") validateOptions(options);
  if (command === "resume") validateFreshCommandResume(options);
  const context = initializeOrResume(command, options);
  const runOptions = context.savedAgentOptions
    ? mergeResumeOptions(context.savedAgentOptions, options)
    : options;
  validateOptions(runOptions);
  if (context.workflowMode !== "graph-native")
    return runLegacyWorkflow(command, context, runOptions);
  if (runOptions.through && !context.workflow.nodes.some(({ id }) => id === runOptions.through)) {
    throw new Error(`--through names unknown workflow node: ${runOptions.through}`);
  }
  return runGraphWorkflowCommand(command, context, runOptions);
}

function prepareGraphRun(command, context) {
  const previousControl = readOperatorControl(context.runId, context.workspaceRoot);
  if (command === "resume" && previousControl.status === "completed") {
    const error = new Error("cannot resume terminal run status: completed");
    error.preserveControl = true;
    throw error;
  }
  setRunStatus(context.runId, "running", context.workspaceRoot, { stop_requested: false });
  if (command !== "resume") {
    assertGitStateInvariant(context.workspaceRoot, context.initialGitState, "run preflight");
    return;
  }
  refreshResumeRefBaseline(context.workspaceRoot, context.initialGitState);
  appendTraceEvent(
    context.runId,
    { event: "run_resumed", phase: context.workflow.entry_node, status: "ok" },
    context.workspaceRoot,
  );
}

function completeGraphRun(context, result, provider, runOptions) {
  if (result.status === "stopped") {
    publishStoppedRun(context, provider, context.workflow.terminal_node, runOptions);
    return;
  }
  if (result.status === "repair-exhausted") {
    throw new Error(`repair loop stopped: ${result.reason}`);
  }
  if (result.status === "through") {
    setRunStatus(context.runId, "stopped", context.workspaceRoot, { stop_requested: false });
    printFinal(context, writeRunReport(context, { provider, status: "stopped" }), runOptions);
    return;
  }
  setRunStatus(context.runId, "completed", context.workspaceRoot, { stop_requested: false });
  persistGraphMemory(context, runOptions);
  printFinal(context, writeRunReport(context, { provider }), runOptions);
}

function handleGraphFailure(context, provider, runOptions, error) {
  if (error.preserveControl === true) throw error;
  if (error.workflowWaiting === true) {
    waitingReport(context, provider, runOptions);
    return;
  }
  setRunStatus(context.runId, "blocked", context.workspaceRoot, { stop_requested: false });
  appendTraceEvent(
    context.runId,
    {
      event: "run_blocked",
      phase: context.workflow.entry_node,
      status: "blocked",
      message: error.message,
    },
    context.workspaceRoot,
  );
  printFinal(
    context,
    writeRunReport(context, { provider, error: error.message }),
    runOptions,
    error,
  );
  process.exitCode = 1;
}

async function runGraphWorkflowCommand(command, context, runOptions) {
  const releaseLock = acquireWorkflowLock(context.workspaceRoot, context.runId);
  const provider = runOptions.provider || "auto";
  try {
    prepareGraphRun(command, context);
    completeGraphRun(context, await runGraphWorkflow(context, runOptions), provider, runOptions);
  } catch (error) {
    handleGraphFailure(context, provider, runOptions, error);
  } finally {
    releaseLock();
  }
}
