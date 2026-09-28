/**
 * Builds requirement coverage evidence and evaluates must-traceability gate inputs.
 */
import { existsSync, readFileSync } from "node:fs";
import { SKILL_ENTRYPOINTS } from "./constants.js";
import { getRepoRoot, resolveWithinRepo, toWorkspaceRelative } from "./state.js";
import { badInput } from "../primitives/errors.js";
import { spawnSkillTool } from "./subprocess.js";
import { repositoryRoot } from "../primitives/installation-paths.js";
import {
  buildCoverageResult,
  extractDesignRequirementIds,
  extractDriftRequirementIds,
  extractMustRequirementIds,
  extractPlanTaskRequirementIds,
  extractPlanTestRequirementIds,
  normalizeTraceabilityInput,
  uniqueSortedStrings,
  type CoverageResult,
  type NormalizedTraceability,
} from "./traceability-coverage.js";

export { buildCoverageResult, buildRequirementCoverageLedger } from "./traceability-coverage.js";

const REQUIRED_BY_PHASE = {
  plan: ["must-covered-by-plan-tasks", "must-covered-by-plan-tests"],
  build: [
    "must-covered-by-plan-tasks",
    "must-covered-by-plan-tests",
    "must-covered-by-drift-claims",
  ],
};

interface QualityGateResult extends Record<string, unknown> {
  schema_validation: { valid: boolean; errors: string[]; [key: string]: unknown };
}
interface OptionalArtifact {
  exists: boolean;
  data: unknown;
  rel: string | null;
}
interface RequiredArtifact {
  path: string;
  data: unknown;
}
interface TraceabilityArtifacts {
  brief: RequiredArtifact;
  plan: RequiredArtifact;
  drift: OptionalArtifact;
  design: OptionalArtifact;
}
interface TraceabilityRefs extends Record<string, unknown> {
  brief_ref: string;
  plan_ref: string;
  drift_ref: string | null;
  design_ref: string | null;
}
interface PublicCoverageCriterion {
  name: string;
  passed: boolean;
  evidence: string;
  missing_ids: string[];
}
export interface MustTraceabilityResult {
  gate: {
    gate_id: string;
    phase: string;
    status: "pass" | "warn" | "fail";
    criteria: Array<{ name: string; passed: boolean; evidence: string }>;
    blocking_failures: string[];
    artifact_ref: string;
    schema_validation: { valid: boolean; errors: string[]; [key: string]: unknown };
  };
  normalized: NormalizedTraceability;
  required_failures: string[];
  warning_failures: string[];
  missing_by_criterion: Record<string, string[]>;
  missing_requirement_ids: string[];
  refs: TraceabilityRefs;
}

function runQualityGate(input: Record<string, unknown>, root: string): QualityGateResult {
  return spawnSkillTool<QualityGateResult>({
    entrypoint: SKILL_ENTRYPOINTS.quality_gate,
    input,
    root,
    toolName: "quality-gate",
  });
}

function loadOptionalJson(ref: string | null | undefined, root: string): OptionalArtifact {
  if (!ref) {
    return { exists: false, data: null, rel: null };
  }
  const abs = resolveWithinRepo(ref, root);
  if (!existsSync(abs)) {
    return { exists: false, data: null, rel: toWorkspaceRelative(abs, root) };
  }
  try {
    return {
      exists: true,
      data: JSON.parse(readFileSync(abs, "utf8")),
      rel: toWorkspaceRelative(abs, root),
    };
  } catch (err) {
    throw badInput(
      `Failed to parse JSON from ${ref}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseRequiredCriteria(phase: string): readonly string[] {
  return REQUIRED_BY_PHASE[phase as keyof typeof REQUIRED_BY_PHASE] ?? REQUIRED_BY_PHASE.plan;
}

function traceabilityStatus(
  enforce: boolean,
  schemaInvalid: boolean,
  requiredFailures: string[],
  warningFailures: string[],
): "pass" | "warn" | "fail" {
  const hasRequiredFailure = schemaInvalid || requiredFailures.length > 0;
  const hasWarningFailure = warningFailures.length > 0;
  if (!enforce) return hasRequiredFailure || hasWarningFailure ? "warn" : "pass";
  if (hasRequiredFailure) return "fail";
  return hasWarningFailure ? "warn" : "pass";
}

function loadRequiredArtifact(ref: string, label: string, root: string): RequiredArtifact {
  const path = resolveWithinRepo(ref, root);
  if (!existsSync(path)) throw badInput(`${label} artifact not found: ${ref}`);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function loadTraceabilityArtifacts(
  {
    briefRef,
    planRef,
    driftRef,
    designRef,
  }: {
    briefRef: string;
    planRef: string;
    driftRef?: string | null;
    designRef?: string | null;
  },
  root: string,
): TraceabilityArtifacts {
  const brief = loadRequiredArtifact(briefRef, "brief", root);
  const plan = loadRequiredArtifact(planRef, "plan", root);
  return {
    brief,
    plan,
    drift: loadOptionalJson(driftRef, root),
    design: loadOptionalJson(designRef, root),
  };
}

function traceabilityRefs(artifacts: TraceabilityArtifacts, root: string): TraceabilityRefs {
  return {
    brief_ref: toWorkspaceRelative(artifacts.brief.path, root),
    plan_ref: toWorkspaceRelative(artifacts.plan.path, root),
    drift_ref: artifacts.drift.rel,
    design_ref: artifacts.design.rel,
  };
}

function normalizedTraceability(
  artifacts: TraceabilityArtifacts,
  refs: TraceabilityRefs,
): NormalizedTraceability {
  return normalizeTraceabilityInput({
    mustRequirementIds: extractMustRequirementIds(artifacts.brief.data),
    planTaskRequirementIds: extractPlanTaskRequirementIds(artifacts.plan.data),
    planTestRequirementIds: extractPlanTestRequirementIds(artifacts.plan.data),
    driftRequirementIds: extractDriftRequirementIds(artifacts.drift.data),
    designRequirementIds: extractDesignRequirementIds(artifacts.design.data),
    refs,
  });
}

function publicCoverageCriterion(entry: CoverageResult): PublicCoverageCriterion {
  const suffix = entry.evidence_suffix;
  return {
    name: entry.name,
    passed: entry.passed,
    evidence:
      typeof suffix === "string" && suffix.length > 0
        ? `${entry.evidence}${suffix}`
        : entry.evidence,
    missing_ids: entry.missing_ids,
  };
}

function buildTraceabilityCriteria(
  normalized: NormalizedTraceability,
  artifacts: TraceabilityArtifacts,
): PublicCoverageCriterion[] {
  return [
    buildCoverageResult(
      "must-covered-by-plan-tasks",
      normalized.must_requirement_ids,
      normalized.plan_task_requirement_ids,
    ),
    buildCoverageResult(
      "must-covered-by-plan-tests",
      normalized.must_requirement_ids,
      normalized.plan_test_requirement_ids,
    ),
    buildCoverageResult(
      "must-covered-by-drift-claims",
      normalized.must_requirement_ids,
      normalized.drift_requirement_ids,
      { evidence_suffix: artifacts.drift.exists ? undefined : " (drift artifact missing)" },
    ),
    buildCoverageResult(
      "must-covered-by-design",
      normalized.must_requirement_ids,
      normalized.design_requirement_ids,
      { evidence_suffix: artifacts.design.exists ? undefined : " (design artifact missing)" },
    ),
  ].map(publicCoverageCriterion);
}

function traceabilityFailures(
  criteria: PublicCoverageCriterion[],
  phase: string,
): { required: string[]; warnings: string[] } {
  const requiredCriteria = new Set(parseRequiredCriteria(phase));
  const failed = criteria.filter((criterion) => !criterion.passed);
  return {
    required: failed
      .filter((criterion) => requiredCriteria.has(criterion.name))
      .map((item) => item.name),
    warnings: failed
      .filter((criterion) => !requiredCriteria.has(criterion.name))
      .map((item) => item.name),
  };
}

function missingTraceability(criteria: PublicCoverageCriterion[]): {
  byCriterion: Record<string, string[]>;
  requirementIds: string[];
} {
  const byCriterion = Object.fromEntries(
    criteria
      .filter((criterion) => criterion.missing_ids.length > 0)
      .map((criterion) => [criterion.name, [...criterion.missing_ids].sort()]),
  );
  return {
    byCriterion,
    requirementIds: uniqueSortedStrings(Object.values(byCriterion).flat()),
  };
}

export function evaluateMustTraceability({
  phase,
  enforce,
  briefRef,
  planRef,
  driftRef,
  designRef,
}: {
  phase: string;
  enforce: boolean;
  briefRef: string;
  planRef: string;
  driftRef?: string | null;
  designRef?: string | null;
}): MustTraceabilityResult {
  const workspaceRoot = getRepoRoot();
  const artifacts = loadTraceabilityArtifacts(
    { briefRef, planRef, driftRef, designRef },
    workspaceRoot,
  );
  const refs = traceabilityRefs(artifacts, workspaceRoot);
  const normalized = normalizedTraceability(artifacts, refs);

  const schemaGate = runQualityGate(
    {
      artifact: normalized,
      artifact_ref: refs.plan_ref,
      schema_ref: "packages/contracts/v1/schemas/artifacts/traceability-check.schema.json",
      phase,
      criteria: [],
    },
    repositoryRoot,
  );

  const criteria = buildTraceabilityCriteria(normalized, artifacts);
  const failures = traceabilityFailures(criteria, phase);
  const schemaInvalid = !schemaGate.schema_validation.valid;
  const status = traceabilityStatus(enforce, schemaInvalid, failures.required, failures.warnings);

  const blockingFailures =
    enforce && status === "fail"
      ? [...(schemaInvalid ? ["traceability-schema-valid"] : []), ...failures.required]
      : [];
  const missing = missingTraceability(criteria);

  return {
    gate: {
      gate_id: `${phase}-traceability-gate`,
      phase,
      status,
      criteria: criteria.map(({ name, passed, evidence }) => ({ name, passed, evidence })),
      blocking_failures: blockingFailures,
      artifact_ref: refs.plan_ref,
      schema_validation: schemaGate.schema_validation,
    },
    normalized,
    required_failures: failures.required,
    warning_failures: failures.warnings,
    missing_by_criterion: missing.byCriterion,
    missing_requirement_ids: missing.requirementIds,
    refs,
  };
}
