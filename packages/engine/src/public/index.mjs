/** The sole supported import boundary for RAE engine consumers. */
import { resolve } from "node:path";
import {
  engineRuntimeRoot,
  pipelineInitEntrypoint,
} from "../primitives/installation-paths.mjs";

export { assertSupportedNodeRuntime, NODE_RUNTIME_RANGE } from "../primitives/node-runtime.mjs";
export { appendTraceEvent, projectOperatorEvents } from "../run/trace.mjs";
export { readOperatorEventsAfter } from "../run/operator-trace-reader.mjs";
export { agentDoctor, minimalChildEnvironment } from "../agents/agent-executor.mjs";
export { ensureRuntimeStateReadable, inspectRuntimeStateGuard } from "../run/runtime-state-guard.mjs";
export {
  listCheckpoints,
  readOperatorControl,
  requestStop,
  resolveCheckpointById,
  setRunStatus,
} from "../run/operator-control.mjs";
export { graphStatus, memoryStatus } from "../graph/index.mjs";
export {
  loadExecutionProfile,
  resolveExecutionTier,
  resolveNodeCapabilities,
} from "../workflow/execution-profile.mjs";
export { loadWorkflow, validateWorkflow, workflowDigest } from "../workflow/workflow-contract.mjs";
export { createWorkflowRegistry } from "../workflow/workflow-registry.mjs";
export { proposeWorkflowCandidate } from "../workflow/workflow-proposal.mjs";
export {
  analyzeWorkflow,
  compileWorkflowTemplate,
  listWorkflowTemplates,
} from "../workflow/workflow-designer.mjs";

export function autonomousEntrypoint() {
  return resolve(import.meta.dirname, "../cli/autonomous.mjs");
}

export function graphCliEntrypoint() {
  return resolve(import.meta.dirname, "../cli/graph-cli.mjs");
}

export function workflowAgentWorkerPath() {
  return resolve(import.meta.dirname, "../cli/workflow-agent-worker.mjs");
}

export function executionRuntimeCwd() {
  return engineRuntimeRoot;
}

export { pipelineInitEntrypoint };
