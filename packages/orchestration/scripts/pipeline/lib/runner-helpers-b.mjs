/**
 * Records stage lifecycle results and coordinates primary and auxiliary gate emission.
 */
import { existsSync } from "node:fs";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import {
  gateFileNameForPhase,
  getRepoRoot,
  readJsonStrict,
  resolveWithinRepo,
  toWorkspaceRelative,
  writeJson,
} from "./state.mjs";
import { appendTraceEvent, ensureTraceFile, hasEvent } from "./trace.mjs";
import { buildArtifactForPhase, phaseArtifactDefaults } from "./artifacts.mjs";
import {
  QUALITY_GATE_PHASES,
  emitGate,
  evaluateContextBudgetGate,
  evaluateTraceabilityGate,
  runQualityGate,
  stageGateInput,
  updateStateAfterArtifact,
  worstStatus,
} from "./gates.mjs";
import {
  contextBudgetForPhase,
  phaseTokenForContextBudget,
  resolveArtifactRefForRun,
  resolveOptionalArtifactRefForRun,
  resolveQualityCoverageLedger,
  resolveReviewLoopSnapshot,
} from "./runner-helpers-a.mjs";
export function appendRunStartIfMissing(runId, state, root = getRepoRoot()) {
  ensureTraceFile(runId, root);
  if (!hasEvent(runId, "run_start", root)) {
    appendTraceEvent(
      runId,
      {
        event: "run_start",
        phase: state?.current_phase ?? "arm",
        status: "ok",
        metadata: {
          source: "runner",
        },
      },
      root,
    );
  }
}

export function appendRunEndIfMissing(runId, state, root = getRepoRoot(), options = {}) {
  ensureTraceFile(runId, root);
  if (!hasEvent(runId, "run_end", root)) {
    appendTraceEvent(
      runId,
      {
        event: "run_end",
        phase: state?.current_phase ?? "release-readiness",
        status: options.status ?? "ok",
        metadata: {
          source: options.source ?? "runner",
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
      root,
    );
  }
}

function readCallerArtifact({ runId, phase, inputArtifactRef, root }) {
  // Preserve caller-supplied artifacts exactly; the runner adds evidence
  // events and gate results around them instead of rewriting their content.
  const inputAbs = resolveWithinRepo(inputArtifactRef, root);
  appendTraceEvent(
    runId,
    {
      event: "artifact_read",
      phase,
      artifact_ref: toWorkspaceRelative(inputAbs, root),
      status: "ok",
    },
    root,
  );
  return readJsonStrict(inputAbs, `input artifact ${inputArtifactRef}`);
}

function buildOrReadArtifact({
  runId,
  phase,
  configId,
  options,
  taskContext,
  stageProfile,
  artifactAbs,
  artifactRef,
  budget,
  root,
}) {
  const inputArtifactRef = options["input-artifact"];
  if (inputArtifactRef) {
    return {
      artifact: readCallerArtifact({ runId, phase, inputArtifactRef, root }),
      wroteArtifact: true,
    };
  }

  const artifact = buildArtifactForPhase({
    phase,
    runId,
    configId,
    task: taskContext?.task,
    stageProfile,
    budget,
  });
  if (artifact) return { artifact, wroteArtifact: true };
  if (!existsSync(artifactAbs)) return { artifact: null, wroteArtifact: false };

  appendTraceEvent(
    runId,
    {
      event: "artifact_read",
      phase,
      artifact_ref: toWorkspaceRelative(artifactAbs, root),
      status: "ok",
    },
    root,
  );
  return { artifact: readJsonStrict(artifactAbs, `artifact ${artifactRef}`), wroteArtifact: false };
}

function addRunDerivedArtifactEvidence({ artifact, runId, phase, state, root }) {
  const coverageLedger = resolveQualityCoverageLedger(runId, state, phase, root);
  const artifactWithCoverage = coverageLedger
    ? {
        ...artifact,
        coverage_ledger: {
          coverage_scope: coverageLedger.coverage_scope,
          requirements: coverageLedger.requirements,
          summary: coverageLedger.summary,
        },
        qc_summary: coverageLedger.qc_summary,
      }
    : artifact;
  const reviewLoopSnapshot = resolveReviewLoopSnapshot(runId, phase, root);
  return reviewLoopSnapshot
    ? { ...artifactWithCoverage, ...reviewLoopSnapshot }
    : artifactWithCoverage;
}

function writeArtifactAndTrace({ runId, phase, artifactAbs, artifact, root }) {
  writeJson(artifactAbs, artifact);
  appendTraceEvent(
    runId,
    {
      event: "artifact_write",
      phase,
      artifact_ref: toWorkspaceRelative(artifactAbs, root),
      status: "ok",
    },
    root,
  );
}

export function resolveAndWriteArtifact({
  runId,
  phase,
  configId,
  options,
  taskContext,
  stageProfile,
  state,
  root,
}) {
  const defaults = phaseArtifactDefaults(phase);
  let artifactRef = options["artifact-ref"] || defaults.artifactRef;
  const schemaRef = options["schema-ref"] || defaults.schemaRef;
  let artifact = null;

  if (artifactRef) {
    const artifactAbs = resolveArtifactRefForRun(runId, artifactRef, root);
    const budget = contextBudgetForPhase(phaseTokenForContextBudget(phase), state);
    const resolved = buildOrReadArtifact({
      runId,
      phase,
      configId,
      options,
      taskContext,
      stageProfile,
      artifactAbs,
      artifactRef,
      budget,
      root,
    });
    artifact = resolved.artifact;
    if (artifact && !options["input-artifact"]) {
      artifact = addRunDerivedArtifactEvidence({ artifact, runId, phase, state, root });
    }
    if (resolved.wroteArtifact)
      writeArtifactAndTrace({ runId, phase, artifactAbs, artifact, root });

    artifactRef = toWorkspaceRelative(artifactAbs, root);
    if (artifact) {
      updateStateAfterArtifact(state, phase, artifactRef);
    }
  }

  return { artifact, artifactRef, schemaRef };
}

function recordAuxiliaryGate(gateStatuses, extraGates, gate, affectsPrimaryGate) {
  if (!gate) return;
  if (affectsPrimaryGate) gateStatuses.push(gate.status);
  extraGates.push(gate);
}

function evaluateBudgetGate({ runId, phase, artifact, artifactRef, schemaRef, state, root }) {
  const budget = contextBudgetForPhase(phaseTokenForContextBudget(phase), state);
  if (!artifact || !budget) return null;
  return evaluateContextBudgetGate({
    runId,
    phase,
    artifact,
    artifactRef: artifactRef || "n/a",
    schemaRef,
    state,
    budget,
    root,
  });
}

function evaluateTraceabilityGateForPhase({ runId, phase, state, root }) {
  if (phase !== "plan" && phase !== "build") return null;
  return evaluateTraceabilityGate({
    runId,
    phase,
    state,
    resolveArtifactRef: (nextRunId, artifactPath) =>
      resolveArtifactRefForRun(nextRunId, artifactPath, root),
    resolveOptionalArtifactRef: (nextRunId, artifactPath) =>
      resolveOptionalArtifactRefForRun(nextRunId, artifactPath, root),
    root,
  });
}

export function evaluateAuxiliaryGates({
  runId,
  phase,
  artifact,
  artifactRef,
  schemaRef,
  state,
  root,
}) {
  const gateStatuses = [];
  const extraGates = [];

  // Auxiliary gates can worsen the primary phase gate, but they are emitted as
  // separate artifacts so operators can see which invariant actually failed.
  const budgetGate = evaluateBudgetGate({
    runId,
    phase,
    artifact,
    artifactRef,
    schemaRef,
    state,
    root,
  });
  recordAuxiliaryGate(gateStatuses, extraGates, budgetGate, true);
  const traceabilityGate = evaluateTraceabilityGateForPhase({ runId, phase, state, root });
  recordAuxiliaryGate(
    gateStatuses,
    extraGates,
    traceabilityGate,
    traceabilityGate?.status === "fail",
  );

  return { gateStatuses, extraGates };
}

function valueOrNull(value) {
  return value === undefined || value === null ? null : value;
}

function primaryGateMetadata(options) {
  const activityProfile = options.activityProfile || {};
  return {
    gate_type: "phase",
    schema_ref: options.schemaRef,
    config_id: options.configId,
    cognitive_tier: options.cognitiveTier,
    activity_id: valueOrNull(activityProfile.activity_id),
    runtime_name: valueOrNull(activityProfile.runtime_name),
    runtime_version: valueOrNull(activityProfile.runtime_version),
    model_hint: valueOrNull(activityProfile.model_hint),
  };
}

function emitQualityPrimaryGate(options) {
  const { runId, phase, artifact, artifactRef, schemaRef, desiredStatus, gateStatuses, root } =
    options;
  const gate = runQualityGate(stageGateInput({ phase, artifact, artifactRef, schemaRef }));
  const stageStatus = worstStatus(gate.status, desiredStatus, ...gateStatuses);
  return emitGate({
    runId,
    phase,
    gateId: `${phase}-gate`,
    status: stageStatus,
    artifactRef: artifactRef || gate.artifact_ref,
    criteria: gate.criteria,
    blockingFailures: stageStatus === "fail" ? gate.blocking_failures : [],
    schemaValidation: gate.schema_validation,
    metadata: primaryGateMetadata(options),
    gateFileOverride: gateFileNameForPhase(phase),
    root,
  });
}

function emitPlainPrimaryGate(options) {
  const { runId, phase, artifactRef, desiredStatus, gateStatuses, root } = options;
  const stageStatus = worstStatus(desiredStatus, ...gateStatuses);
  return emitGate({
    runId,
    phase,
    gateId: `${phase}-gate`,
    status: stageStatus,
    artifactRef: artifactRef || "n/a",
    criteria: [],
    blockingFailures: stageStatus === "fail" ? ["phase-status"] : [],
    metadata: primaryGateMetadata(options),
    gateFileOverride: gateFileNameForPhase(phase),
    root,
  });
}

export function emitPrimaryGate(options) {
  if (options.artifact && options.schemaRef && QUALITY_GATE_PHASES.has(options.phase)) {
    return emitQualityPrimaryGate(options);
  }
  return emitPlainPrimaryGate(options);
}

export function recordPhaseCompletion({ runId, phase, state, primaryGate, root }) {
  appendTraceEvent(
    runId,
    {
      event: "phase_end",
      phase,
      status: primaryGate.status === "fail" ? "error" : "ok",
      metadata: {
        gate_status: primaryGate.status,
      },
    },
    root,
  );

  const isTerminalPhase = PHASE_ORDER[PHASE_ORDER.length - 1] === phase;
  state.current_phase = phase;
  if (primaryGate.status !== "fail") {
    const completed = Array.isArray(state.completed_gates) ? state.completed_gates : [];
    completed.push(primaryGate.gate_id);
    state.completed_gates = [...new Set(completed)];
  }
  if (primaryGate.status !== "fail" && isTerminalPhase) {
    appendRunEndIfMissing(runId, state, root);
  }

  if (primaryGate.status === "fail") {
    appendTraceEvent(
      runId,
      {
        event: "error",
        phase,
        status: "error",
        message: `${phase} gate failed`,
        gate_id: primaryGate.gate_id,
      },
      root,
    );
    process.exitCode = 1;
  }
}
