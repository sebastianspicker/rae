/**
 * Integration tests for the runner.mjs CLI: specifically the run-stage command.
 * These tests spawn runner.mjs as a subprocess to exercise the real entrypoint.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import { buildArtifactForPhase } from "../lib/artifacts.mjs";
import {
  initState,
  pipelineDirForTest,
  registerStateLifecycle,
  runDirForTest,
  runRunner,
  TEST_RUN_ID,
  writeEmptyBriefFixture,
  writeReviewLoopFixture,
  writeTasksetFixture,
  writeTraceabilityFixtures,
} from "./runner-stage.test-helpers.mjs";

registerStateLifecycle();

function runArm(inputArtifact) {
  const args = [
    "run-stage",
    "--run-id",
    TEST_RUN_ID,
    "--phase",
    "arm",
    "--config-id",
    "phased_default",
  ];
  if (inputArtifact) args.push("--input-artifact", inputArtifact);
  return runRunner(args);
}

function prepareTerminalReleaseState() {
  const statePath = join(pipelineDirForTest(), "pipeline-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.current_phase = "post-build";
  state.completed_gates = PHASE_ORDER.slice(0, -1).map((phase) => `${phase}-gate`);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  writeReviewLoopFixture();
}

function runReleaseReadiness() {
  return runRunner([
    "run-stage",
    "--run-id",
    TEST_RUN_ID,
    "--phase",
    "release-readiness",
    "--config-id",
    "phased_default",
  ]);
}

function persistedTraceEvents() {
  return readFileSync(join(runDirForTest(), "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function writeCallerQualityArtifact() {
  const artifact = buildArtifactForPhase({
    phase: "quality-tests",
    runId: TEST_RUN_ID,
    configId: "phased_default",
    task: { id: "task-1", must_requirement_ids: ["REQ-001"] },
    stageProfile: {},
    budget: null,
  });
  artifact.coverage_ledger.requirements[0].status = "missing";
  artifact.coverage_ledger.summary = {
    total_requirements: 1,
    covered_requirements: 0,
    partial_requirements: 0,
    missing_requirements: 1,
  };
  artifact.qc_summary = {
    headline: "Caller-supplied coverage remains authoritative.",
    coverage_status: "missing",
    covered_requirements: [],
    missing_requirement_ids: ["REQ-001"],
  };
  const inputPath = join(pipelineDirForTest(), "caller-quality.json");
  writeFileSync(inputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { artifact, inputPath };
}

describe("runner.mjs CLI", () => {
  describe("--help", () => {
    it("exits 0 and prints usage", () => {
      const result = runRunner(["--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("run-stage");
      expect(result.stdout).toContain("start-phase");
    });
  });

  describe("unknown command", () => {
    it("exits non-zero for unrecognized command", () => {
      const result = runRunner(["bogus-command"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unknown command");
    });

    it.each([
      "__proto__",
      "constructor",
      "toString",
    ])("rejects the unsafe command key %s", (command) => {
      const result = runRunner([command]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("command is not allowed");
    });

    it.each(["__proto__", "constructor", "toString"])("rejects the unsafe option key %s", (key) => {
      const result = runRunner(["run-stage", `--${key}`, "value"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("option name is not allowed");
    });
  });
});

describe("run-stage", () => {
  describe("input validation", () => {
    it("rejects unknown phase", () => {
      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "nonexistent",
        "--config-id",
        "phased_default",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported phase");
    });

    it("rejects unknown config-id", () => {
      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "arm",
        "--config-id",
        "bogus_config",
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported config-id");
    });

    it("rejects missing run-id", () => {
      const result = runRunner(["run-stage", "--phase", "arm", "--config-id", "phased_default"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("run-id");
    });

    it("rejects a phase when its predecessors have not completed", () => {
      initState();
      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "build",
        "--config-id",
        "phased_default",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("phase out of order: expected arm, received build");
      expect(existsSync(join(runDirForTest(), "build-report.json"))).toBe(false);
    });
  });

  describe("happy path: arm phase", () => {
    it("produces brief.json and arm-gate.json", () => {
      // Re-initialize state to ensure clean run
      initState();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "arm",
        "--config-id",
        "phased_default",
      ]);

      // The runner writes JSON to stdout; if empty, surface stderr for diagnostics
      if (!result.stdout && result.stderr) {
        throw new Error(`run-stage produced no stdout. stderr: ${result.stderr}`);
      }
      expect(result.stdout).toBeTruthy();
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.run_id).toBe(TEST_RUN_ID);
      expect(output.phase).toBe("arm");
      expect(output.config_id).toBe("phased_default");
      expect(output.activity_profile.activity_id).toBe("arm_briefing");
      expect(output.activity_profile.runtime_version).toBe("v1");
      expect(output.gate).toBeDefined();
      expect(output.gate.status).toMatch(/^(pass|warn)$/);

      // Verify artifact file was written
      const runDir = runDirForTest();
      const briefPath = join(runDir, "brief.json");
      expect(existsSync(briefPath)).toBe(true);
      const brief = JSON.parse(readFileSync(briefPath, "utf8"));
      expect(brief.requirements).toBeDefined();
      expect(Array.isArray(brief.requirements)).toBe(true);

      // Verify gate file was written
      const gatesDir = join(runDir, "gates");
      const gatePath = join(gatesDir, "arm-gate.json");
      expect(existsSync(gatePath)).toBe(true);
      const gate = JSON.parse(readFileSync(gatePath, "utf8"));
      expect(gate.gate_id).toBe("arm-gate");
      expect(gate.phase).toBe("arm");

      // Verify trace file has events
      const tracePath = join(runDir, "trace.jsonl");
      expect(existsSync(tracePath)).toBe(true);
      const traceLines = readFileSync(tracePath, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(traceLines.length).toBeGreaterThanOrEqual(2); // at least run_start + phase_start

      // Exit code should be 0 for a passing gate
      if (output.gate.status === "pass") {
        expect(result.status).toBe(0);
      }
    });

    it("fails arm when the brief has no requirements", () => {
      initState();
      const emptyBriefPath = writeEmptyBriefFixture();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "arm",
        "--config-id",
        "phased_default",
        "--input-artifact",
        emptyBriefPath,
      ]);

      const output = JSON.parse(result.stdout);
      expect(result.status).not.toBe(0);
      expect(output.success).toBe(false);
      expect(output.gate.status).toBe("fail");
      expect(
        output.gate.criteria.some((criterion) => criterion.name === "requirements-present"),
      ).toBe(true);
      const state = JSON.parse(
        readFileSync(join(pipelineDirForTest(), "pipeline-state.json"), "utf8"),
      );
      expect(state.completed_gates).not.toContain("arm-gate");
    });

    it("emits one final run_end after a failed phase is retried", () => {
      initState();
      const emptyBriefPath = writeEmptyBriefFixture();
      const failed = runArm(emptyBriefPath);
      expect(failed.status).not.toBe(0);

      const retry = runArm();
      expect(retry.status).toBe(0);

      prepareTerminalReleaseState();
      const terminal = runReleaseReadiness();
      expect(terminal.status).toBe(0);

      const events = persistedTraceEvents();
      const runEndIndexes = events.flatMap((event, index) =>
        event.event === "run_end" ? [index] : [],
      );
      const terminalPhaseEndIndex = events.findLastIndex(
        (event) => event.event === "phase_end" && event.phase === "release-readiness",
      );
      expect(runEndIndexes).toHaveLength(1);
      expect(runEndIndexes[0]).toBeGreaterThan(terminalPhaseEndIndex);
    });
  });

  describe("happy path: design phase", () => {
    it("runs arm then design successfully for phased_default", () => {
      initState();

      const armResult = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "arm",
        "--config-id",
        "phased_default",
      ]);
      expect(armResult.status).toBe(0);

      const designResult = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "design",
        "--config-id",
        "phased_default",
      ]);

      if (!designResult.stdout && designResult.stderr) {
        throw new Error(`design run-stage produced no stdout. stderr: ${designResult.stderr}`);
      }

      expect(designResult.status).toBe(0);
      const output = JSON.parse(designResult.stdout);
      expect(output.success).toBe(true);
      expect(output.phase).toBe("design");
      expect(output.gate.status).toBe("pass");
      expect(output.auxiliary_gates.every((gate) => gate.status !== "fail")).toBe(true);

      const runDir = runDirForTest();
      const designPath = join(runDir, "design.json");
      const contextBudgetGatePath = join(runDir, "gates", "design-context-budget-gate.json");
      expect(existsSync(designPath)).toBe(true);
      expect(existsSync(contextBudgetGatePath)).toBe(true);

      const contextBudgetGate = JSON.parse(readFileSync(contextBudgetGatePath, "utf8"));
      expect(contextBudgetGate.status).toBe("pass");
      expect(contextBudgetGate.schema_validation.valid).toBe(true);
    });
  });

  describe("state locking", () => {
    it("rejects live mutation paths when the state lock is already held", () => {
      initState();
      const lockPath = join(pipelineDirForTest(), "pipeline-state.lock");
      writeFileSync(lockPath, "", "utf8");

      try {
        const result = runRunner([
          "run-stage",
          "--run-id",
          TEST_RUN_ID,
          "--phase",
          "arm",
          "--config-id",
          "phased_default",
        ]);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("locked by another process");
      } finally {
        rmSync(lockPath, { force: true });
      }
    });
  });

  describe("task-fresh execution boundaries", () => {
    it("emits distinct build task-session trace events", () => {
      initState("build");
      writeTasksetFixture();
      writeTraceabilityFixtures();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "build",
        "--config-id",
        "phased_default",
        "--taskset",
        ".pipeline/runner-stage-taskset.json",
        "--task-id",
        "task-1",
      ]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.task_session).toEqual({
        session_id: "build-task-1",
        session_kind: "build-task",
        fresh_context: true,
        inherits_history: false,
        max_attempts: 2,
        retry_behavior: "restart-fresh-session",
      });
      expect(output.activity_profile.activity_id).toBe("build_worker");
      expect(output.activity_profile.model_hint).toBe("build-worker");

      const tracePath = join(runDirForTest(), "trace.jsonl");
      const events = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const start = events.find((event) => event.event === "task_session_start");
      const end = events.find((event) => event.event === "task_session_end");
      expect(start?.metadata?.task_session_id).toBe("build-task-1");
      expect(start?.metadata?.task_session_kind).toBe("build-task");
      expect(start?.metadata?.task_id).toBe("task-1");
      expect(end?.metadata?.task_session_id).toBe("build-task-1");
      expect(end?.status).toBe("ok");
    });

    it("emits distinct quality-case session trace events", () => {
      initState("quality-tests");
      writeTasksetFixture();
      writeTraceabilityFixtures();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "quality-tests",
        "--config-id",
        "phased_default",
        "--taskset",
        ".pipeline/runner-stage-taskset.json",
        "--task-id",
        "task-1",
        "--test-case-id",
        "quality-test-1",
      ]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.task_session).toEqual({
        session_id: "quality-case-runner-stage-smoke",
        session_kind: "quality-case",
        fresh_context: true,
        inherits_history: false,
        max_attempts: 2,
        retry_behavior: "restart-fresh-session",
      });
      expect(output.activity_profile.activity_id).toBe("quality_tests_case");
      expect(output.activity_profile.model_hint).toBe("quality-tests");

      const tracePath = join(runDirForTest(), "trace.jsonl");
      const events = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const start = events.find((event) => event.event === "task_session_start");
      const end = events.find((event) => event.event === "task_session_end");
      expect(start?.metadata?.task_session_id).toBe("quality-case-runner-stage-smoke");
      expect(start?.metadata?.task_session_kind).toBe("quality-case");
      expect(start?.metadata?.test_case_trace_id).toBe("quality-test-1");
      expect(end?.metadata?.task_session_id).toBe("quality-case-runner-stage-smoke");
      expect(end?.status).toBe("ok");

      const qualityReportPath = join(runDirForTest(), "quality-reports", "tests.json");
      const qualityReport = JSON.parse(readFileSync(qualityReportPath, "utf8"));
      expect(qualityReport.coverage_ledger.summary.covered_requirements).toBe(1);
      expect(qualityReport.qc_summary.coverage_status).toBe("complete");
    });

    it("preserves caller-supplied quality evidence instead of enriching it", () => {
      initState("quality-tests");
      writeTasksetFixture();
      writeTraceabilityFixtures();
      const caller = writeCallerQualityArtifact();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "quality-tests",
        "--config-id",
        "phased_default",
        "--input-artifact",
        caller.inputPath,
      ]);

      expect(result.status).not.toBe(0);
      const persisted = JSON.parse(
        readFileSync(join(runDirForTest(), "quality-reports", "tests.json"), "utf8"),
      );
      expect(persisted.coverage_ledger).toEqual(caller.artifact.coverage_ledger);
      expect(persisted.qc_summary).toEqual(caller.artifact.qc_summary);
    });
  });

  describe("release-readiness review-loop integration", () => {
    it("loads review-loop state into the release-readiness artifact", () => {
      initState("release-readiness");
      writeReviewLoopFixture();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "release-readiness",
        "--config-id",
        "phased_default",
      ]);

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.phase).toBe("release-readiness");

      const artifactPath = join(runDirForTest(), "release-readiness.json");
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      expect(artifact.review_loop_ref).toBe(".pipeline/runs/runner-stage-test/review-loop.json");
      expect(artifact.review_state.ship_status).toBe("approved");
      expect(artifact.review_state.explain_status).toBe("completed");
    });

    it("emits run_end on terminal completion and reports wall-clock time", () => {
      initState("release-readiness");
      writeReviewLoopFixture();

      const result = runRunner([
        "run-stage",
        "--run-id",
        TEST_RUN_ID,
        "--phase",
        "release-readiness",
        "--config-id",
        "phased_default",
      ]);

      expect(result.status).toBe(0);
      const tracePath = join(runDirForTest(), "trace.jsonl");
      const events = readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.some((event) => event.event === "run_end")).toBe(true);

      const summary = runRunner(["summarize-run", "--run-id", TEST_RUN_ID]);
      expect(summary.status).toBe(0);
      const output = JSON.parse(summary.stdout);
      expect(output.summary.total_wall_clock_s).toBeTypeOf("number");
      expect(output.summary.total_wall_clock_s).toBeGreaterThanOrEqual(0);
    });
  });
});
