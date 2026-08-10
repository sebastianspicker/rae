/**
 * Builds requirement coverage evidence and evaluates must-traceability gate inputs.
 */
import { existsSync, readFileSync } from "node:fs";
import { SKILL_ENTRYPOINTS } from "../../lib/constants.mjs";
import { getPackageRoot, getRepoRoot, resolveWithinRepo, toWorkspaceRelative } from "./state.mjs";
import { badInput } from "./errors.mjs";
import { spawnSkillTool } from "./subprocess.mjs";
import {
  buildCoverageResult,
  extractDesignRequirementIds,
  extractDriftRequirementIds,
  extractMustRequirementIds,
  extractPlanTaskRequirementIds,
  extractPlanTestRequirementIds,
  normalizeTraceabilityInput,
  uniqueSortedStrings,
} from "./traceability-coverage.mjs";

export { buildCoverageResult, buildRequirementCoverageLedger } from "./traceability-coverage.mjs";

const REQUIRED_BY_PHASE = {
  plan: ["must-covered-by-plan-tasks", "must-covered-by-plan-tests"],
  build: [
    "must-covered-by-plan-tasks",
    "must-covered-by-plan-tests",
    "must-covered-by-drift-claims",
  ],
};

function runQualityGate(input, root) {
  return spawnSkillTool({
    entrypoint: SKILL_ENTRYPOINTS.quality_gate,
    input,
    root,
    toolName: "quality-gate",
  });
}

function loadOptionalJson(ref, root) {
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
    throw badInput(`Failed to parse JSON from ${ref}: ${err.message}`);
  }
}

function parseRequiredCriteria(phase) {
  return REQUIRED_BY_PHASE[phase] ?? REQUIRED_BY_PHASE.plan;
}

function traceabilityStatus(enforce, schemaInvalid, requiredFailures, warningFailures) {
  const hasRequiredFailure = schemaInvalid || requiredFailures.length > 0;
  const hasWarningFailure = warningFailures.length > 0;
  if (!enforce) return hasRequiredFailure || hasWarningFailure ? "warn" : "pass";
  if (hasRequiredFailure) return "fail";
  return hasWarningFailure ? "warn" : "pass";
}

function loadRequiredArtifact(ref, label, root) {
  const path = resolveWithinRepo(ref, root);
  if (!existsSync(path)) throw badInput(`${label} artifact not found: ${ref}`);
  return { path, data: JSON.parse(readFileSync(path, "utf8")) };
}

function loadTraceabilityArtifacts({ briefRef, planRef, driftRef, designRef }, root) {
  const brief = loadRequiredArtifact(briefRef, "brief", root);
  const plan = loadRequiredArtifact(planRef, "plan", root);
  return {
    brief,
    plan,
    drift: loadOptionalJson(driftRef, root),
    design: loadOptionalJson(designRef, root),
  };
}

function traceabilityRefs(artifacts, root) {
  return {
    brief_ref: toWorkspaceRelative(artifacts.brief.path, root),
    plan_ref: toWorkspaceRelative(artifacts.plan.path, root),
    drift_ref: artifacts.drift.rel,
    design_ref: artifacts.design.rel,
  };
}

function normalizedTraceability(artifacts, refs) {
  return normalizeTraceabilityInput({
    mustRequirementIds: extractMustRequirementIds(artifacts.brief.data),
    planTaskRequirementIds: extractPlanTaskRequirementIds(artifacts.plan.data),
    planTestRequirementIds: extractPlanTestRequirementIds(artifacts.plan.data),
    driftRequirementIds: extractDriftRequirementIds(artifacts.drift.data),
    designRequirementIds: extractDesignRequirementIds(artifacts.design.data),
    refs,
  });
}

function publicCoverageCriterion(entry) {
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

function buildTraceabilityCriteria(normalized, artifacts) {
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

function traceabilityFailures(criteria, phase) {
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

function missingTraceability(criteria) {
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
}) {
  const workspaceRoot = getRepoRoot();
  const packageRoot = getPackageRoot();
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
      schema_ref: "contracts/artifacts/traceability-check.schema.json",
      phase,
      criteria: [],
    },
    packageRoot,
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
