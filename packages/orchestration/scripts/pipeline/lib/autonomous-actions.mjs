/** Handles autonomous workflow execution and operator control commands. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { acquireWorkflowLock, assertResumeCheckpointPolicy, initializeOrResume, mergeResumeOptions } from "./autonomous-lifecycle.mjs";
import { assertGitRepository, assertGitStateInvariant, refreshResumeRefBaseline, requireDirectory } from "./autonomous-git.mjs";
import { completeReviewLoop, invokeRunner, runOnePhase } from "./autonomous-execution.mjs";
import { printFinal, writeRunReport } from "./autonomous-report.mjs";
import { appendTraceEvent, projectOperatorEvents } from "./trace.mjs";
import { getRunDir, readJsonStrict } from "./state.mjs";
import { checkpointPolicy, createCheckpoint, listCheckpoints, readOperatorControl, requestStop, resolveCheckpointById, setRunStatus } from "./operator-control.mjs";
import { ensureRuntimeStateReadable } from "./runtime-state-guard.mjs";

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
    throw new Error("--provider command is an unsandboxed test-integration surface and requires --allow-unsafe-command-provider");
  }
  if (!options["agent-command"]) throw new Error("--provider command requires --agent-command <executable>");
}

function validateFreshCommandResume(options) {
  if (options.provider !== "command") return;
  if (
    options["allow-unsafe-command-provider"] !== true ||
    !options["agent-command"] ||
    !options.agentArgs?.length
  ) {
    throw new Error(
      "command-provider resume requires fresh --provider command, --agent-command, at least one --agent-arg, and --allow-unsafe-command-provider",
    );
  }
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
  if (command === "status") {
    const runDir = getRunDir(context.runId, context.workspaceRoot);
    emitReadableControlResult(
      context,
      {
        schema_version: "1.0.0",
        run_id: context.runId,
        workspace_root: context.workspaceRoot,
        active_lock: existsSync(resolve(runDir, "autonomous.lock")),
        completed_gates: context.state.completed_gates ?? [],
        operator_control: readOperatorControl(context.runId, context.workspaceRoot),
        checkpoints: listCheckpoints(context.runId, context.workspaceRoot),
      },
      options,
    );
    return;
  }
  if (command === "stop") {
    const previous = readOperatorControl(context.runId, context.workspaceRoot);
    const control = requestStop(context.runId, context.workspaceRoot);
    if (!["stop-requested", "stopped"].includes(previous.status)) {
      appendTraceEvent(
        context.runId,
        { event: "run_stop_requested", phase: nextRunPhase(context.state), status: "ok" },
        context.workspaceRoot,
      );
    }
    emitReadableControlResult(
      context,
      { success: true, run_id: context.runId, operator_control: control },
      options,
    );
    return;
  }
  if (command === "resolve-checkpoint") {
    const decision = options.decision;
    if (!["approved", "rejected", "escalated"].includes(decision)) {
      throw new Error("--decision must be approved, rejected, or escalated");
    }
    for (const key of ["checkpoint-id", "decision-id", "actor", "rationale"]) {
      if (!options[key]) throw new Error(`resolve-checkpoint requires --${key}`);
    }
    const checkpoint = resolveCheckpointById(
      context.runId,
      options["checkpoint-id"],
      {
        status: decision,
        decisionId: options["decision-id"],
        actor: options.actor,
        rationale: options.rationale,
      },
      context.workspaceRoot,
    );
    appendTraceEvent(
      context.runId,
      {
        event: "checkpoint_resolved",
        phase: checkpoint.phase,
        status: decision === "approved" ? "ok" : "blocked",
        metadata: { checkpoint_id: checkpoint.checkpoint_id, outcome: decision },
      },
      context.workspaceRoot,
    );
    if (decision !== "approved") {
      appendTraceEvent(
        context.runId,
        { event: "run_blocked", phase: checkpoint.phase, status: "blocked" },
        context.workspaceRoot,
      );
    }
    emitReadableControlResult(
      context,
      { success: true, run_id: context.runId, checkpoint },
      options,
    );
    return;
  }
  if (command === "events") {
    const afterSeq = Number(options["after-seq"] ?? 0);
    const limit = Number(options.limit ?? 100);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new Error("--after-seq must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("--limit must be an integer between 1 and 1000");
    }
    const all = projectOperatorEvents(context.runId, context.workspaceRoot).filter(
      (event) => event.seq > afterSeq,
    );
    const events = all.slice(0, limit);
    emitReadableControlResult(
      context,
      {
        schema_version: "1.0.0",
        run_id: context.runId,
        after_seq: afterSeq,
        next_after_seq: events.at(-1)?.seq ?? afterSeq,
        has_more: all.length > events.length,
        events,
      },
      { ...options, json: true },
    );
    return;
  }
  throw new Error(`unsupported control command: ${command}`);
}

export function runWorkflow(command, options) {
  if (command === "run") validateOptions(options);
  if (command === "resume") validateFreshCommandResume(options);
  const context = initializeOrResume(command, options);
  const runOptions = context.savedAgentOptions
    ? mergeResumeOptions(context.savedAgentOptions, options)
    : options;
  validateOptions(runOptions);
  const through = runOptions.through ?? "release-readiness";
  const controlPolicy = checkpointPolicy(runOptions["checkpoint-policy"]);
  const throughIndex = PHASE_ORDER.indexOf(through);
  const state = readJsonStrict(resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"));
  const completed = new Set(state.completed_gates ?? []);
  const phases = PHASE_ORDER.slice(0, throughIndex + 1).filter(
    (phase) => !completed.has(`${phase}-gate`),
  );
  let provider = runOptions.provider ?? "auto";
  const releaseLock = acquireWorkflowLock(context.workspaceRoot, context.runId);

  try {
    try {
      const previousControl = readOperatorControl(context.runId, context.workspaceRoot);
      const allPhasesCompleted = PHASE_ORDER.every((phase) => completed.has(`${phase}-gate`));
      if (command === "resume" && previousControl.status === "completed" && allPhasesCompleted) {
        throw new Error(`cannot resume terminal run status: ${previousControl.status}`);
      }
      if (command === "resume") {
        const checkpoints = listCheckpoints(context.runId, context.workspaceRoot);
        const terminalRejection = checkpoints.find((checkpoint) =>
          ["rejected", "escalated"].includes(checkpoint.status),
        );
        if (terminalRejection) {
          if (previousControl.status === "waiting") {
            setRunStatus(context.runId, "blocked", context.workspaceRoot, {
              waiting_checkpoint_id: null,
              stop_requested: false,
            });
          }
          throw new Error(
            `cannot resume after checkpoint ${terminalRejection.checkpoint_id} was ${terminalRejection.status}`,
          );
        }
        const waiting = checkpoints.find(
          (checkpoint) => checkpoint.checkpoint_id === previousControl.waiting_checkpoint_id,
        );
        if (previousControl.status === "waiting" && waiting?.status === "pending") {
          const report = writeRunReport(context, { provider, status: "waiting" });
          printFinal(context, report, runOptions);
          return;
        }
        if (previousControl.status === "waiting" && waiting?.status === "approved") {
          // A crash can occur after the durable checkpoint decision but before its
          // control record transition. Reconcile the stale wait before executing.
          setRunStatus(context.runId, "running", context.workspaceRoot, {
            waiting_checkpoint_id: null,
            stop_requested: false,
          });
        }
        if (previousControl.status === "waiting" && waiting?.status !== "approved") {
          setRunStatus(context.runId, "blocked", context.workspaceRoot, {
            waiting_checkpoint_id: null,
            stop_requested: false,
          });
          throw new Error("cannot resume an unreconciled checkpoint state");
        }
      }
      setRunStatus(context.runId, "running", context.workspaceRoot, { stop_requested: false });
      if (command === "resume") {
        appendTraceEvent(
          context.runId,
          { event: "run_resumed", phase: nextRunPhase(state), status: "ok" },
          context.workspaceRoot,
        );
      }
      if (command === "resume") {
        refreshResumeRefBaseline(context.workspaceRoot, context.initialGitState);
      } else {
        assertGitStateInvariant(context.workspaceRoot, context.initialGitState, "run preflight");
      }
      for (const phase of phases) {
        const control = readOperatorControl(context.runId, context.workspaceRoot);
        if (control.stop_requested) {
          publishStoppedRun(context, provider, phase, runOptions);
          return;
        }
        if (
          phase === "build" &&
          ["before-mutation", "before-mutation-and-ship"].includes(controlPolicy)
        ) {
          const checkpointResult = checkpointPause(context, phase, "mutation");
          if (checkpointResult === "stopped") {
            publishStoppedRun(context, provider, phase, runOptions);
            return;
          }
          if (checkpointResult === "waiting") {
            const report = writeRunReport(context, { provider, status: "waiting" });
            printFinal(context, report, runOptions);
            return;
          }
        }
        if (phase === "release-readiness") completeReviewLoop(context.workspaceRoot, context.runId);
        const result = runOnePhase(context, phase, runOptions);
        provider = result.agent_provider;
        process.stderr.write(`RAE phase ${phase}: ${result.gate.status}\n`);
      }
      if (through === "release-readiness") {
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
      if (through === "release-readiness" && controlPolicy === "before-mutation-and-ship") {
        const checkpointResult = checkpointPause(context, "release-readiness", "ship");
        if (checkpointResult === "stopped") {
          publishStoppedRun(context, provider, "release-readiness", runOptions);
          return;
        }
        if (checkpointResult === "waiting") {
          const report = writeRunReport(context, { provider, status: "waiting" });
          printFinal(context, report, runOptions);
          return;
        }
      }
      const finalControl = readOperatorControl(context.runId, context.workspaceRoot);
      if (finalControl.stop_requested) {
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
      const report = writeRunReport(context, { provider });
      printFinal(context, report, runOptions);
    } catch (error) {
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
        setRunStatus(context.runId, "blocked", context.workspaceRoot, {
          stop_requested: false,
        });
        const currentState = readJsonStrict(
          resolve(context.workspaceRoot, ".pipeline", "pipeline-state.json"),
        );
        appendTraceEvent(
          context.runId,
          { event: "run_blocked", phase: nextRunPhase(currentState), status: "blocked" },
          context.workspaceRoot,
        );
      }
      const report = writeRunReport(context, { provider, error: error.message });
      printFinal(context, report, runOptions, error);
      process.exitCode = 1;
    }
  } finally {
    releaseLock();
  }
}
