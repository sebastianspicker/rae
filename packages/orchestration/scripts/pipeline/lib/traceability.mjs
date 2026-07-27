/**
 * Builds requirement coverage evidence and evaluates must-traceability gate inputs.
 */
import { existsSync, readFileSync } from "node:fs";
import { SKILL_ENTRYPOINTS } from "../../lib/constants.mjs";
import { getPackageRoot, getRepoRoot, resolveWithinRepo, toWorkspaceRelative } from "./state.mjs";
import { badInput } from "./errors.mjs";
import { spawnSkillTool } from "./subprocess.mjs";

const REQUIRED_BY_PHASE = {
  plan: ["must-covered-by-plan-tasks", "must-covered-by-plan-tests"],
  build: [
    "must-covered-by-plan-tasks",
    "must-covered-by-plan-tests",
    "must-covered-by-drift-claims",
  ],
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSortedStrings(values) {
  return [
    ...new Set(values.filter((value) => typeof value === "string" && value.length > 0)),
  ].sort();
}

function collectIdsFromList(entries, key) {
  const out = [];
  for (const entry of asArray(entries)) {
    const ids = asArray(entry?.[key]);
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
  return out;
}

function extractMustRequirementIds(brief) {
  return uniqueSortedStrings(
    asArray(brief?.requirements)
      .filter((req) => req?.priority === "must")
      .map((req) => req?.id),
  );
}

function extractPlanTaskRequirementIds(plan) {
  const taskGroups = asArray(plan?.task_groups);
  const ids = [];
  for (const group of taskGroups) {
    const tasks = asArray(group?.tasks);
    for (const task of tasks) {
      ids.push(...collectIdsFromList([task], "covers_requirement_ids"));
    }
  }
  return uniqueSortedStrings(ids);
}

function extractPlanTestRequirementIds(plan) {
  const taskGroups = asArray(plan?.task_groups);
  const ids = [];
  for (const group of taskGroups) {
    const tasks = asArray(group?.tasks);
    for (const task of tasks) {
      ids.push(...collectIdsFromList(asArray(task?.test_cases), "covers_requirement_ids"));
    }
  }
  return uniqueSortedStrings(ids);
}

function planTasks(plan) {
  return asArray(plan?.task_groups).flatMap((group) => asArray(group?.tasks));
}

function entryIdentifier(entry, keys) {
  for (const key of keys) {
    const value = entry?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function addMappedValues(mapping, keys, values) {
  for (const key of asArray(keys)) {
    if (typeof key !== "string" || key.length === 0) continue;
    const existing = mapping.get(key) ?? [];
    existing.push(...values);
    mapping.set(key, existing);
  }
}

function collectPlanTaskIdsByRequirement(plan) {
  const mapping = new Map();
  for (const task of planTasks(plan)) {
    const taskId = entryIdentifier(task, ["id"]);
    if (!taskId) continue;
    addMappedValues(mapping, task?.covers_requirement_ids, [taskId]);
  }
  return mapping;
}

function collectPlanTestCasesByRequirement(plan) {
  const mapping = new Map();
  for (const task of planTasks(plan)) {
    for (const testCase of asArray(task?.test_cases)) {
      const testCaseName = entryIdentifier(testCase, ["name", "trace_id"]);
      if (!testCaseName) continue;
      addMappedValues(mapping, testCase?.covers_requirement_ids, [testCaseName]);
    }
  }
  return mapping;
}

function collectAcceptanceCriteriaByRequirement(plan) {
  const mapping = new Map();
  const taskGroups = asArray(plan?.task_groups);
  for (const group of taskGroups) {
    const tasks = asArray(group?.tasks);
    for (const task of tasks) {
      const acceptanceCriteria = uniqueSortedStrings(asArray(task?.acceptance_criteria));
      for (const requirementId of asArray(task?.covers_requirement_ids)) {
        if (typeof requirementId !== "string" || requirementId.length === 0) continue;
        const existing = mapping.get(requirementId) ?? [];
        existing.push(...acceptanceCriteria);
        mapping.set(requirementId, existing);
      }
    }
  }
  return mapping;
}

function extractDriftRequirementIds(drift) {
  return uniqueSortedStrings(collectIdsFromList(asArray(drift?.claims), "covers_requirement_ids"));
}

function extractDesignRequirementIds(design) {
  return uniqueSortedStrings(
    collectIdsFromList(asArray(design?.constraints_classification), "covers_requirement_ids"),
  );
}

export function buildCoverageResult(name, sourceIds, targetIds, extra = {}) {
  const source = uniqueSortedStrings(sourceIds);
  const target = new Set(uniqueSortedStrings(targetIds));

  if (source.length === 0) {
    return {
      name,
      passed: false,
      evidence: "coverage=0.0000 threshold=1.0000 matched=0/0 missing=none",
      missing_ids: [],
      ...extra,
    };
  }

  const matched = source.filter((id) => target.has(id));
  const missing = source.filter((id) => !target.has(id)).sort();
  const coverage = matched.length / source.length;

  return {
    name,
    passed: missing.length === 0,
    evidence: `coverage=${coverage.toFixed(4)} threshold=1.0000 matched=${matched.length}/${source.length} missing=${missing.join(", ") || "none"}`,
    missing_ids: missing,
    ...extra,
  };
}

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

function normalizeTraceabilityInput({
  mustRequirementIds,
  planTaskRequirementIds,
  planTestRequirementIds,
  driftRequirementIds,
  designRequirementIds,
  refs,
}) {
  const sources = {};
  if (typeof refs.brief_ref === "string" && refs.brief_ref.length > 0) {
    sources.brief_ref = refs.brief_ref;
  }
  if (typeof refs.plan_ref === "string" && refs.plan_ref.length > 0) {
    sources.plan_ref = refs.plan_ref;
  }
  if (typeof refs.drift_ref === "string" && refs.drift_ref.length > 0) {
    sources.drift_ref = refs.drift_ref;
  }
  if (typeof refs.design_ref === "string" && refs.design_ref.length > 0) {
    sources.design_ref = refs.design_ref;
  }

  return {
    must_requirement_ids: uniqueSortedStrings(mustRequirementIds),
    plan_task_requirement_ids: uniqueSortedStrings(planTaskRequirementIds),
    plan_test_requirement_ids: uniqueSortedStrings(planTestRequirementIds),
    drift_requirement_ids: uniqueSortedStrings(driftRequirementIds),
    design_requirement_ids: uniqueSortedStrings(designRequirementIds),
    sources,
  };
}

function parseRequiredCriteria(phase) {
  return REQUIRED_BY_PHASE[phase] ?? REQUIRED_BY_PHASE.plan;
}

function missingCoverage(values, marker) {
  return values.length > 0 ? [] : [marker];
}

function coverageStatus(plannedTaskIds, plannedTestCases) {
  const hasTasks = plannedTaskIds.length > 0;
  const hasTests = plannedTestCases.length > 0;
  if (hasTasks && hasTests) return "covered";
  if (hasTasks || hasTests) return "partial";
  return "missing";
}

function buildRequirementCoverageEntry(requirementId, taskMap, testMap, acceptanceMap) {
  const plannedTaskIds = uniqueSortedStrings(taskMap.get(requirementId) ?? []);
  const plannedTestCases = uniqueSortedStrings(testMap.get(requirementId) ?? []);
  const acceptanceCriteria = uniqueSortedStrings(acceptanceMap.get(requirementId) ?? []);
  return {
    requirement_id: requirementId,
    planned_task_ids: plannedTaskIds,
    planned_test_cases: plannedTestCases,
    acceptance_criteria: acceptanceCriteria,
    missing_task_ids: missingCoverage(plannedTaskIds, "unplanned-task-coverage"),
    missing_test_cases: missingCoverage(plannedTestCases, "unplanned-test-coverage"),
    status: coverageStatus(plannedTaskIds, plannedTestCases),
  };
}

export function buildRequirementCoverageLedger({ brief, plan }) {
  const mustRequirementIds = extractMustRequirementIds(brief);
  const taskMap = collectPlanTaskIdsByRequirement(plan);
  const testMap = collectPlanTestCasesByRequirement(plan);
  const acceptanceMap = collectAcceptanceCriteriaByRequirement(plan);

  const requirements = mustRequirementIds.map((requirementId) =>
    buildRequirementCoverageEntry(requirementId, taskMap, testMap, acceptanceMap),
  );

  const coveredRequirements = requirements
    .filter((entry) => entry.status === "covered")
    .map((entry) => entry.requirement_id);
  const partialRequirements = requirements.filter((entry) => entry.status === "partial").length;
  const missingRequirementIds = requirements
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.requirement_id);

  return {
    coverage_scope: "must-requirements",
    requirements,
    summary: {
      total_requirements: requirements.length,
      covered_requirements: coveredRequirements.length,
      partial_requirements: partialRequirements,
      missing_requirements: missingRequirementIds.length,
    },
    qc_summary: {
      headline:
        requirements.length === 0
          ? "No MUST requirements were declared, so traceability cannot be satisfied."
          : missingRequirementIds.length === 0
            ? "All MUST requirements map to at least one planned task and planned test."
            : `Coverage gaps remain for ${missingRequirementIds.length} MUST requirement(s).`,
      coverage_status:
        requirements.length === 0
          ? "missing"
          : missingRequirementIds.length > 0
            ? "missing"
            : partialRequirements > 0
              ? "partial"
              : "complete",
      covered_requirements: coveredRequirements,
      missing_requirement_ids: missingRequirementIds,
    },
  };
}

function coverageEntry(requirementId, taskMap, testMap, acceptanceMap) {
  const plannedTaskIds = requirementCoverageValues(taskMap, requirementId);
  const plannedTestCases = requirementCoverageValues(testMap, requirementId);
  const status = coverageStatus(plannedTaskIds, plannedTestCases);
  return {
    requirement_id: requirementId,
    planned_task_ids: plannedTaskIds,
    planned_test_cases: plannedTestCases,
    acceptance_criteria: requirementCoverageValues(acceptanceMap, requirementId),
    missing_task_ids: missingCoverageValues(plannedTaskIds, "unplanned-task-coverage"),
    missing_test_cases: missingCoverageValues(plannedTestCases, "unplanned-test-coverage"),
    status,
  };
}

function requirementCoverageValues(coverageMap, requirementId) {
  return uniqueSortedStrings(coverageMap.get(requirementId) ?? []);
}

function missingCoverageValues(values, missingValue) {
  return values.length ? [] : [missingValue];
}

function coverageStatus(tasks, tests) {
  if (tasks.length && tests.length) return "covered";
  if (tasks.length || tests.length) return "partial";
  return "missing";
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
  const briefPath = resolveWithinRepo(briefRef, workspaceRoot);
  const planPath = resolveWithinRepo(planRef, workspaceRoot);

  if (!existsSync(briefPath)) {
    throw badInput(`brief artifact not found: ${briefRef}`);
  }
  if (!existsSync(planPath)) {
    throw badInput(`plan artifact not found: ${planRef}`);
  }

  const brief = JSON.parse(readFileSync(briefPath, "utf8"));
  const executionPlan = JSON.parse(readFileSync(planPath, "utf8"));
  const drift = loadOptionalJson(driftRef, workspaceRoot);
  const design = loadOptionalJson(designRef, workspaceRoot);

  const normalized = normalizeTraceabilityInput({
    mustRequirementIds: extractMustRequirementIds(brief),
    planTaskRequirementIds: extractPlanTaskRequirementIds(executionPlan),
    planTestRequirementIds: extractPlanTestRequirementIds(executionPlan),
    driftRequirementIds: extractDriftRequirementIds(drift.data),
    designRequirementIds: extractDesignRequirementIds(design.data),
    refs: {
      brief_ref: toWorkspaceRelative(briefPath, workspaceRoot),
      plan_ref: toWorkspaceRelative(planPath, workspaceRoot),
      drift_ref: drift.rel,
      design_ref: design.rel,
    },
  });

  const schemaGate = runQualityGate(
    {
      artifact: normalized,
      artifact_ref: toWorkspaceRelative(planPath, workspaceRoot),
      schema_ref: "contracts/artifacts/traceability-check.schema.json",
      phase,
      criteria: [],
    },
    packageRoot,
  );

  const criteria = [
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
      {
        evidence_suffix: drift.exists ? undefined : " (drift artifact missing)",
      },
    ),
    buildCoverageResult(
      "must-covered-by-design",
      normalized.must_requirement_ids,
      normalized.design_requirement_ids,
      {
        evidence_suffix: design.exists ? undefined : " (design artifact missing)",
      },
    ),
  ].map((entry) => ({
    name: entry.name,
    passed: entry.passed,
    evidence:
      typeof entry.evidence_suffix === "string" && entry.evidence_suffix.length > 0
        ? `${entry.evidence}${entry.evidence_suffix}`
        : entry.evidence,
    missing_ids: entry.missing_ids,
  }));

  const requiredCriteria = new Set(parseRequiredCriteria(phase));
  const requiredFailures = criteria
    .filter((criterion) => requiredCriteria.has(criterion.name) && !criterion.passed)
    .map((criterion) => criterion.name);

  const warningFailures = criteria
    .filter((criterion) => !requiredCriteria.has(criterion.name) && !criterion.passed)
    .map((criterion) => criterion.name);

  const schemaInvalid = !schemaGate.schema_validation.valid;

  let status = "pass";
  if (enforce) {
    if (schemaInvalid || requiredFailures.length > 0) status = "fail";
    else if (warningFailures.length > 0) status = "warn";
  } else {
    if (schemaInvalid || requiredFailures.length > 0 || warningFailures.length > 0) status = "warn";
  }

  const blockingFailures =
    enforce && status === "fail"
      ? [...(schemaInvalid ? ["traceability-schema-valid"] : []), ...requiredFailures]
      : [];

  const missingByCriterion = criteria
    .filter((criterion) => criterion.missing_ids.length > 0)
    .reduce((acc, criterion) => {
      acc[criterion.name] = [...criterion.missing_ids].sort();
      return acc;
    }, {});

  const missingRequirementIds = uniqueSortedStrings(
    Object.values(missingByCriterion)
      .flat()
      .filter((id) => typeof id === "string"),
  );

  return {
    gate: {
      gate_id: `${phase}-traceability-gate`,
      phase,
      status,
      criteria: criteria.map(({ name, passed, evidence }) => ({ name, passed, evidence })),
      blocking_failures: blockingFailures,
      artifact_ref: toWorkspaceRelative(planPath, workspaceRoot),
      schema_validation: schemaGate.schema_validation,
    },
    normalized,
    required_failures: requiredFailures,
    warning_failures: warningFailures,
    missing_by_criterion: missingByCriterion,
    missing_requirement_ids: missingRequirementIds,
    refs: {
      brief_ref: toWorkspaceRelative(briefPath, workspaceRoot),
      plan_ref: toWorkspaceRelative(planPath, workspaceRoot),
      drift_ref: drift.rel,
      design_ref: design.rel,
    },
  };
}
