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

export function appendRunEndIfMissing(runId, state, root = getRepoRoot()) {
  ensureTraceFile(runId, root);
  if (!hasEvent(runId, "run_end", root)) {
    appendTraceEvent(
      runId,
      {
        event: "run_end",
        phase: state?.current_phase ?? "release-readiness",
        status: "ok",
        metadata: {
          source: "runner",
        },
      },
      root,
    );
  }
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
  let wroteArtifact = false;

  if (artifactRef) {
    const artifactAbs = resolveArtifactRefForRun(runId, artifactRef, root);
    const budget = contextBudgetForPhase(phaseTokenForContextBudget(phase), state);

    if (options["input-artifact"]) {
      // Preserve caller-supplied artifacts exactly; the runner adds evidence
      // events and gate results around them instead of rewriting their content.
      const inputAbs = resolveWithinRepo(options["input-artifact"], root);
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
      artifact = readJsonStrict(inputAbs, `input artifact ${options["input-artifact"]}`);
      writeJson(artifactAbs, artifact);
      wroteArtifact = true;
    } else {
      artifact = buildArtifactForPhase({
        phase,
        runId,
        configId,
        task: taskContext?.task,
        stageProfile,
        budget,
      });
      if (artifact) {
        const coverageLedger = resolveQualityCoverageLedger(runId, state, phase, root);
        if (coverageLedger) {
          artifact = {
            ...artifact,
            coverage_ledger: {
              coverage_scope: coverageLedger.coverage_scope,
              requirements: coverageLedger.requirements,
              summary: coverageLedger.summary,
            },
            qc_summary: coverageLedger.qc_summary,
          };
        }
        const reviewLoopSnapshot = resolveReviewLoopSnapshot(runId, phase, root);
        if (reviewLoopSnapshot) {
          artifact = {
            ...artifact,
            ...reviewLoopSnapshot,
          };
        }
        writeJson(artifactAbs, artifact);
        wroteArtifact = true;
      } else if (existsSync(artifactAbs)) {
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
        artifact = readJsonStrict(artifactAbs, `artifact ${artifactRef}`);
      }
    }

    if (wroteArtifact) {
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

    artifactRef = toWorkspaceRelative(artifactAbs, root);
    if (artifact) {
      updateStateAfterArtifact(state, phase, artifactRef);
    }
  }

  return { artifact, artifactRef, schemaRef };
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
  const budget = contextBudgetForPhase(phaseTokenForContextBudget(phase), state);
  if (artifact && budget) {
    const budgetGate = evaluateContextBudgetGate({
      runId,
      phase,
      artifact,
      artifactRef: artifactRef || "n/a",
      schemaRef,
      state,
      budget,
      root,
    });
    if (budgetGate) {
      gateStatuses.push(budgetGate.status);
      extraGates.push(budgetGate);
    }
  }

  if (phase === "plan" || phase === "build") {
    const traceabilityGate = evaluateTraceabilityGate({
      runId,
      phase,
      state,
      resolveArtifactRef: (nextRunId, artifactPath) =>
        resolveArtifactRefForRun(nextRunId, artifactPath, root),
      resolveOptionalArtifactRef: (nextRunId, artifactPath) =>
        resolveOptionalArtifactRefForRun(nextRunId, artifactPath, root),
      root,
    });
    if (traceabilityGate) {
      if (traceabilityGate.status === "fail") {
        gateStatuses.push(traceabilityGate.status);
      }
      extraGates.push(traceabilityGate);
    }
  }

  return { gateStatuses, extraGates };
}

export function emitPrimaryGate(context) {
  const { artifact, schemaRef, phase } = context;
  if (artifact && schemaRef && QUALITY_GATE_PHASES.has(phase)) {
    return emitValidatedGate(context);
  }
  return emitStatusGate(context);
}

function emitValidatedGate(context) {
  const gate = runQualityGate(stageGateInput(context));
  const status = worstStatus(gate.status, context.desiredStatus, ...context.gateStatuses);
  return emitGate({
    ...baseGate(context, status),
    artifactRef: context.artifactRef || gate.artifact_ref,
    criteria: gate.criteria,
    blockingFailures: status === "fail" ? gate.blocking_failures : [],
    schemaValidation: gate.schema_validation,
  });
}

function emitStatusGate(context) {
  const status = worstStatus(context.desiredStatus, ...context.gateStatuses);
  return emitGate({
    ...baseGate(context, status),
    artifactRef: context.artifactRef || "n/a",
    criteria: [],
    blockingFailures: status === "fail" ? ["phase-status"] : [],
  });
}

function baseGate(context, status) {
  const { runId, phase, schemaRef, configId, cognitiveTier, activityProfile, root } = context;
  return {
    runId,
    phase,
    gateId: `${phase}-gate`,
    status,
    metadata: {
      gate_type: "phase",
      schema_ref: schemaRef,
      config_id: configId,
      cognitive_tier: cognitiveTier,
      activity_id: activityProfile?.activity_id ?? null,
      runtime_name: activityProfile?.runtime_name ?? null,
      runtime_version: activityProfile?.runtime_version ?? null,
      model_hint: activityProfile?.model_hint ?? null,
    },
    gateFileOverride: gateFileNameForPhase(phase),
    root,
  };
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
  const completed = Array.isArray(state.completed_gates) ? state.completed_gates : [];
  completed.push(primaryGate.gate_id);
  state.completed_gates = [...new Set(completed)];
  if (primaryGate.status === "fail" || isTerminalPhase) {
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
