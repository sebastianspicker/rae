/** Runs one provider phase through isolated preparation, execution, validation, and recording steps. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import {
  runAgentPhase,
  type AgentPhaseOptions,
  type AgentProvider,
} from "../agents/agent-executor.js";
import type {
  ArtifactsBuildReport,
  ArtifactsExecutionPlan,
  ArtifactsQualityReport,
  ArtifactsReleaseReadiness,
  AutonomousPolicy,
} from "@rae/contracts";
import { enforceCommandEvidence } from "./autonomous-evidence.js";
import {
  assertGitStateInvariant,
  assertRuntimeNamespaceInvariant,
  runtimeNamespaceSnapshot,
  validateConcurrentOperatorChanges,
} from "./autonomous-git.js";
import { createRuntimeStateGuard, reconcileRuntimeStateGuard } from "./runtime-state-guard.js";
import {
  buildPrompt,
  gateStatusForArtifact,
  normalizeReleaseArtifact,
  ownershipAssessment,
  phaseArtifacts,
  postBuildOwnership,
  SCHEMAS,
  type AutonomousPhase,
  type OwnershipAssessment,
  type PhaseGateStatus,
} from "./autonomous-phase-contract.js";
import { appendTraceEvent } from "./trace.js";
import { writeJson } from "./state.js";
import { readOperatorControl } from "./operator-control.js";
import { invokeRunner } from "./runner-port.js";
import { projectGraph, queryGraph, retrieveMemoryContext } from "../graph/index.js";
import { repositoryRoot } from "../primitives/installation-paths.js";
import type { GitStateSnapshot } from "./autonomous-git.js";

export interface AutonomousRunContext {
  runId: string;
  task: string;
  projectRoot: string;
  workspaceRoot: string;
  runDir: string;
  policy?: AutonomousPolicy | null;
  initialGitState: GitStateSnapshot;
  [key: string]: unknown;
}

export interface PhaseExecutionOptions extends Record<string, unknown> {
  provider?: AgentProvider | "auto";
  "agent-command"?: string;
  agentArgs?: readonly string[];
  model?: string;
  "reasoning-effort"?: string;
  variant?: string;
  "timeout-seconds"?: number | string;
  "allow-unsafe-command-provider"?: boolean;
  "graph-memory"?: string;
}

type AgentResult = Awaited<ReturnType<typeof runAgentPhase>>;
interface ProviderError extends Error {
  eventLogPath?: string;
  pipelineStateUnsafe?: boolean;
}
interface PhasePreparation {
  inputs: Record<string, Record<string, unknown>>;
  approvedPlan: Record<string, unknown> | null;
  outputPath: string;
  eventLogPath: string;
  traceRef: string;
  workspaceRoot: string;
  schemaPath: string;
  prompt: string;
  sandboxMode: string;
  runtimeBefore: Map<string, string>;
  controlBefore: Record<string, unknown>;
  traceBefore: string;
  runtimeGuard?: { active: string; runId: string };
}
interface ProviderExecution {
  result?: AgentResult;
  error?: ProviderError;
}
interface EvidenceAssessment extends Record<string, unknown> {
  status: string;
}
interface ArtifactAssessment {
  artifact: Record<string, unknown>;
  evidence: EvidenceAssessment;
  ownership: OwnershipAssessment | null;
  status: PhaseGateStatus;
}

const DEFAULT_TIMEOUT_SECONDS = 1800;

export async function runOnePhase(
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
): Promise<Record<string, unknown>> {
  const state = preparePhase(context, phase, options);
  const execution = await executeProvider(state, context, phase, options);
  validateProviderRuntime(state, context, phase, options, execution);
  throwProviderError(execution.error, context, phase, options, state.sandboxMode);
  if (!execution.result) throw new Error(`${phase} provider returned no result`);
  const assessment = assessArtifact(execution.result, state, context, phase);
  persistArtifact(assessment.artifact, state);
  recordAgentCall(execution.result, assessment, state, context, phase);
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
  const advanced = advanceStage(
    assessment.status,
    state,
    context,
    phase,
    execution.result.provider,
  );
  if ((options["graph-memory"] ?? "off") !== "off") {
    projectGraph({ projectRoot: context.workspaceRoot, runId: context.runId });
  }
  return advanced;
}

function preparePhase(
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
): PhasePreparation {
  const runDir = resolve(context.workspaceRoot, ".pipeline", "runs", context.runId);
  const outputDir = resolve(runDir, "agent-outputs");
  mkdirSync(outputDir, { recursive: true });
  const inputs = phaseArtifacts(runDir, phase, context.policy);
  const approvedPlan = inputs["plan.json"] ?? null;
  requireApprovedPlan(phase, approvedPlan);
  const outputPath = resolve(outputDir, `${phase}.json`);
  const eventLogPath = resolve(outputDir, `${phase}.events.jsonl`);
  const traceRef = `runs/${context.runId}/trace.jsonl`;
  const graphContext = prepareGraphContext(context, phase, options, inputs);
  const state = {
    inputs,
    approvedPlan,
    outputPath,
    eventLogPath,
    traceRef,
    workspaceRoot: context.workspaceRoot,
    schemaPath: resolve(repositoryRoot, SCHEMAS[phase]),
    prompt: buildPrompt({ ...context, phase, inputs, graphContext }),
    sandboxMode: mutationPhase(phase) ? "workspace-write" : "read-only",
    runtimeBefore: runtimeSnapshot(context, traceRef),
    controlBefore: readControl(context),
    traceBefore: readTrace(context.workspaceRoot, traceRef),
  };
  return state;
}

function prepareGraphContext(
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
  inputs: Record<string, Record<string, unknown>>,
): Record<string, unknown> | null {
  const mode = options["graph-memory"] ?? "off";
  if (mode === "off") return null;
  projectGraph({ projectRoot: context.workspaceRoot, runId: context.runId });
  let projection = queryGraph({
    projectRoot: context.workspaceRoot,
    runId: context.runId,
    seed: phaseGraphSeed(phase, context.task),
    phase,
    maxDepth: 4,
    maxRecords: 50,
  });
  let memory = retrieveMemoryContext({
    projectRoot: context.workspaceRoot,
    seed: context.task,
    limit: 50,
  });
  const budget = graphContextBudget(context.workspaceRoot, phase, inputs);
  if (budget !== null) {
    const selected: typeof projection.records = [];
    let used = 0;
    for (const record of projection.records) {
      const size = JSON.stringify(record).length;
      if (used + size > budget) break;
      selected.push(record);
      used += size;
    }
    projection = { ...projection, records: selected };
    memory = memory.filter((record) => {
      const size = JSON.stringify(record).length;
      if (used + size > budget) return false;
      used += size;
      return true;
    });
    const contextPath = resolve(
      context.workspaceRoot,
      ".pipeline",
      "runs",
      context.runId,
      "graph",
      "contexts",
      `${phase}.json`,
    );
    writeJson(contextPath, projection);
  }
  return { projection, memory };
}

function phaseGraphSeed(phase: AutonomousPhase, task: string): string {
  const terms: Partial<Record<AutonomousPhase, string>> = {
    arm: "repository contracts manifests documentation conventions",
    design: "repository contracts manifests documentation conventions",
    plan: "requirements design candidate files tests verification commands",
    build: "requirements design candidate files tests verification commands",
    "quality-static": "changed files affected tests commands findings gates",
    "quality-tests": "changed files affected tests commands findings gates",
    "post-build": "changed files affected tests commands findings gates",
    "release-readiness": "requirements implementation verification residual conditions gates",
  };
  return `${task}\n${terms[phase] ?? "requirements evidence"}`;
}

function graphContextBudget(
  workspaceRoot: string,
  phase: AutonomousPhase,
  inputs: Record<string, Record<string, unknown>>,
): number | null {
  const statePath = resolve(workspaceRoot, ".pipeline", "pipeline-state.json");
  if (!existsSync(statePath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  const state =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const config =
    state.config && typeof state.config === "object" && !Array.isArray(state.config)
      ? (state.config as Record<string, unknown>)
      : {};
  const budgets =
    config.context_budgets &&
    typeof config.context_budgets === "object" &&
    !Array.isArray(config.context_budgets)
      ? (config.context_budgets as Record<string, unknown>)
      : {};
  const configured = budgets[phase];
  if (configured === undefined) return null;
  const tokens = Number(
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? ((configured as Record<string, unknown>).token_max ??
          (configured as Record<string, unknown>).max_tokens)
      : configured,
  );
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.max(0, Math.trunc(tokens * 4) - JSON.stringify(inputs).length);
}

function requireApprovedPlan(
  phase: AutonomousPhase,
  approvedPlan: Record<string, unknown> | null,
): void {
  if (mutationPhase(phase) && !approvedPlan)
    throw new Error(`${phase} requires the approved plan artifact in its policy inputs`);
}
function mutationPhase(phase: AutonomousPhase): boolean {
  return phase === "build" || phase === "post-build";
}
function runtimeSnapshot(context: AutonomousRunContext, traceRef: string): Map<string, string> {
  return runtimeNamespaceSnapshot(context.workspaceRoot, [
    controlRef(context),
    `${controlRef(context)}.lock`,
    traceRef,
  ]);
}
function controlRef(context: AutonomousRunContext): string {
  return `runs/${context.runId}/operator-control.json`;
}
function readControl(context: AutonomousRunContext): Record<string, unknown> {
  return readOperatorControl(context.runId, context.workspaceRoot) as unknown as Record<
    string,
    unknown
  >;
}
function readTrace(workspaceRoot: string, traceRef: string): string {
  const pathValue = resolve(workspaceRoot, ".pipeline", traceRef);
  return existsSync(pathValue) ? readFileSync(pathValue, "utf8") : "";
}

async function executeProvider(
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
): Promise<ProviderExecution> {
  const tempDir = mkdtempSync(resolve(tmpdir(), "rae-agent-output-"));
  let result: AgentResult | undefined;
  let error: ProviderError | undefined;
  if (mutationPhase(phase)) {
    state.runtimeGuard = createRuntimeStateGuard(context.workspaceRoot, context.runId, phase);
  }
  try {
    result = await runAgentPhase(providerRequest(state, context, phase, options, tempDir));
  } catch (caught) {
    error = errorValue(caught);
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (caught) {
    error ??= errorValue(caught);
  }
  return { result, error };
}

function errorValue(value: unknown): ProviderError {
  return value instanceof Error ? (value as ProviderError) : new Error(String(value));
}

function providerRequest(
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
  tempDir: string,
): AgentPhaseOptions {
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
    variant: options.variant,
    sourceRoot: context.projectRoot,
    runDir: context.runDir,
    inPlace: context.workspaceRoot === context.projectRoot,
    timeoutMs: Number(options["timeout-seconds"] ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    allowUnsafeCommand: options["allow-unsafe-command-provider"] === true,
  };
}

function validateProviderRuntime(
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
  execution: ProviderExecution,
): void {
  const eventLog = execution.result?.eventLogPath ?? execution.error?.eventLogPath;
  const allowed = eventLog ? [relative(resolve(context.workspaceRoot, ".pipeline"), eventLog)] : [];
  if (state.runtimeGuard) {
    let reconciliation: ReturnType<typeof reconcileRuntimeStateGuard>;
    try {
      reconciliation = reconcileRuntimeStateGuard(context.workspaceRoot, {
        allowedRefs: allowed,
        expectedRunId: context.runId,
      });
    } catch (error) {
      const failure = errorValue(error);
      failure.pipelineStateUnsafe = true;
      throw failure;
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

function throwProviderError(
  error: ProviderError | undefined,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
  sandboxMode: string,
): void {
  if (!error) return;
  recordProviderError(error, context, phase, options, sandboxMode);
  throw error;
}
function recordProviderError(
  error: unknown,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  options: PhaseExecutionOptions,
  sandboxMode: string,
): void {
  const failure = errorValue(error);
  appendTraceEvent(
    context.runId,
    {
      event: "agent_call",
      phase,
      status: "error",
      message: failure.message,
      metadata: { provider: options.provider ?? "auto", sandbox_mode: sandboxMode },
    },
    context.workspaceRoot,
  );
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, phase);
}

function assessArtifact(
  result: AgentResult,
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
): ArtifactAssessment {
  const artifact =
    phase === "release-readiness"
      ? (normalizeReleaseArtifact(result.artifact as ArtifactsReleaseReadiness) as Record<
          string,
          unknown
        >)
      : result.artifact;
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
function phaseOwnership(
  phase: AutonomousPhase,
  plan: Record<string, unknown> | null,
  workspaceRoot: string,
  artifact: Record<string, unknown>,
): OwnershipAssessment | null {
  if (phase === "build")
    return ownershipAssessment(
      plan as ArtifactsExecutionPlan,
      workspaceRoot,
      artifact as ArtifactsBuildReport,
    );
  if (phase === "post-build")
    return postBuildOwnership(
      plan as ArtifactsExecutionPlan,
      workspaceRoot,
      artifact as ArtifactsQualityReport,
    );
  return null;
}
function stageStatus(
  status: PhaseGateStatus,
  evidence: EvidenceAssessment,
  ownership: OwnershipAssessment | null,
): PhaseGateStatus {
  if (evidence.status === "missing") return "fail";
  return ownership?.status === "fail" ? "fail" : status;
}
function persistArtifact(artifact: Record<string, unknown>, state: PhasePreparation): void {
  writeJson(state.outputPath, artifact);
}

function recordAgentCall(
  result: AgentResult,
  assessment: ArtifactAssessment,
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
): void {
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
function reasoningTier(phase: AutonomousPhase): "high_reasoning" | "balanced" {
  return phase === "arm" || phase === "release-readiness" ? "high_reasoning" : "balanced";
}
function agentMetadata(
  result: AgentResult,
  assessment: ArtifactAssessment,
  state: PhasePreparation,
): Record<string, unknown> {
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
function eventLogMetadata(result: AgentResult, state: PhasePreparation): Record<string, unknown> {
  return {
    event_log: result.eventLogPath ? relative(state.workspaceRoot, result.eventLogPath) : null,
    event_count: result.eventCount,
    command_event_count: result.commandEventCount,
  };
}

function advanceStage(
  status: PhaseGateStatus,
  state: PhasePreparation,
  context: AutonomousRunContext,
  phase: AutonomousPhase,
  provider: AgentProvider,
): Record<string, unknown> {
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
  const parsed: unknown = JSON.parse(runner.stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${phase} runner returned a non-object response`);
  }
  return { ...(parsed as Record<string, unknown>), agent_provider: provider };
}
function runnerDetail(runner: { stderr: string | null; stdout: string | null }): string {
  return `${runner.stderr ?? ""}\n${runner.stdout ?? ""}`.trim().slice(-6000);
}
