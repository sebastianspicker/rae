/**
 * Gate evaluation, emission, and quality-gate subprocess runner.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_ENTRYPOINTS } from "../../lib/constants.mjs";
import { badInput } from "./errors.mjs";
import { spawnSkillTool } from "./subprocess.mjs";
import {
  gateFileNameForPhase,
  getRunDir,
  getRepoRoot,
  parseBooleanFlag,
  phaseToArtifactKey,
  readJson,
  resolveWithinDirectory,
  toWorkspaceRelative,
  writeJson,
} from "./state.mjs";
import { appendTraceEvent, nowIso, readTraceEvents } from "./trace.mjs";
import { evaluateMustTraceability } from "./traceability.mjs";

export const QUALITY_GATE_PHASES = new Set([
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "release-readiness",
]);

const GATE_STATUS_SET = new Set(["pass", "warn", "fail"]);
const GATE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export function gateStatusRank(status) {
  if (status === "fail") return 3;
  if (status === "warn") return 2;
  if (status === "pass") return 1;
  throw badInput(`unrecognized gate status: ${status}`);
}

export function assertGateStatus(status, source = "status") {
  if (!GATE_STATUS_SET.has(status)) {
    throw badInput(`${source} must be one of: pass, warn, fail`);
  }
}

export function resolveGateOutputPath(runDir, gateFileName) {
  if (typeof gateFileName !== "string" || gateFileName.length === 0) {
    throw badInput("gate file name must be a non-empty string");
  }
  if (!GATE_FILE_PATTERN.test(gateFileName)) {
    throw badInput(`invalid gate file name: ${gateFileName}`);
  }
  return resolveWithinDirectory(resolve(runDir, "gates"), gateFileName, {
    baseLabel: "gates directory",
  });
}

export function worstStatus(...statuses) {
  return (
    [...statuses].filter(Boolean).sort((a, b) => gateStatusRank(b) - gateStatusRank(a))[0] ?? "pass"
  );
}

export function emitGate({
  runId,
  phase,
  gateId,
  status,
  artifactRef = "n/a",
  criteria = [],
  blockingFailures = [],
  metadata = {},
  gateFileOverride,
  schemaValidation,
  root = getRepoRoot(),
}) {
  assertGateStatus(status, "gate status");
  if (status !== "fail" && blockingFailures.length > 0) {
    throw badInput('blockingFailures must be empty when status is not "fail"');
  }
  const gate = {
    gate_id: gateId,
    phase,
    status,
    criteria,
    blocking_failures: blockingFailures,
    artifact_ref: artifactRef,
    schema_validation: schemaValidation ?? {
      valid: true,
      errors: [],
    },
    timestamp: nowIso(),
    metadata,
  };

  const runDir = getRunDir(runId, root);
  const gateFile = gateFileOverride || gateFileNameForPhase(phase);
  const gatePath = resolveGateOutputPath(runDir, gateFile);
  writeJson(gatePath, gate);

  appendTraceEvent(
    runId,
    {
      event: "gate_result",
      phase,
      gate_id: gateId,
      status,
      artifact_ref: artifactRef,
      metadata,
    },
    root,
  );

  return gate;
}

const ARRAY_ARTIFACT_KEYS = new Set(["drift_reports", "quality_reports"]);

export function updateStateAfterArtifact(state, phase, artifactRef) {
  const key = phaseToArtifactKey(phase);
  if (!key) return;

  state.artifacts ??= {};

  if (ARRAY_ARTIFACT_KEYS.has(key)) {
    state.artifacts[key] = Array.isArray(state.artifacts[key])
      ? [...state.artifacts[key], artifactRef]
      : [artifactRef];
    return;
  }

  state.artifacts[key] = artifactRef;
}

export function readPhaseGate(runId, phase, root = getRepoRoot()) {
  const gatePath = resolve(getRunDir(runId, root), "gates", gateFileNameForPhase(phase));
  return readJson(gatePath, null);
}

export function emitRetryEventIfNeeded(runId, phase, root = getRepoRoot()) {
  const previousGate = readPhaseGate(runId, phase, root);
  if (!previousGate || previousGate.status !== "fail") {
    return null;
  }

  const retryCount =
    readTraceEvents(runId, root).filter((event) => event.event === "retry" && event.phase === phase)
      .length + 1;

  return appendTraceEvent(
    runId,
    {
      event: "retry",
      phase,
      status: "retry",
      gate_id: previousGate.gate_id,
      metadata: {
        retry_count: retryCount,
        previous_gate_id: previousGate.gate_id,
        previous_status: previousGate.status,
      },
    },
    root,
  );
}

export function runQualityGate(input) {
  return spawnSkillTool({
    entrypoint: SKILL_ENTRYPOINTS.quality_gate,
    input,
    toolName: "quality-gate",
  });
}

export function stageGateInput({ phase, artifact, artifactRef, schemaRef }) {
  const criteria = [];
  if (phase === "arm") {
    criteria.push({
      name: "requirements-present",
      type: "count-min",
      path: "requirements",
      value: 1,
    });
  }
  if (phase === "plan") {
    criteria.push({
      name: "task-groups-present",
      type: "count-min",
      path: "task_groups",
      value: 1,
    });
  }
  return {
    artifact,
    artifact_ref: artifactRef,
    schema_ref: schemaRef,
    phase,
    criteria,
  };
}

export function gateStatusFromPhaseAndProfile(_phase, stageProfile) {
  return typeof stageProfile.gate_status === "string" ? stageProfile.gate_status : "pass";
}

export function evaluateContextBudgetGate({
  runId,
  phase,
  artifact,
  artifactRef,
  schemaRef,
  state,
  budget,
  root = getRepoRoot(),
}) {
  if (!budget) return null;

  const flags = state?.config?.feature_flags ?? {};
  const enforce = parseBooleanFlag(flags.context_budget_v1);

  if (!artifact.context_manifest) {
    const status = enforce ? "fail" : "warn";
    return emitGate({
      runId,
      phase,
      gateId: `${phase}-context-budget-gate`,
      status,
      artifactRef,
      criteria: [
        {
          name: "context-manifest-present",
          passed: false,
          evidence: "context_manifest is missing",
        },
      ],
      blockingFailures: status === "fail" ? ["context-manifest-present"] : [],
      metadata: {
        gate_type: "context_budget",
        mode: enforce ? "enforce" : "shadow",
      },
      gateFileOverride: `${phase}-context-budget-gate.json`,
      root,
    });
  }

  const gateResult = runQualityGate({
    artifact: {
      context_manifest: artifact.context_manifest,
    },
    artifact_ref: artifactRef,
    schema_ref: "contracts/artifacts/context-manifest-gate.schema.json",
    phase,
    criteria: [
      {
        name: "context-files-max",
        type: "count-max",
        path: "context_manifest.files_loaded",
        value: budget.files_max,
      },
      {
        name: "context-token-max",
        type: "number-max",
        path: "context_manifest.token_estimate",
        value: budget.token_max,
      },
    ],
  });

  const mappedStatus = gateResult.status === "fail" && !enforce ? "warn" : gateResult.status;

  return emitGate({
    runId,
    phase,
    gateId: `${phase}-context-budget-gate`,
    status: mappedStatus,
    artifactRef,
    criteria: gateResult.criteria,
    blockingFailures: mappedStatus === "fail" ? gateResult.blocking_failures : [],
    schemaValidation: gateResult.schema_validation,
    metadata: {
      gate_type: "context_budget",
      mode: enforce ? "enforce" : "shadow",
      token_max: budget.token_max,
      files_max: budget.files_max,
      schema_ref: schemaRef,
    },
    gateFileOverride: `${phase}-context-budget-gate.json`,
    root,
  });
}

export function evaluateTraceabilityGate({
  runId,
  phase,
  state,
  resolveArtifactRef,
  resolveOptionalArtifactRef,
  root = getRepoRoot(),
}) {
  const flags = state?.config?.feature_flags ?? {};
  const enforce = parseBooleanFlag(flags.traceability_v1);

  // Plan/build traceability is only meaningful after brief and plan artifacts
  // exist. Missing inputs produce a gate artifact instead of a silent skip.
  const briefRef = state?.artifacts?.brief ?? "brief.json";
  const planRef = state?.artifacts?.plan ?? "plan.json";
  const designRef = state?.artifacts?.design ?? "design.json";
  const driftRef =
    Array.isArray(state?.artifacts?.drift_reports) && state.artifacts.drift_reports.length > 0
      ? state.artifacts.drift_reports[state.artifacts.drift_reports.length - 1]
      : null;
  const briefAbs = resolveArtifactRef(runId, briefRef);
  const planAbs = resolveArtifactRef(runId, planRef);
  const designAbs = resolveOptionalArtifactRef(runId, designRef);
  const driftAbs = resolveOptionalArtifactRef(runId, driftRef);

  if (!existsSync(briefAbs) || !existsSync(planAbs)) {
    return emitGate({
      runId,
      phase,
      gateId: `${phase}-traceability-gate`,
      status: enforce ? "fail" : "warn",
      artifactRef: `${toWorkspaceRelative(briefAbs)}|${toWorkspaceRelative(planAbs)}`,
      criteria: [
        {
          name: "traceability-inputs-present",
          passed: false,
          evidence: `brief_exists=${existsSync(briefAbs)} plan_exists=${existsSync(planAbs)}`,
        },
      ],
      blockingFailures: enforce ? ["traceability-inputs-present"] : [],
      metadata: {
        gate_type: "traceability",
        mode: enforce ? "enforce" : "shadow",
      },
      gateFileOverride: `${phase}-traceability-gate.json`,
      root,
    });
  }

  for (const absPath of [briefAbs, planAbs, designAbs, driftAbs]) {
    if (absPath && existsSync(absPath)) {
      appendTraceEvent(
        runId,
        {
          event: "artifact_read",
          phase,
          artifact_ref: toWorkspaceRelative(absPath, root),
          status: "ok",
        },
        root,
      );
    }
  }

  const outcome = evaluateMustTraceability({
    phase,
    enforce,
    briefRef: toWorkspaceRelative(briefAbs, root),
    planRef: toWorkspaceRelative(planAbs, root),
    designRef: designAbs ? toWorkspaceRelative(designAbs, root) : null,
    driftRef: driftAbs ? toWorkspaceRelative(driftAbs, root) : null,
  });

  return emitGate({
    runId,
    phase,
    gateId: `${phase}-traceability-gate`,
    status: outcome.gate.status,
    artifactRef: outcome.gate.artifact_ref,
    criteria: outcome.gate.criteria,
    blockingFailures: outcome.gate.status === "fail" ? outcome.gate.blocking_failures : [],
    schemaValidation: outcome.gate.schema_validation,
    metadata: {
      gate_type: "traceability",
      mode: enforce ? "enforce" : "shadow",
      required_hops:
        phase === "build"
          ? ["plan-tasks", "plan-tests", "drift-claims"]
          : ["plan-tasks", "plan-tests"],
      warning_hops: ["design"],
      required_failures: outcome.required_failures,
      warning_failures: outcome.warning_failures,
      missing_by_criterion: outcome.missing_by_criterion,
      missing_requirement_ids: outcome.missing_requirement_ids,
      refs: outcome.refs,
    },
    gateFileOverride: `${phase}-traceability-gate.json`,
    root,
  });
}
