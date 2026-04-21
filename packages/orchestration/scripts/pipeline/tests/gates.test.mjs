import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  gateStatusRank,
  assertGateStatus,
  worstStatus,
  resolveGateOutputPath,
  emitGate,
  updateStateAfterArtifact,
  QUALITY_GATE_PHASES,
} from "../lib/gates.mjs";
import { getRunDir, getRepoRoot, ensureRunDirs } from "../lib/state.mjs";

describe("gateStatusRank", () => {
  it("ranks fail highest", () => {
    expect(gateStatusRank("fail")).toBe(3);
  });

  it("ranks warn middle", () => {
    expect(gateStatusRank("warn")).toBe(2);
  });

  it("ranks pass lowest", () => {
    expect(gateStatusRank("pass")).toBe(1);
  });

  it("throws for unknown status", () => {
    expect(() => gateStatusRank("unknown")).toThrow("unrecognized gate status");
  });

  it("throws E_BAD_INPUT for typo 'fial'", () => {
    expect(() => gateStatusRank("fial")).toThrow("unrecognized gate status");
    try {
      gateStatusRank("fial");
    } catch (err) {
      expect(err.code).toBe("E_BAD_INPUT");
    }
  });

  it("returns 1 for 'pass'", () => {
    expect(gateStatusRank("pass")).toBe(1);
  });

  it("returns 3 for 'fail'", () => {
    expect(gateStatusRank("fail")).toBe(3);
  });
});

describe("assertGateStatus", () => {
  it("accepts pass, warn, fail", () => {
    expect(() => assertGateStatus("pass")).not.toThrow();
    expect(() => assertGateStatus("warn")).not.toThrow();
    expect(() => assertGateStatus("fail")).not.toThrow();
  });

  it("rejects invalid status", () => {
    expect(() => assertGateStatus("invalid")).toThrow();
    expect(() => assertGateStatus("")).toThrow();
  });
});

describe("worstStatus", () => {
  it("returns fail when any status is fail", () => {
    expect(worstStatus("pass", "fail", "warn")).toBe("fail");
  });

  it("returns warn when worst is warn", () => {
    expect(worstStatus("pass", "warn")).toBe("warn");
  });

  it("returns pass when all pass", () => {
    expect(worstStatus("pass", "pass")).toBe("pass");
  });

  it("returns pass for empty input", () => {
    expect(worstStatus()).toBe("pass");
  });

  it("filters null/undefined values", () => {
    expect(worstStatus(null, "warn", undefined)).toBe("warn");
  });
});

describe("resolveGateOutputPath", () => {
  const root = getRepoRoot();
  const testRunId = "test-gates-resolve";

  beforeEach(() => {
    ensureRunDirs(testRunId, root);
  });

  afterEach(() => {
    const runDir = getRunDir(testRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("resolves valid gate file name", () => {
    const runDir = getRunDir(testRunId, root);
    const path = resolveGateOutputPath(runDir, "arm-gate.json");
    expect(path).toContain("gates");
    expect(path).toContain("arm-gate.json");
  });

  it("rejects empty gate file name", () => {
    const runDir = getRunDir(testRunId, root);
    expect(() => resolveGateOutputPath(runDir, "")).toThrow();
  });

  it("rejects gate file with path traversal", () => {
    const runDir = getRunDir(testRunId, root);
    expect(() => resolveGateOutputPath(runDir, "../escape.json")).toThrow();
  });
});

describe("QUALITY_GATE_PHASES", () => {
  it("includes all expected phases", () => {
    expect(QUALITY_GATE_PHASES.has("arm")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("design")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("adversarial-review")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("plan")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("pmatch")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("build")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("quality-static")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("quality-tests")).toBe(true);
    expect(QUALITY_GATE_PHASES.has("release-readiness")).toBe(true);
  });

  it("does not include post-build", () => {
    expect(QUALITY_GATE_PHASES.has("post-build")).toBe(false);
  });
});

describe("emitGate", () => {
  const root = getRepoRoot();
  const testRunId = "test-gates-emit";

  beforeEach(() => {
    ensureRunDirs(testRunId, root);
  });

  afterEach(() => {
    const runDir = getRunDir(testRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("writes gate file and returns gate object", () => {
    const gate = emitGate({
      runId: testRunId,
      phase: "arm",
      gateId: "arm-gate",
      status: "pass",
    });

    expect(gate.gate_id).toBe("arm-gate");
    expect(gate.phase).toBe("arm");
    expect(gate.status).toBe("pass");
    expect(gate.timestamp).toBeDefined();

    const gatePath = resolve(getRunDir(testRunId, root), "gates", "arm-gate.json");
    expect(existsSync(gatePath)).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(() =>
      emitGate({
        runId: testRunId,
        phase: "arm",
        gateId: "arm-gate",
        status: "invalid",
      }),
    ).toThrow();
  });

  it("rejects pass status with blocking_failures", () => {
    expect(() =>
      emitGate({
        runId: testRunId,
        phase: "arm",
        gateId: "arm-gate",
        status: "pass",
        blockingFailures: ["some-failure"],
      }),
    ).toThrow(/blockingFailures must be empty/);
  });

  it("rejects warn status with blocking_failures", () => {
    expect(() =>
      emitGate({
        runId: testRunId,
        phase: "arm",
        gateId: "arm-gate",
        status: "warn",
        blockingFailures: ["some-failure"],
      }),
    ).toThrow(/blockingFailures must be empty/);
  });
});

describe("updateStateAfterArtifact", () => {
  it("sets brief for arm phase", () => {
    const state = { artifacts: { brief: null } };
    updateStateAfterArtifact(state, "arm", "brief.json");
    expect(state.artifacts.brief).toBe("brief.json");
  });

  it("sets build for build phase", () => {
    const state = { artifacts: { build: null } };
    updateStateAfterArtifact(state, "build", "build.json");
    expect(state.artifacts.build).toBe("build.json");
  });

  it("sets release_readiness for release-readiness phase", () => {
    const state = { artifacts: { release_readiness: null } };
    updateStateAfterArtifact(state, "release-readiness", "release-readiness.json");
    expect(state.artifacts.release_readiness).toBe("release-readiness.json");
  });

  it("appends to drift_reports array for pmatch", () => {
    const state = { artifacts: { drift_reports: ["existing.json"] } };
    updateStateAfterArtifact(state, "pmatch", "new.json");
    expect(state.artifacts.drift_reports).toEqual(["existing.json", "new.json"]);
  });

  it("creates drift_reports array if not present", () => {
    const state = { artifacts: {} };
    updateStateAfterArtifact(state, "pmatch", "drift.json");
    expect(state.artifacts.drift_reports).toEqual(["drift.json"]);
  });

  it("appends to quality_reports array", () => {
    const state = { artifacts: { quality_reports: [] } };
    updateStateAfterArtifact(state, "quality-static", "static.json");
    expect(state.artifacts.quality_reports).toEqual(["static.json"]);
  });

  it("does nothing for unknown phase", () => {
    const state = { artifacts: {} };
    updateStateAfterArtifact(state, "nonexistent", "file.json");
    expect(state.artifacts).toEqual({});
  });
});
