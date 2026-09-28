/**
 * Gate evaluation, emission, and quality-gate subprocess runner.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_ENTRYPOINTS } from "./constants.js";
import { badInput } from "../primitives/errors.js";
import { currentSchemaReference } from "../primitives/schema-reference.js";
import { spawnSkillTool } from "./subprocess.js";
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
} from "./state.js";
import { appendTraceEvent, nowIso, readTraceEvents } from "./trace.js";
import { evaluateMustTraceability } from "./traceability.js";
import { repositoryRoot } from "../primitives/installation-paths.js";
import type { AutonomousPhase, PhaseGateStatus } from "./autonomous-phase-contract.js";
import type { PipelineState } from "./state.js";

export interface GateCriterion extends Record<string, unknown> {
  name: string;
  passed?: boolean;
  evidence?: string;
  type?: string;
  path?: string;
  value?: number;
}

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

export interface EngineGate {
  gate_id: string;
  phase: string;
  status: PhaseGateStatus;
  criteria: GateCriterion[];
  blocking_failures: string[];
  artifact_ref: string;
  schema_validation: SchemaValidation;
  timestamp: string;
  metadata: Record<string, unknown>;
}

interface QualityGateResult {
  status: PhaseGateStatus;
  artifact_ref: string;
  criteria: GateCriterion[];
  blocking_failures: string[];
  schema_validation: SchemaValidation;
}

interface ContextBudget {
  token_max: number;
  files_max: number;
}

type ResolveArtifact = (runId: string, artifactRef: string) => string;
type ResolveOptionalArtifact = (runId: string, artifactRef: string | null) => string | null;
interface TraceabilityPaths {
  brief: string;
  plan: string;
  design: string | null;
  drift: string | null;
}

export const QUALITY_GATE_PHASES: ReadonlySet<string> = new Set([
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "release-readiness",
]);

const GATE_STATUS_SET: ReadonlySet<string> = new Set(["pass", "warn", "fail"]);
const GATE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export function gateStatusRank(status: PhaseGateStatus): number {
  if (status === "fail") return 3;
  if (status === "warn") return 2;
  if (status === "pass") return 1;
  throw badInput(`unrecognized gate status: ${status}`);
}

export function assertGateStatus(
  status: unknown,
  source = "status",
): asserts status is PhaseGateStatus {
  if (typeof status !== "string" || !GATE_STATUS_SET.has(status)) {
    throw badInput(`${source} must be one of: pass, warn, fail`);
  }
}

export function resolveGateOutputPath(runDir: string, gateFileName: string): string {
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

export function worstStatus(
  ...statuses: Array<PhaseGateStatus | null | undefined>
): PhaseGateStatus {
  return (
    statuses
      .filter((status): status is PhaseGateStatus => Boolean(status))
      .sort((a, b) => gateStatusRank(b) - gateStatusRank(a))[0] ?? "pass"
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
}: {
  runId: string;
  phase: string;
  gateId: string;
  status: PhaseGateStatus;
  artifactRef?: string;
  criteria?: GateCriterion[];
  blockingFailures?: string[];
  metadata?: Record<string, unknown>;
  gateFileOverride?: string;
  schemaValidation?: SchemaValidation;
  root?: string;
}): EngineGate {
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

export function updateStateAfterArtifact(
  state: PipelineState,
  phase: string,
  artifactRef: string,
): void {
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

export function readPhaseGate(
  runId: string,
  phase: string,
  root = getRepoRoot(),
): EngineGate | null {
  const gatePath = resolve(getRunDir(runId, root), "gates", gateFileNameForPhase(phase));
  return readJson(gatePath, null) as EngineGate | null;
}

export function emitRetryEventIfNeeded(
  runId: string,
  phase: string,
  root = getRepoRoot(),
): ReturnType<typeof appendTraceEvent> | null {
  const previousGate = readPhaseGate(runId, phase, root);
  if (previousGate?.status !== "fail") {
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

export function runQualityGate(
  input: Record<string, unknown> & { schema_ref: string },
): QualityGateResult {
  return spawnSkillTool<QualityGateResult>({
    entrypoint: SKILL_ENTRYPOINTS.quality_gate,
    input: { ...input, schema_ref: currentSchemaReference(input.schema_ref) },
    root: repositoryRoot,
    toolName: "quality-gate",
  });
}

export function stageGateInput({
  phase,
  artifact,
  artifactRef,
  schemaRef,
}: {
  phase: string;
  artifact: unknown;
  artifactRef: string;
  schemaRef: string;
}): Record<string, unknown> & { schema_ref: string } {
  const criteria: GateCriterion[] = [];
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
  if (phase === "quality-tests") {
    criteria.push({
      name: "must-requirements-covered",
      type: "number-max",
      path: "coverage_ledger.summary.missing_requirements",
      value: 0,
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

export function gateStatusFromPhaseAndProfile(
  _phase: string,
  stageProfile: Record<string, unknown>,
): PhaseGateStatus {
  const status = stageProfile.gate_status ?? "pass";
  assertGateStatus(status, "stage profile gate status");
  return status;
}

function emitMissingContextManifestGate({
  runId,
  phase,
  artifactRef,
  enforce,
  root,
}: {
  runId: string;
  phase: string;
  artifactRef: string;
  enforce: boolean;
  root: string;
}): EngineGate {
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

function contextBudgetGateInput(
  artifact: Record<string, unknown>,
  artifactRef: string,
  phase: string,
  budget: ContextBudget,
): Record<string, unknown> & { schema_ref: string } {
  return {
    artifact: { context_manifest: artifact.context_manifest },
    artifact_ref: artifactRef,
    schema_ref: "packages/contracts/v1/schemas/artifacts/context-manifest-gate.schema.json",
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
  };
}

/**
 * Evaluates context budgets deterministically so stage profiles cannot silently exceed their token policy.
 */
export function evaluateContextBudgetGate({
  runId,
  phase,
  artifact,
  artifactRef,
  schemaRef,
  state,
  budget,
  root = getRepoRoot(),
}: {
  runId: string;
  phase: string;
  artifact: Record<string, unknown>;
  artifactRef: string;
  schemaRef: string;
  state: PipelineState;
  budget: ContextBudget | null;
  root?: string;
}): EngineGate | null {
  if (!budget) return null;

  const flags = state?.config?.feature_flags ?? {};
  const enforce = parseBooleanFlag(flags.context_budget_v1);

  if (!artifact.context_manifest) {
    return emitMissingContextManifestGate({ runId, phase, artifactRef, enforce, root });
  }

  const gateResult = runQualityGate(contextBudgetGateInput(artifact, artifactRef, phase, budget));

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

function artifactReference(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function traceabilityArtifactPaths(
  runId: string,
  state: PipelineState,
  resolveArtifactRef: ResolveArtifact,
  resolveOptionalArtifactRef: ResolveOptionalArtifact,
): TraceabilityPaths {
  const briefRef = artifactReference(state.artifacts?.brief, "brief.json");
  const planRef = artifactReference(state.artifacts?.plan, "plan.json");
  const designRef = artifactReference(state.artifacts?.design, "design.json");
  const driftReports = state?.artifacts?.drift_reports;
  const driftRef =
    Array.isArray(driftReports) && driftReports.length > 0
      ? artifactReference(driftReports[driftReports.length - 1], "") || null
      : null;
  return {
    brief: resolveArtifactRef(runId, briefRef),
    plan: resolveArtifactRef(runId, planRef),
    design: resolveOptionalArtifactRef(runId, designRef),
    drift: resolveOptionalArtifactRef(runId, driftRef),
  };
}

function emitMissingTraceabilityInputs({
  runId,
  phase,
  paths,
  enforce,
  root,
}: {
  runId: string;
  phase: string;
  paths: TraceabilityPaths;
  enforce: boolean;
  root: string;
}): EngineGate {
  return emitGate({
    runId,
    phase,
    gateId: `${phase}-traceability-gate`,
    status: enforce ? "fail" : "warn",
    artifactRef: `${toWorkspaceRelative(paths.brief)}|${toWorkspaceRelative(paths.plan)}`,
    criteria: [
      {
        name: "traceability-inputs-present",
        passed: false,
        evidence: `brief_exists=${existsSync(paths.brief)} plan_exists=${existsSync(paths.plan)}`,
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

function recordTraceabilityArtifactReads(
  runId: string,
  phase: string,
  paths: TraceabilityPaths,
  root: string,
): void {
  for (const absPath of Object.values(paths)) {
    if (!absPath || !existsSync(absPath)) continue;
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

function traceabilityOutcome(
  phase: string,
  enforce: boolean,
  paths: TraceabilityPaths,
  root: string,
): ReturnType<typeof evaluateMustTraceability> {
  return evaluateMustTraceability({
    phase,
    enforce,
    briefRef: toWorkspaceRelative(paths.brief, root),
    planRef: toWorkspaceRelative(paths.plan, root),
    designRef: paths.design ? toWorkspaceRelative(paths.design, root) : null,
    driftRef: paths.drift ? toWorkspaceRelative(paths.drift, root) : null,
  });
}

/**
 * Builds a must-traceability result only from persisted artifacts and the configured quality-gate contract.
 */
export function evaluateTraceabilityGate({
  runId,
  phase,
  state,
  resolveArtifactRef,
  resolveOptionalArtifactRef,
  root = getRepoRoot(),
}: {
  runId: string;
  phase: string;
  state: PipelineState;
  resolveArtifactRef: ResolveArtifact;
  resolveOptionalArtifactRef: ResolveOptionalArtifact;
  root?: string;
}): EngineGate {
  const flags = state?.config?.feature_flags ?? {};
  const enforce = parseBooleanFlag(flags.traceability_v1);

  // Plan/build traceability is only meaningful after brief and plan artifacts
  // exist. Missing inputs produce a gate artifact instead of a silent skip.
  const paths = traceabilityArtifactPaths(
    runId,
    state,
    resolveArtifactRef,
    resolveOptionalArtifactRef,
  );
  if (!existsSync(paths.brief) || !existsSync(paths.plan)) {
    return emitMissingTraceabilityInputs({ runId, phase, paths, enforce, root });
  }

  recordTraceabilityArtifactReads(runId, phase, paths, root);
  const outcome = traceabilityOutcome(phase, enforce, paths, root);
  assertGateStatus(outcome.gate.status, "traceability gate status");

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
