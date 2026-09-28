/**
 * Normalizes requirement coverage and builds requirement coverage evidence.
 */
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
  for (const task of planTasks(plan)) {
    const acceptanceCriteria = uniqueSortedStrings(asArray(task?.acceptance_criteria));
    addMappedValues(mapping, task?.covers_requirement_ids, acceptanceCriteria);
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

function normalizedSourceRefs(refs) {
  return Object.fromEntries(
    Object.entries(refs).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

export function normalizeTraceabilityInput({
  mustRequirementIds,
  planTaskRequirementIds,
  planTestRequirementIds,
  driftRequirementIds,
  designRequirementIds,
  refs,
}) {
  return {
    must_requirement_ids: uniqueSortedStrings(mustRequirementIds),
    plan_task_requirement_ids: uniqueSortedStrings(planTaskRequirementIds),
    plan_test_requirement_ids: uniqueSortedStrings(planTestRequirementIds),
    drift_requirement_ids: uniqueSortedStrings(driftRequirementIds),
    design_requirement_ids: uniqueSortedStrings(designRequirementIds),
    sources: normalizedSourceRefs(refs),
  };
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

export {
  extractDesignRequirementIds,
  extractDriftRequirementIds,
  extractMustRequirementIds,
  extractPlanTaskRequirementIds,
  extractPlanTestRequirementIds,
  uniqueSortedStrings,
};
