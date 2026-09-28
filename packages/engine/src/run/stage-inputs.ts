/**
 * Resolves task sessions, profiles, and artifact references for deterministic runner stages.
 */
import { existsSync } from "node:fs";
import { badInput } from "../primitives/errors.js";
import {
  getRepoRoot,
  getRunDir,
  readJsonStrict,
  resolveWithinDirectory,
  resolveWithinRepo,
  toWorkspaceRelative,
  type PipelineState,
} from "./state.js";
import { appendTraceEvent } from "./trace.js";
import { buildRequirementCoverageLedger } from "./traceability.js";
import { coalesce, mergeStageProfile, toNumber } from "../primitives/stage-values.js";

const ACTIVITY_ID_BY_PHASE = {
  arm: "arm_briefing",
  design: "design_synthesis",
  "adversarial-review": "adversarial_review_lead",
  plan: "plan_synthesis",
  pmatch: "pmatch_adjudicator",
  "quality-static": "quality_static",
  "quality-tests": "quality_tests_case",
  "post-build": "post_build",
  "release-readiness": "release_readiness",
};

export interface TaskRecord extends Record<string, unknown> {
  id?: unknown;
  trace_id?: unknown;
  test_cases?: unknown;
  execution_session?: unknown;
  stage_overrides?: unknown;
  config_overrides?: unknown;
}
export interface TaskContext extends Record<string, unknown> {
  taskset: Record<string, unknown>;
  task: TaskRecord;
  taskset_path: string;
}
export interface TaskSessionRecord extends Record<string, unknown> {
  session_id: unknown;
  session_kind: unknown;
  fresh_context: boolean;
  inherits_history: boolean;
  max_attempts: number;
  retry_behavior: unknown;
}
export interface ActivityProfile extends Record<string, unknown> {
  activity_id: string;
  tier: unknown;
  model_hint: unknown;
  runtime_name: unknown;
  runtime_version: unknown;
}
export interface TaskSession {
  session: TaskSessionRecord;
  task: TaskRecord;
  testCase: TaskRecord | null;
  activity_profile?: ActivityProfile;
}
type StageOptions = Record<string, string | boolean | string[] | undefined>;

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedMaxAttempts(value: unknown): number {
  return Number.isInteger(value) ? Math.max(1, value as number) : 1;
}

function nullishDefault<T>(value: T | null | undefined, fallback: T): T {
  return value === undefined || value === null ? fallback : value;
}

export function loadTasksetTask(
  tasksetRef?: string | boolean,
  taskId?: string | boolean,
): TaskContext | null {
  if (!tasksetRef) return null;
  if (typeof tasksetRef !== "string") throw badInput("taskset reference must be a path");
  const root = getRepoRoot();
  const tasksetPath = resolveWithinRepo(tasksetRef, root);
  const data = readJsonStrict(tasksetPath, `taskset ${tasksetRef}`);
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
    throw badInput(`taskset has no tasks: ${tasksetRef}`);
  }

  const tasks = data.tasks.filter(
    (entry): entry is TaskRecord =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  const firstTask = tasks[0];
  if (!firstTask) throw badInput(`taskset has no object tasks: ${tasksetRef}`);
  const id = typeof taskId === "string" ? taskId : firstTask.id;
  const task = tasks.find((entry) => entry.id === id);
  if (!task) {
    throw badInput(`task id not found in taskset: ${id}`);
  }
  return { taskset: data, task, taskset_path: toWorkspaceRelative(tasksetPath, root) };
}

export function resolveTaskCase(
  taskContext: TaskContext | null,
  testCaseId?: string | boolean,
): TaskRecord | null {
  const testCases = Array.isArray(taskContext?.task?.test_cases) ? taskContext.task.test_cases : [];
  if (testCases.length === 0) return null;
  const cases = testCases.filter(
    (entry): entry is TaskRecord =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  if (!testCaseId) return cases[0] ?? null;
  const testCase = cases.find(
    (entry) => entry.name === testCaseId || entry.trace_id === testCaseId,
  );
  if (!testCase) {
    throw badInput(`test case not found in taskset task: ${testCaseId}`);
  }
  return testCase;
}

export function normalizeTaskSession(
  session: unknown,
  fallback: { session_id: string; session_kind: string },
): TaskSessionRecord {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return {
      session_id: fallback.session_id,
      session_kind: fallback.session_kind,
      fresh_context: true,
      inherits_history: false,
      max_attempts: 1,
      retry_behavior: "restart-fresh-session",
    };
  }

  const record = session as Record<string, unknown>;
  return {
    session_id: coalesce(record.session_id, fallback.session_id),
    session_kind: coalesce(record.session_kind, fallback.session_kind),
    fresh_context: record.fresh_context !== false,
    inherits_history: record.inherits_history === true,
    max_attempts: normalizedMaxAttempts(record.max_attempts),
    retry_behavior: coalesce(record.retry_behavior, "restart-fresh-session"),
  };
}

export function resolveTaskSession(
  phase: string,
  taskContext: TaskContext | null,
  options: StageOptions,
): TaskSession | null {
  if (!taskContext?.task) return null;

  if (phase === "build") {
    return {
      session: normalizeTaskSession(taskContext.task.execution_session, {
        session_id: `build-${String(taskContext.task.id)}`,
        session_kind: "build-task",
      }),
      task: taskContext.task,
      testCase: null,
    };
  }

  if (phase === "quality-tests") {
    const configuredTestCase = options["test-case-id"];
    const testCase = resolveTaskCase(
      taskContext,
      Array.isArray(configuredTestCase) ? undefined : configuredTestCase,
    );
    if (!testCase) return null;
    return {
      session: normalizeTaskSession(testCase.execution_session, {
        session_id: `quality-${String(testCase.trace_id ?? testCase.name)}`,
        session_kind: "quality-case",
      }),
      task: taskContext.task,
      testCase,
    };
  }

  return null;
}

export function appendTaskSessionEvent(
  runId: string,
  phase: string,
  event: string,
  status: string,
  taskSession: TaskSession | null,
  root = getRepoRoot(),
): void {
  if (!taskSession?.session) return;
  appendTraceEvent(
    runId,
    {
      event,
      phase,
      status,
      tier: taskSession.activity_profile?.tier ?? undefined,
      model_hint: taskSession.activity_profile?.model_hint ?? undefined,
      activity_id: taskSession.activity_profile?.activity_id ?? undefined,
      runtime_name: taskSession.activity_profile?.runtime_name ?? undefined,
      runtime_version: taskSession.activity_profile?.runtime_version ?? undefined,
      metadata: {
        activity_id: taskSession.activity_profile?.activity_id ?? null,
        runtime_name: taskSession.activity_profile?.runtime_name ?? null,
        runtime_version: taskSession.activity_profile?.runtime_version ?? null,
        task_session_id: taskSession.session.session_id,
        task_session_kind: taskSession.session.session_kind,
        fresh_context: taskSession.session.fresh_context,
        inherits_history: taskSession.session.inherits_history,
        max_attempts: taskSession.session.max_attempts,
        retry_behavior: taskSession.session.retry_behavior,
        task_id: taskSession.task?.id ?? null,
        task_trace_id: taskSession.task?.trace_id ?? null,
        test_case_name: taskSession.testCase?.name ?? null,
        test_case_trace_id: taskSession.testCase?.trace_id ?? null,
      },
    },
    root,
  );
}

export function resolveCognitiveTier(phase: string, state: PipelineState): unknown {
  const tiers = state?.config?.cognitive_tiers;
  if (!tiers || typeof tiers !== "object") return null;
  // Direct match (e.g., "arm", "design", "plan")
  const direct = tiers[phase];
  if (direct) return direct;
  // Hyphenated to underscored (e.g., "adversarial-review" -> "adversarial_review")
  const underscored = phase.replace(/-/g, "_");
  if (tiers[underscored]) return tiers[underscored];
  // Lead role suffix (e.g., "adversarial_review_lead", "build_lead")
  if (tiers[`${underscored}_lead`]) return tiers[`${underscored}_lead`];
  return null;
}

function resolveActivityId(phase: string, taskSession: TaskSession | null): string {
  if (phase === "build")
    return taskSession?.session?.session_kind === "build-task" ? "build_worker" : "build_lead";
  return (
    coalesce(
      ACTIVITY_ID_BY_PHASE[phase as keyof typeof ACTIVITY_ID_BY_PHASE],
      phase.replace(/-/g, "_"),
    ) ?? phase.replace(/-/g, "_")
  );
}

export function resolveActivityProfile(
  phase: string,
  state: PipelineState,
  taskSession: TaskSession | null,
): ActivityProfile {
  const activityId = resolveActivityId(phase, taskSession);
  const assignment = state?.config?.activity_assignments?.[activityId] ?? {};
  return {
    activity_id: activityId,
    tier: nullishDefault(assignment.tier, resolveCognitiveTier(phase, state)),
    model_hint: nullishDefault(assignment.model_hint, null),
    runtime_name: nullishDefault(assignment.runtime_name, "default"),
    runtime_version: nullishDefault(assignment.runtime_version, "v1"),
  };
}

export function contextBudgetForPhase(
  phase: string,
  state: PipelineState,
): { token_max: number; files_max: number } | null {
  const budgets = state?.config?.context_budgets ?? {};
  const direct = budgets[phase];
  const fallbackKey = phase === "build" ? "build_lead" : phase;
  const value = coalesce(direct, budgets[fallbackKey]);
  if (value === undefined || value === null) return null;

  if (typeof value === "number") {
    return {
      token_max: value,
      files_max: 64,
    };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      token_max: toNumber(coalesce(record.token_max, record.max_tokens, record.token_estimate), 0),
      files_max: Math.max(
        1,
        Math.trunc(toNumber(coalesce(record.files_max, record.max_files), 64)),
      ),
    };
  }

  return null;
}

export function stageProfileFromTask({
  task,
  configId,
  phase,
}: {
  task?: TaskRecord;
  configId: string;
  phase: string;
}): Record<string, unknown> {
  const stageOverrides = recordValue(task?.stage_overrides);
  const configOverrides = recordValue(task?.config_overrides);
  const base = recordValue(stageOverrides[phase]);
  const cfg = recordValue(recordValue(configOverrides[configId])[phase]);
  return mergeStageProfile(base, cfg);
}

export function ensureStateForRun(state: PipelineState, runId: string): void {
  if (state.run_id !== runId) {
    state.run_id = runId;
  }
}

export function phaseTokenForContextBudget(phase: string): string {
  if (phase === "build") return "build_lead";
  return phase;
}

export function resolveArtifactRefForRun(runId: string, artifactRef: string, root: string): string {
  const runDir = getRunDir(runId, root);
  if (!artifactRef) {
    throw badInput("artifact reference is required");
  }
  if (artifactRef.startsWith(".pipeline/")) {
    return resolveWithinRepo(artifactRef, root);
  }
  if (artifactRef.startsWith("/")) {
    return resolveWithinRepo(artifactRef, root);
  }
  return resolveWithinDirectory(runDir, artifactRef, { baseLabel: "run directory" });
}

export function resolveOptionalArtifactRefForRun(
  runId: string,
  artifactRef: unknown,
  root: string,
): string | null {
  if (!artifactRef) return null;
  if (typeof artifactRef !== "string") return null;
  try {
    return resolveArtifactRefForRun(runId, artifactRef, root);
  } catch {
    return null;
  }
}

export function resolveQualityCoverageLedger(
  runId: string,
  state: PipelineState,
  phase: string,
  root: string,
): Record<string, unknown> | null {
  if (phase !== "quality-tests") return null;

  const briefRef = state?.artifacts?.brief ?? "brief.json";
  const planRef = state?.artifacts?.plan ?? "plan.json";
  const briefAbs = resolveOptionalArtifactRefForRun(runId, briefRef, root);
  const planAbs = resolveOptionalArtifactRefForRun(runId, planRef, root);

  if (!briefAbs || !planAbs || !existsSync(briefAbs) || !existsSync(planAbs)) {
    return null;
  }

  appendTraceEvent(
    runId,
    {
      event: "artifact_read",
      phase,
      artifact_ref: toWorkspaceRelative(briefAbs, root),
      status: "ok",
    },
    root,
  );
  appendTraceEvent(
    runId,
    {
      event: "artifact_read",
      phase,
      artifact_ref: toWorkspaceRelative(planAbs, root),
      status: "ok",
    },
    root,
  );

  const brief = readJsonStrict(briefAbs, `quality coverage brief ${briefRef}`);
  const plan = readJsonStrict(planAbs, `quality coverage plan ${planRef}`);
  return buildRequirementCoverageLedger({ brief, plan });
}

export function resolveReviewLoopSnapshot(
  runId: string,
  phase: string,
  root: string,
): Record<string, unknown> | null {
  if (phase !== "release-readiness") return null;
  const reviewLoopAbs = resolveOptionalArtifactRefForRun(runId, "review-loop.json", root);
  if (!reviewLoopAbs || !existsSync(reviewLoopAbs)) {
    return null;
  }

  appendTraceEvent(
    runId,
    {
      event: "artifact_read",
      phase,
      artifact_ref: toWorkspaceRelative(reviewLoopAbs, root),
      status: "ok",
    },
    root,
  );

  const reviewLoop = readJsonStrict(reviewLoopAbs, "review-loop.json");
  const states = recordValue(reviewLoop.states);
  const status = (name: string): unknown => recordValue(states[name]).status ?? "not-started";
  return {
    review_loop_ref: toWorkspaceRelative(reviewLoopAbs, root),
    review_state: {
      explain_status: status("explain"),
      fix_status: status("fix"),
      ship_status: status("ship"),
    },
  };
}
