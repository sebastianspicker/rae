#!/usr/bin/env node
/**
 * Executes evaluation task/configuration matrices through the pipeline while preserving run isolation.
 */
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateTasksetSchema } from "./lib/taskset-validate.mjs";
import {
  readJson,
  readJsonStrict,
  resolveWithinRepo,
  toWorkspaceRelative,
  withLockedState,
  writeJson,
} from "../pipeline/lib/state.mjs";
import { parseArgs as parseCliArgs } from "../lib/argv.mjs";
import { CONFIG_IDS, PHASE_ORDER } from "../lib/constants.mjs";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";
import { appendRunEndIfMissing } from "../pipeline/lib/runner-helpers-b.mjs";

assertSupportedNodeRuntime();

const EVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseArgs(argv) {
  const args = parseCliArgs(
    {
      defaults: {
        root: process.cwd(),
        evalId: `eval-${new Date().toISOString().replace(/[-:.]/g, "")}`,
        taskset: "docs/eval/tasksets/default.json",
        repeats: 1,
        mode: "shadow",
      },
      options: {
        root: { type: "string" },
        "eval-id": { key: "evalId", type: "string" },
        taskset: { type: "string" },
        repeats: { type: "number" },
        mode: { type: "string", enum: ["shadow", "enforce"] },
      },
    },
    argv.slice(2),
  );

  if (!Number.isInteger(args.repeats) || args.repeats < 1) {
    throw new Error("--repeats must be an integer >= 1");
  }
  if (!EVAL_ID_PATTERN.test(args.evalId)) {
    throw new Error("--eval-id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
  }

  return args;
}

function runCommand(cmd, args, { cwd, env, input, allowFailure = false } = {}) {
  const proc = spawnSync(cmd, args, {
    cwd,
    env: {
      ...process.env,
      ...(env || {}),
    },
    encoding: "utf8",
    input,
  });

  if (!allowFailure && proc.status !== 0) {
    const stderr = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed (${proc.status}): ${stderr}`);
  }

  return proc;
}

function parseRunId(initOutput, root) {
  const match = initOutput.match(/run_id:\s+([^\s]+)/);
  if (!match) {
    throw new Error(`Could not parse run_id from pipeline-init output:\n${initOutput}`);
  }
  const runId = match[1];
  const state = readJsonStrict(resolve(root, ".pipeline", "pipeline-state.json"));
  if (state.run_id !== runId) {
    throw new Error(`pipeline-init returned run_id without run directory: ${runId}`);
  }
  return runId;
}

function requireObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
}

function requireNonEmptyArray(value, message) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(message);
}

function validateStageOverride(phase, override, contextLabel) {
  if (!PHASE_ORDER.includes(phase)) {
    throw new Error(`${contextLabel} contains unsupported phase: ${phase}`);
  }
  requireObject(override, `${contextLabel}.${phase}`);
  if (override.gate_status && !["pass", "warn", "fail"].includes(override.gate_status)) {
    throw new Error(`${contextLabel}.${phase}.gate_status must be pass|warn|fail`);
  }
}

function validateStageOverrideMap(stageMap, contextLabel) {
  if (!stageMap) return;
  requireObject(stageMap, contextLabel);
  for (const [phase, override] of Object.entries(stageMap)) {
    validateStageOverride(phase, override, contextLabel);
  }
}

function validateConfigOverrides(task) {
  if (task.config_overrides === undefined) return;
  const label = `task(${task.id}).config_overrides`;
  requireObject(task.config_overrides, label);
  for (const [configId, stageMap] of Object.entries(task.config_overrides)) {
    if (!CONFIG_IDS.includes(configId)) {
      throw new Error(`${label} has unsupported config ${configId}`);
    }
    validateStageOverrideMap(stageMap, `${label}.${configId}`);
  }
}

function validateTask(task) {
  requireObject(task, "each task");
  requireNonEmptyString(task.id, "task.id is required");
  requireNonEmptyString(task.title, `task.title is required for ${task.id}`);
  requireNonEmptyArray(
    task.must_requirement_ids,
    `task.must_requirement_ids must be non-empty for ${task.id}`,
  );
  validateStageOverrideMap(task.stage_overrides, `task(${task.id}).stage_overrides`);
  validateConfigOverrides(task);
}

function validateTaskset(taskset) {
  requireObject(taskset, "Taskset");
  requireNonEmptyString(taskset.taskset_id, "taskset_id is required");
  requireNonEmptyArray(taskset.tasks, "tasks must be a non-empty array");
  taskset.tasks.forEach(validateTask);
}

function loadTaskset(root, tasksetRef) {
  const abs = resolveWithinRepo(tasksetRef, root);
  const taskset = readJson(abs, null);
  if (!taskset) {
    throw new Error(`Taskset not found: ${tasksetRef}`);
  }
  validateTasksetSchema({
    root,
    tasksetPath: tasksetRef,
    taskset,
  });
  validateTaskset(taskset);
  return { abs, rel: toWorkspaceRelative(abs, root), taskset };
}

function applyConfigToPipelineState(root, configId, mode) {
  withLockedState(root, (state) => {
    const featureFlags = { ...(state?.config?.feature_flags ?? {}) };
    featureFlags.trace_v1 = true;
    featureFlags.evaluation_v1 = true;

    if (mode === "shadow") {
      featureFlags.context_budget_v1 = false;
      featureFlags.traceability_v1 = false;
      featureFlags.drift_benchmark_v1 = false;
    } else {
      featureFlags.context_budget_v1 = configId === "phased_with_context_budgets";
      featureFlags.traceability_v1 = configId !== "baseline_single_agent";
      featureFlags.drift_benchmark_v1 = configId === "phased_dual_extractor_drift";
    }

    state.config = state.config ?? {};
    state.config.feature_flags = featureFlags;
  });
}

function executeRun({ root, runId, configId, tasksetRel, taskId }) {
  let failed = false;

  for (const phase of PHASE_ORDER) {
    const proc = runCommand(
      "node",
      [
        "scripts/pipeline/runner.mjs",
        "run-stage",
        "--run-id",
        runId,
        "--phase",
        phase,
        "--taskset",
        tasksetRel,
        "--task-id",
        taskId,
        "--config-id",
        configId,
      ],
      { cwd: root, allowFailure: true },
    );

    if (proc.status !== 0) {
      failed = true;
      break;
    }
  }

  if (failed) {
    // A stage failure remains retryable for interactive callers. The matrix
    // runner deliberately abandons that run, so it must close the trace before
    // summarization without marking the failed gate complete.
    withLockedState(root, (state) => {
      appendRunEndIfMissing(runId, state, root, {
        status: "error",
        source: "eval-run-matrix",
        reason: "stage-failure",
      });
    });
  }

  runCommand("node", ["scripts/pipeline/runner.mjs", "summarize-run", "--run-id", runId], {
    cwd: root,
  });

  return { failed };
}

function evaluationPaths(root, evalId) {
  const evalDir = resolveWithinRepo(`.pipeline/evaluations/${evalId}`, root);
  return {
    matrixPath: resolve(evalDir, "matrix.json"),
    reportPath: resolve(evalDir, "evaluation-report.json"),
  };
}

function executeMatrix({ args, root, taskset, tasksetRel }) {
  const runIdsByConfig = new Map(CONFIG_IDS.map((id) => [id, []]));
  const runMeta = [];

  for (const configId of CONFIG_IDS) {
    for (let repeat = 1; repeat <= args.repeats; repeat++) {
      for (const task of taskset.tasks) {
        const init = runCommand("bash", ["scripts/pipeline-init.sh", root], { cwd: root });
        const runId = parseRunId(init.stdout || "", root);

        applyConfigToPipelineState(root, configId, args.mode);

        const result = executeRun({
          root,
          runId,
          configId,
          tasksetRel,
          taskId: task.id,
        });

        runIdsByConfig.get(configId).push(runId);
        runMeta.push({
          run_id: runId,
          config_id: configId,
          repeat,
          task_id: task.id,
          failed: result.failed,
        });
      }
    }
  }
  return { runIdsByConfig, runMeta };
}

function matrixArtifact({ args, taskset, runIdsByConfig, runMeta }) {
  return {
    evaluation_id: args.evalId,
    taskset_id: taskset.taskset_id,
    mode: args.mode,
    repeats: args.repeats,
    configurations: CONFIG_IDS.map((id) => ({
      id,
      run_ids: runIdsByConfig.get(id),
    })),
    run_meta: runMeta,
  };
}

function aggregateMatrix({ args, root }) {
  runCommand(
    "node",
    [
      "scripts/eval/aggregate.mjs",
      "--root",
      root,
      "--matrix",
      `.pipeline/evaluations/${args.evalId}/matrix.json`,
      "--output",
      `.pipeline/evaluations/${args.evalId}/evaluation-report.json`,
    ],
    { cwd: root },
  );
}

function emitMatrixSummary({ matrixPath, reportPath, runMeta }) {
  const failedRuns = runMeta.filter((entry) => entry.failed);
  process.stdout.write(
    `${JSON.stringify(
      {
        matrix_path: matrixPath,
        report_path: reportPath,
        total_runs: runMeta.length,
        failed_runs: failedRuns.length,
      },
      null,
      2,
    )}\n`,
  );
  if (failedRuns.length > 0) {
    process.exitCode = 1;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const root = resolve(args.root);
  const { taskset, rel: tasksetRel } = loadTaskset(root, args.taskset);
  const { matrixPath, reportPath } = evaluationPaths(root, args.evalId);
  const { runIdsByConfig, runMeta } = executeMatrix({ args, root, taskset, tasksetRel });
  writeJson(matrixPath, matrixArtifact({ args, taskset, runIdsByConfig, runMeta }));
  aggregateMatrix({ args, root });
  emitMatrixSummary({ matrixPath, reportPath, runMeta });
}

try {
  main();
} catch (error) {
  const code = error?.code || "E_EVAL_RUN_MATRIX";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}
