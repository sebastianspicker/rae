#!/usr/bin/env node
/**
 * Provides the pipeline runner CLI that validates and advances staged workflow state.
 */
import { CONFIG_IDS as CONFIG_ID_LIST, DEFAULT_CONFIG_ID, PHASE_ORDER } from "../lib/constants.mjs";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";
import { badInput } from "./lib/errors.mjs";
import {
  activateWorkspaceRoot,
  ensureRunDirs,
  resolveWorkspaceRootForRun,
  withLockedState,
} from "./lib/state.mjs";
import { appendTraceEvent } from "./lib/trace.mjs";
import { emitRetryEventIfNeeded, gateStatusFromPhaseAndProfile } from "./lib/gates.mjs";
import {
  printUsage,
  runEndPhase,
  runRecordArtifact,
  runRecordGate,
  runRecordReviewState,
  runStartPhase,
  runSummarizeProgress,
  runSummarizeRun,
} from "./lib/commands.mjs";
import { badInput } from "./lib/errors.mjs";
import { emitRetryEventIfNeeded, gateStatusFromPhaseAndProfile } from "./lib/gates.mjs";
import {
  appendTaskSessionEvent,
  ensureStateForRun,
  loadTasksetTask,
  resolveActivityProfile,
  resolveCognitiveTier,
  resolveTaskSession,
  stageProfileFromTask,
} from "./lib/runner-helpers-a.mjs";
import {
  appendRunEndIfMissing,
  appendRunStartIfMissing,
  emitPrimaryGate,
  evaluateAuxiliaryGates,
  recordPhaseCompletion,
  resolveAndWriteArtifact,
} from "./lib/runner-helpers-b.mjs";
import { sandboxEnforcementReport } from "./lib/subprocess.mjs";

assertSupportedNodeRuntime();

const PHASES = PHASE_ORDER;
const CONFIG_IDS = new Set(CONFIG_ID_LIST);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor", "toString"]);

function assertSafeKey(key, label) {
  if (UNSAFE_KEYS.has(key)) {
    throw badInput(`${label} is not allowed: ${key}`);
  }
}

function parseOptions(argv) {
  const out = Object.create(null);
  out._ = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      assertSafeKey(key, "option name");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
      continue;
    }
    out._.push(token);
  }
  return out;
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === null || value === "") {
    throw badInput(`missing required option --${key}`);
  }
  return value;
}

function assertKnownPhase(phase, source = "phase") {
  if (!PHASES.includes(phase)) {
    throw badInput(`${source} must be one of: ${PHASES.join(", ")}`);
  }
}

function assertPhaseReady(state, phase) {
  const completedGates = new Set(Array.isArray(state.completed_gates) ? state.completed_gates : []);
  const expectedPhase = PHASES.find((candidate) => !completedGates.has(`${candidate}-gate`));
  if (!expectedPhase) {
    throw badInput("pipeline run is already complete");
  }
  if (phase !== expectedPhase) {
    throw badInput(`phase out of order: expected ${expectedPhase}, received ${phase}`);
  }
}

function stageOptions(options) {
  const runId = requireOption(options, "run-id");
  const phase = requireOption(options, "phase");
  const { configId, root, state } = prepareStage(runId, phase, options);
  const stageContext = prepareStageContext({ runId, phase, configId, root, state, options });
  const { taskContext, taskSession, activityProfile, stageProfile, cognitiveTier } = stageContext;

  const configId = options["config-id"] || DEFAULT_CONFIG_ID;
  if (!CONFIG_IDS.has(configId)) {
    throw badInput(
      `unsupported config-id: ${configId}. Valid config IDs: ${[...CONFIG_IDS].join(", ")}`,
    );
  }
  return { runId, phase, configId };
}

function recordTasksetRead(runId, phase, taskContext, root) {
  if (!taskContext?.taskset_path) return;
  appendTraceEvent(runId, { event: "artifact_read", phase, artifact_ref: taskContext.taskset_path, status: "ok" }, root);
}

function stageTaskContext({ runId, phase, configId, options, state, root }) {
  const taskContext = loadTasksetTask(options.taskset, options["task-id"]);
  const taskSession = resolveTaskSession(phase, taskContext, options);
  const activityProfile = resolveActivityProfile(phase, state, taskSession);
  if (taskSession) taskSession.activity_profile = activityProfile;
  return { taskContext, taskSession, activityProfile, stageProfile: stageProfileFromTask({ task: taskContext?.task, configId, phase }) };
}

function recordStageStart({ runId, phase, state, taskSession, activityProfile, root }) {
  const cognitiveTier = activityProfile.tier ?? resolveCognitiveTier(phase, state);
  appendTraceEvent(runId, phaseStartEvent(phase, cognitiveTier, taskSession, activityProfile), root);
  appendTaskSessionEvent(runId, phase, "task_session_start", "ok", taskSession, root);
  return cognitiveTier;
}

function phaseStartEvent(phase, cognitiveTier, taskSession, activityProfile) {
  const metadata = { activity_id: activityProfile.activity_id, runtime_name: activityProfile.runtime_name, runtime_version: activityProfile.runtime_version };
  if (cognitiveTier) metadata.cognitive_tier = cognitiveTier;
  if (taskSession) Object.assign(metadata, { task_session_id: taskSession.session.session_id, task_session_kind: taskSession.session.session_kind });
  return { event: "phase_start", phase, status: "ok", tier: cognitiveTier ?? undefined, model_hint: activityProfile.model_hint ?? undefined, activity_id: activityProfile.activity_id, runtime_name: activityProfile.runtime_name, runtime_version: activityProfile.runtime_version, metadata };
}

function executeStageLocked(state, { runId, phase, configId, options, root }) {
  ensureStateForRun(state, runId);
  assertPhaseReady(state, phase);
  appendRunStartIfMissing(runId, state, root);
  const context = stageTaskContext({ runId, phase, configId, options, state, root });
  recordTasksetRead(runId, phase, context.taskContext, root);
  emitRetryEventIfNeeded(runId, phase, root);
  const cognitiveTier = recordStageStart({ runId, phase, state, taskSession: context.taskSession, activityProfile: context.activityProfile, root });
  const { artifact, artifactRef, schemaRef } = resolveAndWriteArtifact({ runId, phase, configId, options, taskContext: context.taskContext, stageProfile: context.stageProfile, state, root });
  const { gateStatuses, extraGates } = evaluateAuxiliaryGates({ runId, phase, artifact, artifactRef, schemaRef, state, root });
  const desiredStatus = options["gate-status"] || gateStatusFromPhaseAndProfile(phase, context.stageProfile);
  const primaryGate = emitPrimaryGate({ runId, phase, artifact, artifactRef, schemaRef, configId, cognitiveTier, activityProfile: context.activityProfile, desiredStatus, gateStatuses, root });
  ensureStateForRun(state, runId);
  appendTaskSessionEvent(runId, phase, "task_session_end", primaryGate.status === "fail" ? "error" : "ok", context.taskSession, root);
  recordPhaseCompletion({ runId, phase, state, primaryGate, root });
  return { success: primaryGate.status !== "fail", run_id: runId, phase, config_id: configId, gate: primaryGate, auxiliary_gates: extraGates, artifact_ref: artifactRef, schema_ref: schemaRef, task_session: context.taskSession?.session ?? null, activity_profile: context.activityProfile };
}

function runStage(options) {
  const { runId, phase, configId } = stageOptions(options);
  const root = resolveWorkspaceRootForRun(runId);
  ensureRunDirs(runId, root);
  const result = withLockedState(root, (state) => executeStageLocked(state, { runId, phase, configId, options, root }));

function prepareStage(runId, phase, options) {
  if (!PHASES.includes(phase))
    throw badInput(`unsupported phase: ${phase}. Valid phases: ${PHASES.join(", ")}`);
  const configId = options["config-id"] || DEFAULT_CONFIG_ID;
  if (!CONFIG_IDS.has(configId))
    throw badInput(
      `unsupported config-id: ${configId}. Valid config IDs: ${[...CONFIG_IDS].join(", ")}`,
    );
  const root = resolveWorkspaceRootForRun(runId);
  ensureRunDirs(runId, root);
  const state = loadPipelineState(root);
  ensureStateForRun(state, runId);
  appendRunStartIfMissing(runId, state, root);
  return { configId, root, state };
}

// Shared context passed to command functions
const ctx = {
  requireOption,
  assertKnownPhase,
  ensureStateForRun,
  appendRunStartIfMissing,
  appendRunEndIfMissing,
};

const COMMANDS = {
  "start-phase": (opts) => runStartPhase(opts, ctx),
  "end-phase": (opts) => runEndPhase(opts, ctx),
  "record-artifact": (opts) => runRecordArtifact(opts, ctx),
  "record-gate": (opts) => runRecordGate(opts, ctx),
  "record-review-state": (opts) => runRecordReviewState(opts, ctx),
  "summarize-run": (opts) => runSummarizeRun(opts, ctx),
  "summarize-progress": (opts) => runSummarizeProgress(opts, ctx),
  doctor: () => {
    const sandbox = sandboxEnforcementReport();
    process.stdout.write(`${JSON.stringify({ success: sandbox.enforced, sandbox }, null, 2)}\n`);
    if (!sandbox.enforced) {
      throw badInput(`sandbox enforcement unavailable: ${sandbox.reason}`);
    }
  },
  "run-stage": runStage,
};

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const options = parseOptions(rest);
  if (options["project-root"]) {
    activateWorkspaceRoot(options["project-root"]);
  }

  const handler = COMMANDS[command];
  if (!handler) {
    throw badInput(
      `unknown command: ${command}. Available commands: ${[...COMMANDS.keys()].join(", ")}`,
    );
  }
  handler(options);
}

/**
 * Human-readable hints for common tool error codes.
 * These codes are generated by toolError() in subprocess.mjs via
 * the pattern E_<TOOL_KEY>_<SUFFIX>. If tool names change in
 * SKILL_ENTRYPOINTS (constants.mjs), update these keys accordingly.
 * @see scripts/pipeline/lib/subprocess.mjs
 * @see scripts/pipeline/lib/errors.mjs toolError()
 */
const ERROR_HINTS = new Map([
  ["E_QUALITY_GATE_MISSING", "Hint: Run 'npm run build' in skills/dev-tools/quality-gate/"],
  [
    "E_QUALITY_GATE_TIMEOUT",
    "Hint: Quality-gate subprocess timed out. Check for large artifacts or increase timeout.",
  ],
  ["E_QUALITY_GATE_SIGNAL", "Hint: Quality-gate subprocess was killed. Check system resources."],
  [
    "E_QUALITY_GATE_EMPTY",
    "Hint: Quality-gate returned no output. Verify the skill builds cleanly.",
  ],
  ["E_TRACE_COLLECTOR_MISSING", "Hint: Run 'npm run build' in skills/dev-tools/trace-collector/"],
  [
    "E_TRACE_COLLECTOR_TIMEOUT",
    "Hint: Trace-collector subprocess timed out. Check trace.jsonl size.",
  ],
  [
    "E_TRACE_COLLECTOR_EMPTY",
    "Hint: Trace-collector returned no output. Verify the skill builds cleanly.",
  ],
  ["E_BAD_INPUT", "Hint: Run 'node scripts/pipeline/runner.mjs --help' for usage."],
  ["E_BAD_TRACE", "Hint: Check trace.jsonl for malformed lines."],
]);

try {
  main();
} catch (error) {
  const code = error?.code || "E_UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  const hint = typeof code === "string" ? ERROR_HINTS.get(code) : undefined;
  if (hint) {
    process.stderr.write(`${hint}\n`);
  }
  process.exit(1);
}
