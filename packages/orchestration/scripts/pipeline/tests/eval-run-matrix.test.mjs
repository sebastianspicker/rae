/**
 * Exercises matrix execution and taskset validation to keep evaluation runs isolated and reproducible.
 */
import { describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const SOURCE_ROOT = resolve(import.meta.dirname, "../../..");
const NODE_MODULE_PATHS = [
  "node_modules",
  "skills/dev-tools/_shared/node_modules",
  "skills/dev-tools/quality-gate/node_modules",
  "skills/dev-tools/multi-model-review/node_modules",
  "skills/dev-tools/trace-collector/node_modules",
];

function makeIsolatedRoot(baseDir) {
  const fixtureRoot = join(baseDir, "orchestration");
  cpSync(SOURCE_ROOT, fixtureRoot, {
    recursive: true,
    filter(source) {
      return ![".cache", ".pipeline", "node_modules"].includes(basename(source));
    },
  });

  for (const relativePath of NODE_MODULE_PATHS) {
    const source = join(SOURCE_ROOT, relativePath);
    if (existsSync(source)) {
      symlinkSync(source, join(fixtureRoot, relativePath), "dir");
    }
  }
  return fixtureRoot;
}

describe("run-matrix end-to-end", { timeout: 60_000 }, () => {
  it("closes each abandoned failed run without touching another pipeline root", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rae-matrix-failure-"));
    const fixtureRoot = makeIsolatedRoot(baseDir);
    const pipelineDir = join(fixtureRoot, ".pipeline");
    const runsDir = join(pipelineDir, "runs");
    const runMatrix = join(fixtureRoot, "scripts", "eval", "run-matrix.mjs");
    const defaultTaskset = join(fixtureRoot, "docs", "eval", "tasksets", "default.json");
    const sentinelRoot = join(baseDir, "concurrent-pipeline");
    const sentinelState = join(sentinelRoot, ".pipeline", "pipeline-state.json");
    const sentinelRun = join(sentinelRoot, ".pipeline", "runs", "sentinel", "keep.txt");
    const unique = `${process.pid}-${Date.now()}`;
    const evalId = `matrix-failure-${unique}`;
    const tasksetName = `matrix-failure-${unique}.json`;
    const tasksetPath = join(pipelineDir, tasksetName);
    const evalDir = join(pipelineDir, "evaluations", evalId);

    mkdirSync(join(sentinelRoot, ".pipeline", "runs", "sentinel"), { recursive: true });
    writeFileSync(sentinelState, '{"run_id":"sentinel"}\n', "utf8");
    writeFileSync(sentinelRun, "preserve\n", "utf8");

    try {
      mkdirSync(pipelineDir, { recursive: true });
      const taskset = JSON.parse(readFileSync(defaultTaskset, "utf8"));
      taskset.taskset_id = `matrix-failure-${unique}`;
      taskset.tasks[0].stage_overrides.arm.gate_status = "fail";
      writeFileSync(tasksetPath, `${JSON.stringify(taskset, null, 2)}\n`, "utf8");

      const result = spawnSync(
        "node",
        [
          runMatrix,
          "--root",
          fixtureRoot,
          "--eval-id",
          evalId,
          "--taskset",
          `.pipeline/${tasksetName}`,
          "--mode",
          "enforce",
        ],
        { cwd: fixtureRoot, encoding: "utf8", timeout: 25_000 },
      );

      expect(result.status).toBe(1);
      expect(result.error).toBeUndefined();
      const matrix = JSON.parse(readFileSync(join(evalDir, "matrix.json"), "utf8"));
      expect(matrix.run_meta).toHaveLength(4);
      expect(matrix.run_meta.every((entry) => entry.failed === true)).toBe(true);

      for (const entry of matrix.run_meta) {
        const runDir = join(runsDir, entry.run_id);
        const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const runEnds = events.filter((event) => event.event === "run_end");
        const errorIndex = events.findLastIndex((event) => event.event === "error");
        const runEndIndex = events.findLastIndex((event) => event.event === "run_end");
        const summary = JSON.parse(readFileSync(join(runDir, "trace.summary.json"), "utf8"));

        expect(runEnds).toHaveLength(1);
        expect(runEnds[0].status).toBe("error");
        expect(runEnds[0].metadata.source).toBe("eval-run-matrix");
        expect(runEndIndex).toBeGreaterThan(errorIndex);
        expect(summary.total_wall_clock_s).toBeTypeOf("number");
      }

      expect(readFileSync(sentinelState, "utf8")).toBe('{"run_id":"sentinel"}\n');
      expect(readFileSync(sentinelRun, "utf8")).toBe("preserve\n");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("completes the default taskset across every configuration", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rae-matrix-success-"));
    const fixtureRoot = makeIsolatedRoot(baseDir);
    const pipelineDir = join(fixtureRoot, ".pipeline");
    const runsDir = join(pipelineDir, "runs");
    const runMatrix = join(fixtureRoot, "scripts", "eval", "run-matrix.mjs");
    const evalId = `matrix-success-${process.pid}-${Date.now()}`;
    const evalDir = join(pipelineDir, "evaluations", evalId);

    try {
      const result = spawnSync(
        "node",
        [runMatrix, "--root", fixtureRoot, "--eval-id", evalId, "--mode", "shadow"],
        { cwd: fixtureRoot, encoding: "utf8", timeout: 50_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.total_runs).toBe(4);
      expect(output.failed_runs).toBe(0);

      const matrix = JSON.parse(readFileSync(join(evalDir, "matrix.json"), "utf8"));
      expect(matrix.run_meta).toHaveLength(4);
      expect(matrix.run_meta.every((entry) => entry.failed === false)).toBe(true);
      expect(existsSync(join(evalDir, "evaluation-report.json"))).toBe(true);

      for (const entry of matrix.run_meta) {
        const runDir = join(runsDir, entry.run_id);
        const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const runEnds = events.filter((event) => event.event === "run_end");
        const summary = JSON.parse(readFileSync(join(runDir, "trace.summary.json"), "utf8"));

        expect(runEnds).toHaveLength(1);
        expect(runEnds[0].status).toBe("ok");
        expect(summary.total_wall_clock_s).toBeTypeOf("number");
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
