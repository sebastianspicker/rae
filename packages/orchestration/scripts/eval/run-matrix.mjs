#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateTasksetSchema } from "./lib/taskset-validate.mjs";
import {
  getRunDir,
  readJsonStrict,
  resolveWithinRepo,
  toWorkspaceRelative,
  writeJson,
} from "../pipeline/lib/state.mjs";
import { parseArgs as parseCliArgs } from "../lib/argv.mjs";
import { CONFIG_IDS, PHASE_ORDER } from "../lib/constants.mjs";

const EVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseArgs(argv) {
  const args = parseCliArgs(
    {
      defaults: {
        root: process.cwd(),
        evalId: `eval-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}`,
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
  const runDir = getRunDir(runId, root);
  if (!existsSync(runDir)) {
    throw new Error(`pipeline-init returned run_id without run directory: ${runId}`);
  }
  return runId;
}

function validateStageOverrideMap(stageMap, contextLabel) {
  if (!stageMap) return;
  if (typeof stageMap !== "object" || Array.isArray(stageMap)) {
    throw new Error(`${contextLabel} must be an object`);
  }

  for (const [phase, override] of Object.entries(stageMap)) {
    if (!PHASE_ORDER.includes(phase)) {
      throw new Error(`${contextLabel} contains unsupported phase: ${phase}`);
    }
    if (typeof override !== "object" || override === null || Array.isArray(override)) {
      throw new Error(`${contextLabel}.${phase} must be an object`);
    }
    if (override.gate_status && !["pass", "warn", "fail"].includes(override.gate_status)) {
      throw new Error(`${contextLabel}.${phase}.gate_status must be pass|warn|fail`);
    }
  }
}

function validateTaskset(taskset) {
  if (!taskset || typeof taskset !== "object") {
    throw new Error("Taskset must be an object");
  }
  if (typeof taskset.taskset_id !== "string" || taskset.taskset_id.length === 0) {
    throw new Error("taskset_id is required");
  }
  if (!Array.isArray(taskset.tasks) || taskset.tasks.length === 0) {
    throw new Error("tasks must be a non-empty array");
  }

  for (const task of taskset.tasks) {
    if (!task || typeof task !== "object") {
      throw new Error("each task must be an object");
    }
    if (typeof task.id !== "string" || task.id.length === 0) {
      throw new Error("task.id is required");
    }
    if (typeof task.title !== "string" || task.title.length === 0) {
      throw new Error(`task.title is required for ${task.id}`);
    }
    if (!Array.isArray(task.must_requirement_ids) || task.must_requirement_ids.length === 0) {
      throw new Error(`task.must_requirement_ids must be non-empty for ${task.id}`);
    }

    validateStageOverrideMap(task.stage_overrides, `task(${task.id}).stage_overrides`);

    if (task.config_overrides !== undefined) {
      if (
        typeof task.config_overrides !== "object" ||
        task.config_overrides === null ||
        Array.isArray(task.config_overrides)
      ) {
        throw new Error(`task(${task.id}).config_overrides must be an object`);
      }
      for (const [configId, stageMap] of Object.entries(task.config_overrides)) {
        if (!CONFIG_IDS.includes(configId)) {
          throw new Error(`task(${task.id}).config_overrides has unsupported config ${configId}`);
        }
        validateStageOverrideMap(stageMap, `task(${task.id}).config_overrides.${configId}`);
      }
    }
  }
}

function loadTaskset(root, tasksetRef) {
  const abs = resolveWithinRepo(tasksetRef, root);
  if (!existsSync(abs)) {
    throw new Error(`Taskset not found: ${tasksetRef}`);
  }
  const taskset = readJsonStrict(abs);
  validateTasksetSchema({
    root,
    tasksetPath: tasksetRef,
    taskset,
  });
  validateTaskset(taskset);
  return { abs, rel: toWorkspaceRelative(abs, root), taskset };
}

function applyConfigToPipelineState(root, configId, mode) {
  const statePath = resolve(root, ".pipeline/pipeline-state.json");
  const state = readJsonStrict(statePath);

  const featureFlags = state?.config?.feature_flags ?? {};
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

  const policy = state?.config?.orchestration_policy ?? {};
  policy.max_reviewers =
    configId === "phased_plus_reviewers" ? 3 : configId === "baseline_single_agent" ? 1 : 2;
  policy.max_builders = configId === "baseline_single_agent" ? 1 : 2;

  state.config = state.config ?? {};
  state.config.feature_flags = featureFlags;
  state.config.orchestration_policy = policy;

  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
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

  runCommand("node", ["scripts/pipeline/runner.mjs", "summarize-run", "--run-id", runId], {
    cwd: root,
  });

  return { failed };
}

function main() {
  const args = parseArgs(process.argv);
  const root = resolve(args.root);
  const { taskset, tasksetRel } = (() => {
    const loaded = loadTaskset(root, args.taskset);
    return { taskset: loaded.taskset, tasksetRel: loaded.rel };
  })();

  const evalDir = resolve(root, ".pipeline/evaluations", args.evalId);
  const matrixPath = resolve(evalDir, "matrix.json");
  const reportPath = resolve(evalDir, "evaluation-report.json");
  mkdirSync(evalDir, { recursive: true });

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

  const matrix = {
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

  writeJson(matrixPath, matrix);

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

try {
  main();
} catch (error) {
  const code = error?.code || "E_EVAL_RUN_MATRIX";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}
