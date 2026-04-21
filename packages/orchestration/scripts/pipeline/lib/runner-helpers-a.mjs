import { existsSync } from "node:fs";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { badInput } from "./errors.mjs";
import {
  getRepoRoot,
  getRunDir,
  loadPipelineState,
  readJsonStrict,
  resolveWithinDirectory,
  resolveWithinRepo,
  resolveWorkspaceRootForRun,
  toWorkspaceRelative,
  writeJson,
} from "./state.mjs";
import { appendTraceEvent } from "./trace.mjs";
import { phaseArtifactDefaults } from "./artifacts.mjs";
import { buildRequirementCoverageLedger } from "./traceability.mjs";
import { stageGateInput } from "./gates.mjs";
import { coalesce, mergeStageProfile, toNumber } from "./utils.mjs";

const PHASES = PHASE_ORDER;
export function loadTasksetTask(tasksetRef, taskId) {
  if (!tasksetRef) return null;
  const root = getRepoRoot();
  const tasksetPath = resolveWithinRepo(tasksetRef, root);
  const data = readJsonStrict(tasksetPath, `taskset ${tasksetRef}`);
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) {
    throw badInput(`taskset has no tasks: ${tasksetRef}`);
  }

  const id = taskId || data.tasks[0].id;
  const task = data.tasks.find((entry) => entry.id === id);
  if (!task) {
    throw badInput(`task id not found in taskset: ${id}`);
  }
  return { taskset: data, task, taskset_path: toWorkspaceRelative(tasksetPath, root) };
}

export function resolveTaskCase(taskContext, testCaseId) {
  const testCases = Array.isArray(taskContext?.task?.test_cases) ? taskContext.task.test_cases : [];
  if (testCases.length === 0) return null;
  if (!testCaseId) return testCases[0];
  const testCase = testCases.find((entry) => entry.name === testCaseId || entry.trace_id === testCaseId);
  if (!testCase) {
    throw badInput(`test case not found in taskset task: ${testCaseId}`);
  }
  return testCase;
}

export function normalizeTaskSession(session, fallback) {
  if (!session || typeof session !== "object") {
    return {
      session_id: fallback.session_id,
      session_kind: fallback.session_kind,
      fresh_context: true,
      inherits_history: false,
      max_attempts: 1,
      retry_behavior: "restart-fresh-session",
    };
  }

  return {
    session_id: session.session_id ?? fallback.session_id,
    session_kind: session.session_kind ?? fallback.session_kind,
    fresh_context: session.fresh_context !== false,
    inherits_history: session.inherits_history === true,
    max_attempts: Number.isInteger(session.max_attempts) ? Math.max(1, session.max_attempts) : 1,
    retry_behavior: session.retry_behavior ?? "restart-fresh-session",
  };
}

export function resolveTaskSession(phase, taskContext, options) {
  if (!taskContext?.task) return null;

  if (phase === "build") {
    return {
      session: normalizeTaskSession(taskContext.task.execution_session, {
        session_id: `build-${taskContext.task.id}`,
        session_kind: "build-task",
      }),
      task: taskContext.task,
      testCase: null,
    };
  }

  if (phase === "quality-tests") {
    const testCase = resolveTaskCase(taskContext, options["test-case-id"]);
    if (!testCase) return null;
    return {
      session: normalizeTaskSession(testCase.execution_session, {
        session_id: `quality-${testCase.trace_id ?? testCase.name}`,
        session_kind: "quality-case",
      }),
      task: taskContext.task,
      testCase,
    };
  }

  return null;
}

export function appendTaskSessionEvent(runId, phase, event, status, taskSession, root = getRepoRoot()) {
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

export function resolveCognitiveTier(phase, state) {
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

function resolveActivityId(phase, taskSession) {
  if (phase === "arm") return "arm_briefing";
  if (phase === "design") return "design_synthesis";
  if (phase === "adversarial-review") return "adversarial_review_lead";
  if (phase === "plan") return "plan_synthesis";
  if (phase === "pmatch") return "pmatch_adjudicator";
  if (phase === "build") return taskSession?.session?.session_kind === "build-task" ? "build_worker" : "build_lead";
  if (phase === "quality-static") return "quality_static";
  if (phase === "quality-tests") return "quality_tests_case";
  if (phase === "post-build") return "post_build";
  if (phase === "release-readiness") return "release_readiness";
  return phase.replace(/-/g, "_");
}

export function resolveActivityProfile(phase, state, taskSession) {
  const activityId = resolveActivityId(phase, taskSession);
  const assignment = state?.config?.activity_assignments?.[activityId] ?? {};
  return {
    activity_id: activityId,
    tier: assignment.tier ?? resolveCognitiveTier(phase, state),
    model_hint: assignment.model_hint ?? null,
    runtime_name: assignment.runtime_name ?? "default",
    runtime_version: assignment.runtime_version ?? "v1",
  };
}

export function contextBudgetForPhase(phase, state) {
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

  if (value && typeof value === "object") {
    return {
      token_max: toNumber(coalesce(value.token_max, value.max_tokens, value.token_estimate), 0),
      files_max: Math.max(1, Math.trunc(toNumber(coalesce(value.files_max, value.max_files), 64))),
    };
  }

  return null;
}

export function stageProfileFromTask({ task, configId, phase }) {
  const base = task?.stage_overrides?.[phase] ?? {};
  const cfg = task?.config_overrides?.[configId]?.[phase] ?? {};
  return mergeStageProfile(base, cfg);
}

export function ensureStateForRun(state, runId) {
  if (state.run_id !== runId) {
    state.run_id = runId;
  }
}

export function phaseTokenForContextBudget(phase) {
  if (phase === "build") return "build_lead";
  return phase;
}

export function resolveArtifactRefForRun(runId, artifactRef, root) {
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

export function resolveOptionalArtifactRefForRun(runId, artifactRef, root) {
  if (!artifactRef) return null;
  try {
    return resolveArtifactRefForRun(runId, artifactRef, root);
  } catch {
    return null;
  }
}

export function resolveQualityCoverageLedger(runId, state, phase, root) {
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

export function resolveReviewLoopSnapshot(runId, phase, root) {
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
  return {
      review_loop_ref: toWorkspaceRelative(reviewLoopAbs, root),
    review_state: {
      explain_status: reviewLoop?.states?.explain?.status ?? "not-started",
      fix_status: reviewLoop?.states?.fix?.status ?? "not-started",
      ship_status: reviewLoop?.states?.ship?.status ?? "not-started",
    },
  };
}
