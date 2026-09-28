/** The sole supported import boundary for RAE engine consumers. */
import {
  cliAutonomousEntrypoint,
  cliGraphEntrypoint,
  cliRunnerEntrypoint,
  cliWorkflowAgentWorkerEntrypoint,
  engineRuntimeRoot,
  pipelineInitEntrypoint,
} from "../primitives/installation-paths.js";

export { assertSupportedNodeRuntime, NODE_RUNTIME_RANGE } from "../primitives/node-runtime.js";
export { appendTraceEvent, projectOperatorEvents } from "../run/trace.js";
export { readOperatorEventsAfter, readOperatorEventPages } from "../run/operator-trace-reader.js";
export {
  agentDoctor,
  minimalChildEnvironment,
  runAgentPhase,
  type AgentExecutionResult,
  type AgentPhaseOptions,
  type AgentProvider,
  type ProviderRuntimeIdentity,
} from "../agents/agent-executor.js";
export {
  ensureRuntimeStateReadable,
  inspectRuntimeStateGuard,
} from "../run/runtime-state-guard.js";
export {
  listCheckpoints,
  readOperatorControl,
  requestStop,
  resolveCheckpointById,
  setRunStatus,
} from "../run/operator-control.js";
export { graphStatus, memoryStatus } from "../graph/index.js";
export {
  loadExecutionProfile,
  resolveExecutionTier,
  resolveNodeCapabilities,
  type CapabilitySet,
  type ExecutionProfile,
  type ExecutionProfileExecutor,
  type ResolvedWorkflowRoute,
} from "../workflow/execution-profile.js";
export { loadWorkflow, validateWorkflow, workflowDigest } from "../workflow/workflow-contract.js";
export { createWorkflowRegistry } from "../workflow/workflow-registry.js";
export {
  proposeWorkflowCandidate,
  proposeWorkflowCandidateAsync,
} from "../workflow/workflow-proposal.js";
export {
  analyzeWorkflow,
  compileWorkflowTemplate,
  listWorkflowTemplates,
} from "../workflow/workflow-designer.js";

export function autonomousEntrypoint(): string {
  return cliAutonomousEntrypoint();
}

export function graphCliEntrypoint(): string {
  return cliGraphEntrypoint();
}

export function workflowAgentWorkerPath(): string {
  return cliWorkflowAgentWorkerEntrypoint();
}

export function stagedEntrypoint(): string {
  return cliRunnerEntrypoint();
}

export function executionRuntimeCwd(): string {
  return engineRuntimeRoot;
}

export { pipelineInitEntrypoint };
