/**
 * Normalizes requirement coverage and builds requirement coverage evidence.
 */
type UnknownRecord = Record<string, unknown>;
type StringMap = Map<string, string[]>;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function uniqueSortedStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ].sort();
}

function collectIdsFromList(entries: unknown, key: string): string[] {
  const out: string[] = [];
  for (const entry of asArray(entries)) {
    const ids = asArray(recordValue(entry)[key]);
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
  return out;
}

function extractMustRequirementIds(brief: unknown): string[] {
  const record = recordValue(brief);
  return uniqueSortedStrings(
    asArray(record.requirements)
      .filter((req) => recordValue(req).priority === "must")
      .map((req) => recordValue(req).id),
  );
}

function extractPlanTaskRequirementIds(plan: unknown): string[] {
  const taskGroups = asArray(recordValue(plan).task_groups);
  const ids: string[] = [];
  for (const group of taskGroups) {
    const tasks = asArray(recordValue(group).tasks);
    for (const task of tasks) {
      ids.push(...collectIdsFromList([task], "covers_requirement_ids"));
    }
  }
  return uniqueSortedStrings(ids);
}

function extractPlanTestRequirementIds(plan: unknown): string[] {
  const taskGroups = asArray(recordValue(plan).task_groups);
  const ids: string[] = [];
  for (const group of taskGroups) {
    const tasks = asArray(recordValue(group).tasks);
    for (const task of tasks) {
      ids.push(
        ...collectIdsFromList(asArray(recordValue(task).test_cases), "covers_requirement_ids"),
      );
    }
  }
  return uniqueSortedStrings(ids);
}

function planTasks(plan: unknown): unknown[] {
  return asArray(recordValue(plan).task_groups).flatMap((group) =>
    asArray(recordValue(group).tasks),
  );
}

function entryIdentifier(entry: unknown, keys: string[]): string | null {
  const record = recordValue(entry);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function addMappedValues(mapping: StringMap, keys: unknown, values: string[]): void {
  for (const key of asArray(keys)) {
    if (typeof key !== "string" || key.length === 0) continue;
    const existing = mapping.get(key) ?? [];
    existing.push(...values);
    mapping.set(key, existing);
  }
}

function collectPlanTaskIdsByRequirement(plan: unknown): StringMap {
  const mapping: StringMap = new Map();
  for (const task of planTasks(plan)) {
    const taskId = entryIdentifier(task, ["id"]);
    if (!taskId) continue;
    addMappedValues(mapping, recordValue(task).covers_requirement_ids, [taskId]);
  }
  return mapping;
}

function collectPlanTestCasesByRequirement(plan: unknown): StringMap {
  const mapping: StringMap = new Map();
  for (const task of planTasks(plan)) {
    for (const testCase of asArray(recordValue(task).test_cases)) {
      const testCaseName = entryIdentifier(testCase, ["name", "trace_id"]);
      if (!testCaseName) continue;
      addMappedValues(mapping, recordValue(testCase).covers_requirement_ids, [testCaseName]);
    }
  }
  return mapping;
}

function collectAcceptanceCriteriaByRequirement(plan: unknown): StringMap {
  const mapping: StringMap = new Map();
  for (const task of planTasks(plan)) {
    const taskRecord = recordValue(task);
    const acceptanceCriteria = uniqueSortedStrings(asArray(taskRecord.acceptance_criteria));
    addMappedValues(mapping, taskRecord.covers_requirement_ids, acceptanceCriteria);
  }
  return mapping;
}

function extractDriftRequirementIds(drift: unknown): string[] {
  return uniqueSortedStrings(
    collectIdsFromList(asArray(recordValue(drift).claims), "covers_requirement_ids"),
  );
}

function extractDesignRequirementIds(design: unknown): string[] {
  return uniqueSortedStrings(
    collectIdsFromList(
      asArray(recordValue(design).constraints_classification),
      "covers_requirement_ids",
    ),
  );
}

export interface CoverageResult extends Record<string, unknown> {
  name: string;
  passed: boolean;
  evidence: string;
  missing_ids: string[];
  evidence_suffix?: string;
}
export function buildCoverageResult(
  name: string,
  sourceIds: unknown[],
  targetIds: unknown[],
  extra: Record<string, unknown> = {},
): CoverageResult {
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

function normalizedSourceRefs(refs: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(refs).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as Record<string, string>;
}

export interface NormalizedTraceability extends Record<string, unknown> {
  must_requirement_ids: string[];
  plan_task_requirement_ids: string[];
  plan_test_requirement_ids: string[];
  drift_requirement_ids: string[];
  design_requirement_ids: string[];
  sources: Record<string, string>;
}
export function normalizeTraceabilityInput({
  mustRequirementIds,
  planTaskRequirementIds,
  planTestRequirementIds,
  driftRequirementIds,
  designRequirementIds,
  refs,
}: {
  mustRequirementIds: unknown[];
  planTaskRequirementIds: unknown[];
  planTestRequirementIds: unknown[];
  driftRequirementIds: unknown[];
  designRequirementIds: unknown[];
  refs: Record<string, unknown>;
}): NormalizedTraceability {
  return {
    must_requirement_ids: uniqueSortedStrings(mustRequirementIds),
    plan_task_requirement_ids: uniqueSortedStrings(planTaskRequirementIds),
    plan_test_requirement_ids: uniqueSortedStrings(planTestRequirementIds),
    drift_requirement_ids: uniqueSortedStrings(driftRequirementIds),
    design_requirement_ids: uniqueSortedStrings(designRequirementIds),
    sources: normalizedSourceRefs(refs),
  };
}

function missingCoverage(values: string[], marker: string): string[] {
  return values.length > 0 ? [] : [marker];
}

function coverageStatus(
  plannedTaskIds: string[],
  plannedTestCases: string[],
): "covered" | "partial" | "missing" {
  const hasTasks = plannedTaskIds.length > 0;
  const hasTests = plannedTestCases.length > 0;
  if (hasTasks && hasTests) return "covered";
  if (hasTasks || hasTests) return "partial";
  return "missing";
}

function buildRequirementCoverageEntry(
  requirementId: string,
  taskMap: StringMap,
  testMap: StringMap,
  acceptanceMap: StringMap,
): Record<string, unknown> & { requirement_id: string; status: "covered" | "partial" | "missing" } {
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

export function buildRequirementCoverageLedger({
  brief,
  plan,
}: {
  brief: unknown;
  plan: unknown;
}): Record<string, unknown> {
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
