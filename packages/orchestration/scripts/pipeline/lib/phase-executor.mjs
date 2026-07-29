/** Runs one provider phase through isolated preparation, execution, validation, and recording steps. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { runAgentPhase } from "./agent-executor.mjs";
import { enforceCommandEvidence } from "./autonomous-evidence.mjs";
import {
  assertGitStateInvariant,
  assertRuntimeNamespaceInvariant,
  runtimeNamespaceSnapshot,
  validateConcurrentOperatorChanges,
} from "./autonomous-git.mjs";
import { createRuntimeStateGuard, reconcileRuntimeStateGuard } from "./runtime-state-guard.mjs";
import {
  buildPrompt,
  gateStatusForArtifact,
  normalizeReleaseArtifact,
  ownershipAssessment,
  phaseArtifacts,
  postBuildOwnership,
  SCHEMAS,
} from "./autonomous-phase-contract.mjs";
import { appendTraceEvent } from "./trace.mjs";
import { writeJson } from "./state.mjs";
import { readOperatorControl } from "./operator-control.mjs";
import { invokeRunner } from "./autonomous-execution.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_TIMEOUT_SECONDS = 1800;

export function runOnePhase(context, phase, options) {
  const state = preparePhase(context, phase);
  const execution = executeProvider(state, context, phase, options);
  validateProviderRuntime(state, context, phase, options, execution);
  throwProviderError(execution.error, context, phase, options, state.sandboxMode);
  const assessment = assessArtifact(execution.result, state, context, phase);
  persistArtifact(assessment.artifact, state);
  recordAgentCall(execution.result, assessment, state, context, phase);
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
  return advanceStage(assessment.status, state, context, phase, execution.result.provider);
}

function preparePhase(context, phase) {
  const runDir = resolve(context.workspaceRoot, ".pipeline", "runs", context.runId);
  const outputDir = resolve(runDir, "agent-outputs");
  mkdirSync(outputDir, { recursive: true });
  const inputs = phaseArtifacts(runDir, phase, context.policy);
  const approvedPlan = inputs["plan.json"] ?? null;
  requireApprovedPlan(phase, approvedPlan);
  const outputPath = resolve(outputDir, `${phase}.json`);
  const eventLogPath = resolve(outputDir, `${phase}.events.jsonl`);
  const traceRef = `runs/${context.runId}/trace.jsonl`;
  const state = {
    inputs,
    approvedPlan,
    outputPath,
    eventLogPath,
    traceRef,
    workspaceRoot: context.workspaceRoot,
    schemaPath: resolve(PACKAGE_ROOT, SCHEMAS[phase]),
    prompt: buildPrompt({ ...context, phase, inputs }),
    sandboxMode: mutationPhase(phase) ? "workspace-write" : "read-only",
    runtimeBefore: runtimeSnapshot(context, traceRef),
    controlBefore: readControl(context),
    traceBefore: readTrace(context.workspaceRoot, traceRef),
  };
  return state;
}

function requireApprovedPlan(phase, approvedPlan) {
  if (mutationPhase(phase) && !approvedPlan)
    throw new Error(`${phase} requires the approved plan artifact in its policy inputs`);
}
function mutationPhase(phase) {
  return phase === "build" || phase === "post-build";
}
function runtimeSnapshot(context, traceRef) {
  return runtimeNamespaceSnapshot(context.workspaceRoot, [
    controlRef(context),
    `${controlRef(context)}.lock`,
    traceRef,
  ]);
}
function controlRef(context) {
  return `runs/${context.runId}/operator-control.json`;
}
function readControl(context) {
  return readOperatorControl(context.runId, context.workspaceRoot);
}
function readTrace(workspaceRoot, traceRef) {
  const pathValue = resolve(workspaceRoot, ".pipeline", traceRef);
  return existsSync(pathValue) ? readFileSync(pathValue, "utf8") : "";
}

function executeProvider(state, context, phase, options) {
  const tempDir = mkdtempSync(resolve(tmpdir(), "rae-agent-output-"));
  let result;
  let error;
  if (mutationPhase(phase)) {
    state.runtimeGuard = createRuntimeStateGuard(context.workspaceRoot, context.runId, phase);
  }
  try {
    result = runAgentPhase(providerRequest(state, context, phase, options, tempDir));
  } catch (caught) {
    error = caught;
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (caught) {
    error ??= caught;
  }
  return { result, error };
}

function providerRequest(state, context, phase, options, tempDir) {
  return {
    provider: options.provider ?? "auto",
    command: options["agent-command"],
    commandArgs: options.agentArgs,
    phase,
    runId: context.runId,
    workspaceRoot: context.workspaceRoot,
    schemaPath: state.schemaPath,
    outputPath: resolve(tempDir, `${phase}.json`),
    eventLogPath: state.eventLogPath,
    prompt: state.prompt,
    sandboxMode: state.sandboxMode,
    model: options.model,
    reasoningEffort: options["reasoning-effort"],
    timeoutMs: Number(options["timeout-seconds"] ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    allowUnsafeCommand: options["allow-unsafe-command-provider"] === true,
  };
}

function validateProviderRuntime(state, context, phase, options, execution) {
  const eventLog = execution.result?.eventLogPath ?? execution.error?.eventLogPath;
  const allowed = eventLog ? [relative(resolve(context.workspaceRoot, ".pipeline"), eventLog)] : [];
  if (state.runtimeGuard) {
    let reconciliation;
    try {
      reconciliation = reconcileRuntimeStateGuard(context.workspaceRoot, {
        allowedRefs: allowed,
        expectedRunId: context.runId,
      });
    } catch (error) {
      error.pipelineStateUnsafe = true;
      throw error;
    }
    if (reconciliation.tampered) {
      const changed = reconciliation.changed?.length
        ? reconciliation.changed.slice(0, 8).join(", ")
        : (reconciliation.detail ?? "unsafe runtime entry");
      const error = new Error(`provider modified protected .pipeline state; restored: ${changed}`);
      recordProviderError(error, context, phase, options, state.sandboxMode);
      throw error;
    }
    return;
  }
  try {
    assertRuntimeNamespaceInvariant(state.runtimeBefore, context.workspaceRoot, [
      ...allowed,
      controlRef(context),
      `${controlRef(context)}.lock`,
      state.traceRef,
    ]);
    validateConcurrentOperatorChanges({
      beforeControl: state.controlBefore,
      afterControl: readControl(context),
      beforeTrace: state.traceBefore,
      afterTrace: readTrace(context.workspaceRoot, state.traceRef),
      runId: context.runId,
      expectedPhase: phase,
    });
  } catch (error) {
    recordProviderError(error, context, phase, options, state.sandboxMode);
    throw error;
  }
}

function throwProviderError(error, context, phase, options, sandboxMode) {
  if (!error) return;
  recordProviderError(error, context, phase, options, sandboxMode);
  throw error;
}
function recordProviderError(error, context, phase, options, sandboxMode) {
  appendTraceEvent(
    context.runId,
    {
      event: "agent_call",
      phase,
      status: "error",
      message: error.message,
      metadata: { provider: options.provider ?? "auto", sandbox_mode: sandboxMode },
    },
    context.workspaceRoot,
  );
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
}

function assessArtifact(result, state, context, phase) {
  const artifact =
    phase === "release-readiness" ? normalizeReleaseArtifact(result.artifact) : result.artifact;
  const evidence = enforceCommandEvidence(
    phase,
    result,
    artifact,
    state.approvedPlan,
    context.workspaceRoot,
  );
  const ownership = phaseOwnership(phase, state.approvedPlan, context.workspaceRoot, artifact);
  const status = stageStatus(gateStatusForArtifact(phase, artifact), evidence, ownership);
  return { artifact, evidence, ownership, status };
}
function phaseOwnership(phase, plan, workspaceRoot, artifact) {
  if (phase === "build") return ownershipAssessment(plan, workspaceRoot, artifact);
  if (phase === "post-build") return postBuildOwnership(plan, workspaceRoot, artifact);
  return null;
}
function stageStatus(status, evidence, ownership) {
  if (evidence.status === "missing") return "fail";
  return ownership?.status === "fail" ? "fail" : status;
}
function persistArtifact(artifact, state) {
  writeJson(state.outputPath, artifact);
}

function recordAgentCall(result, assessment, state, context, phase) {
  appendTraceEvent(
    context.runId,
    {
      event: "agent_call",
      phase,
      status: "ok",
      tier: reasoningTier(phase),
      duration_ms: result.durationMs,
      metadata: agentMetadata(result, assessment, state),
    },
    context.workspaceRoot,
  );
}
function reasoningTier(phase) {
  return phase === "arm" || phase === "release-readiness" ? "high_reasoning" : "balanced";
}
function agentMetadata(result, assessment, state) {
  return {
    provider: result.provider,
    sandbox_mode: state.sandboxMode,
    duration_ms: result.durationMs,
    structured_output: true,
    command_evidence: assessment.evidence,
    ...(result.eventLogPath ? eventLogMetadata(result, state) : {}),
    ...(assessment.ownership ? { ownership: assessment.ownership } : {}),
  };
}
function eventLogMetadata(result, state) {
  return {
    event_log: relative(state.workspaceRoot, result.eventLogPath),
    event_count: result.eventCount,
    command_event_count: result.commandEventCount,
  };
}

function advanceStage(status, state, context, phase, provider) {
  const inputRef = relative(context.workspaceRoot, state.outputPath);
  const runner = invokeRunner(
    context.workspaceRoot,
    [
      "run-stage",
      "--run-id",
      context.runId,
      "--phase",
      phase,
      "--input-artifact",
      inputRef,
      "--gate-status",
      status,
    ],
    true,
  );
  if (runner.status !== 0) throw new Error(`${phase} gate failed: ${runnerDetail(runner)}`);
  return { ...JSON.parse(runner.stdout), agent_provider: provider };
}
function runnerDetail(runner) {
  return `${runner.stderr ?? ""}\n${runner.stdout ?? ""}`.trim().slice(-6000);
}
