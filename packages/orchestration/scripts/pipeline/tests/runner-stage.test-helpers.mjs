/**
 * Supplies controlled runner fixtures so stage tests can assert lifecycle and artifact behavior deterministically.
 */
import { beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const RUNNER = join(REPO_ROOT, "scripts/pipeline/runner.mjs");
const PIPELINE_DIR = join(REPO_ROOT, ".pipeline");
const STATE_PATH = join(PIPELINE_DIR, "pipeline-state.json");
const TASKSET_PATH = join(PIPELINE_DIR, "runner-stage-taskset.json");

export const TEST_RUN_ID = "runner-stage-test";

let originalState = null;

export function runRunner(args) {
  return spawnSync("node", [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function defaultArtifacts() {
  return {
    brief: null,
    design: null,
    review: null,
    review_loop: null,
    plan: null,
    build: null,
    post_build: null,
    release_readiness: null,
    drift_reports: [],
    quality_reports: [],
  };
}

function defaultConfig() {
  return {
    context_budgets: { design: 24000 },
    activity_assignments: {
      arm_briefing: {
        tier: "high_reasoning",
        model_hint: "brief-architect",
        runtime_name: "default",
        runtime_version: "v1",
      },
      build_worker: {
        tier: "fast",
        model_hint: "build-worker",
        runtime_name: "default",
        runtime_version: "v1",
      },
      quality_tests_case: {
        tier: "fast",
        model_hint: "quality-tests",
        runtime_name: "default",
        runtime_version: "v1",
      },
    },
    feature_flags: { context_budget_v1: true },
  };
}

export function initState(nextPhase = "arm") {
  const nextPhaseIndex = PHASE_ORDER.indexOf(nextPhase);
  if (nextPhaseIndex === -1) {
    throw new Error(`unknown next phase: ${nextPhase}`);
  }
  mkdirSync(PIPELINE_DIR, { recursive: true });
  rmSync(join(PIPELINE_DIR, "runs", TEST_RUN_ID), { recursive: true, force: true });
  const state = {
    run_id: TEST_RUN_ID,
    created_at: new Date().toISOString(),
    current_phase: PHASE_ORDER[Math.max(0, nextPhaseIndex - 1)],
    phase_order: PHASE_ORDER,
    completed_gates: PHASE_ORDER.slice(0, nextPhaseIndex).map((phase) => `${phase}-gate`),
    artifacts: defaultArtifacts(),
    config: defaultConfig(),
  };
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function writeTasksetFixture() {
  const taskset = {
    tasks: [
      {
        id: "task-1",
        trace_id: "task-trace-1",
        description: "Exercise build and quality session tracing.",
        execution_session: {
          session_id: "build-task-1",
          session_kind: "build-task",
          fresh_context: true,
          inherits_history: false,
          max_attempts: 2,
          retry_behavior: "restart-fresh-session",
        },
        file_paths: ["scripts/pipeline/runner.mjs"],
        code_patterns: [
          {
            file: "scripts/pipeline/runner.mjs",
            pattern: "run-stage",
          },
        ],
        test_cases: [
          {
            name: "runner-stage-smoke",
            trace_id: "quality-test-1",
            execution_session: {
              session_id: "quality-case-runner-stage-smoke",
              session_kind: "quality-case",
              fresh_context: true,
              inherits_history: false,
              max_attempts: 2,
              retry_behavior: "restart-fresh-session",
            },
            covers_requirement_ids: ["REQ-001"],
            setup: "Initialize task-scoped quality checks.",
            assertion: "quality-tests phase completes",
            expected: "gate passes",
          },
        ],
        acceptance_criteria: ["task session trace emitted"],
        covers_requirement_ids: ["REQ-001"],
      },
    ],
  };
  writeFileSync(TASKSET_PATH, `${JSON.stringify(taskset, null, 2)}\n`, "utf8");
}

export function writeTraceabilityFixtures() {
  const runDir = join(PIPELINE_DIR, "runs", TEST_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "brief.json"),
    `${JSON.stringify(
      {
        requirements: [{ id: "REQ-001", priority: "must" }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(runDir, "plan.json"),
    `${JSON.stringify(
      {
        task_groups: [
          {
            group_id: "group-1",
            tasks: [
              {
                id: "task-1",
                covers_requirement_ids: ["REQ-001"],
                acceptance_criteria: ["runner-stage-smoke passes"],
                test_cases: [{ name: "runner-stage-smoke", covers_requirement_ids: ["REQ-001"] }],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  state.artifacts.brief = "brief.json";
  state.artifacts.plan = "plan.json";
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function writeEmptyBriefFixture() {
  const emptyBriefPath = join(PIPELINE_DIR, "empty-brief.json");
  writeFileSync(
    emptyBriefPath,
    `${JSON.stringify(
      {
        requirements: [],
        constraints: [],
        non_goals: [],
        style: { tone: "direct" },
        key_concepts: [],
        decisions: [],
        open_questions: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return emptyBriefPath;
}

export function writeReviewLoopFixture() {
  const runDir = join(PIPELINE_DIR, "runs", TEST_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "review-loop.json"),
    `${JSON.stringify(
      {
        run_id: TEST_RUN_ID,
        current_state: "ship",
        states: {
          explain: {
            status: "completed",
            code_mutation_allowed: false,
            approval_required: false,
          },
          fix: {
            status: "completed",
            code_mutation_allowed: true,
            approval_required: true,
          },
          ship: {
            status: "approved",
            code_mutation_allowed: false,
            approval_required: true,
          },
        },
        transition_log: [],
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function registerStateLifecycle() {
  beforeAll(() => {
    if (existsSync(STATE_PATH)) {
      originalState = readFileSync(STATE_PATH, "utf8");
    }
    initState();
  });

  afterAll(() => {
    const runDir = join(PIPELINE_DIR, "runs", TEST_RUN_ID);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(TASKSET_PATH, { force: true });
    rmSync(join(PIPELINE_DIR, "empty-brief.json"), { force: true });
    rmSync(join(PIPELINE_DIR, "caller-quality.json"), { force: true });

    if (originalState !== null) {
      writeFileSync(STATE_PATH, originalState, "utf8");
    } else {
      rmSync(STATE_PATH, { force: true });
    }
  });
}

export function runDirForTest() {
  return join(PIPELINE_DIR, "runs", TEST_RUN_ID);
}

export function pipelineDirForTest() {
  return PIPELINE_DIR;
}
