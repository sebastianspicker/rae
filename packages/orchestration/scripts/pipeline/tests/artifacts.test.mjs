import { describe, expect, it } from "vitest";
import { PHASE_ORDER } from "../../lib/constants.mjs";
import {
  buildArtifactForPhase,
  DEFAULT_SCHEMA_BY_PHASE,
  defaultRequirementIds,
  driftStatusForConfig,
  phaseArtifactDefaults,
} from "../lib/artifacts.mjs";

describe("phaseArtifactDefaults", () => {
  it("returns correct defaults for arm", () => {
    const { artifactRef, schemaRef } = phaseArtifactDefaults("arm");
    expect(artifactRef).toBe("brief.json");
    expect(schemaRef).toBe("contracts/artifacts/brief.schema.json");
  });

  it("returns correct defaults for design", () => {
    const { artifactRef, schemaRef } = phaseArtifactDefaults("design");
    expect(artifactRef).toBe("design.json");
    expect(schemaRef).toContain("design-document");
  });

  it("returns correct defaults for plan", () => {
    const { artifactRef, schemaRef } = phaseArtifactDefaults("plan");
    expect(artifactRef).toBe("plan.json");
    expect(schemaRef).toContain("execution-plan");
  });

  it("returns build-report schema for build phase", () => {
    const { artifactRef, schemaRef } = phaseArtifactDefaults("build");
    expect(artifactRef).toBe("build.json");
    expect(schemaRef).toBe("contracts/artifacts/build-report.schema.json");
  });

  it("returns null artifactRef for post-build phase", () => {
    const { artifactRef, schemaRef } = phaseArtifactDefaults("post-build");
    expect(artifactRef).toBeNull();
    expect(schemaRef).toBeNull();
  });

  it("handles all phases in PHASE_ORDER without throwing", () => {
    for (const phase of PHASE_ORDER) {
      expect(() => phaseArtifactDefaults(phase)).not.toThrow();
    }
  });

  it("throws for unknown phases", () => {
    expect(() => phaseArtifactDefaults("nonexistent")).toThrow(/unknown phase/i);
    expect(() => phaseArtifactDefaults("")).toThrow(/unknown phase/i);
  });
});

describe("DEFAULT_SCHEMA_BY_PHASE", () => {
  it("has schema entries for phases that need them", () => {
    expect(DEFAULT_SCHEMA_BY_PHASE.arm).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE.design).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE["adversarial-review"]).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE.plan).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE.pmatch).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE["quality-static"]).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE["quality-tests"]).toBeDefined();
    expect(DEFAULT_SCHEMA_BY_PHASE["release-readiness"]).toBeDefined();
  });

  it("all schema paths point to contracts/artifacts/", () => {
    for (const [_phase, schemaPath] of Object.entries(DEFAULT_SCHEMA_BY_PHASE)) {
      expect(schemaPath).toMatch(/^contracts\/artifacts\/.+\.schema\.json$/);
    }
  });
});

describe("buildArtifactForPhase", () => {
  const baseConfig = {
    runId: "test-run",
    configId: "phased_default",
    task: { id: "t1", must_requirement_ids: ["REQ-001"] },
    stageProfile: {},
    budget: null,
  };

  it("builds arm artifact with requirements", () => {
    const result = buildArtifactForPhase({ ...baseConfig, phase: "arm" });
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0].id).toBe("REQ-001");
    expect(result.open_questions).toEqual([]);
  });

  it("builds design artifact with constraints", () => {
    const result = buildArtifactForPhase({ ...baseConfig, phase: "design" });
    expect(result.analysis).toBeDefined();
    expect(result.constraints_classification).toHaveLength(1);
  });

  it("builds adversarial-review artifact with reviewers", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "adversarial-review",
    });
    expect(result.reviewers).toHaveLength(3);
    expect(result.deduplicated_findings).toHaveLength(1);
  });

  it("builds plan artifact with task groups", () => {
    const result = buildArtifactForPhase({ ...baseConfig, phase: "plan" });
    expect(result.task_groups).toHaveLength(1);
    expect(result.task_groups[0].tasks[0].covers_requirement_ids).toContain("REQ-001");
    expect(result.task_groups[0].tasks[0].context_manifest).toBeDefined();
    expect(result.task_groups[0].tasks[0].test_cases[0].context_manifest).toBeDefined();
  });

  it("builds pmatch artifact with claims", () => {
    const result = buildArtifactForPhase({ ...baseConfig, phase: "pmatch" });
    expect(result.claims).toHaveLength(1);
    expect(result.adjudication).toBeDefined();
  });

  it("builds build artifact with outputs", () => {
    const result = buildArtifactForPhase({ ...baseConfig, phase: "build" });
    expect(result.summary).toBeDefined();
    expect(result.outputs.length).toBeGreaterThan(0);
  });

  it("builds quality-static artifact", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "quality-static",
    });
    expect(result.audit_type).toBe("static");
    expect(result.violations).toEqual([]);
  });

  it("builds quality-tests artifact", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "quality-tests",
    });
    expect(result.audit_type).toBe("tests");
    expect(result.coverage_ledger).toBeDefined();
    expect(result.qc_summary).toBeDefined();
  });

  it("builds release-readiness artifact", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "release-readiness",
    });
    expect(result.release_decision).toBe("go");
    expect(result.approvals).toHaveLength(1);
  });

  it("returns null for post-build phase", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "post-build",
    });
    expect(result).toBeNull();
  });

  it("returns null for unknown phase", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "nonexistent",
    });
    expect(result).toBeNull();
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
  ])("does not dispatch through the unsafe phase key %s", (phase) => {
    expect(buildArtifactForPhase({ ...baseConfig, phase })).toBeNull();
  });

  it("includes context_manifest when budget is provided", () => {
    const result = buildArtifactForPhase({
      ...baseConfig,
      phase: "arm",
      budget: { token_max: 4000, files_max: 10 },
    });
    expect(result.context_manifest).toBeDefined();
    expect(result.context_manifest.token_estimate).toBeDefined();
  });
});

describe("defaultRequirementIds", () => {
  it("extracts must_requirement_ids from task", () => {
    expect(defaultRequirementIds({ must_requirement_ids: ["R1", "R2"] })).toEqual(["R1", "R2"]);
  });

  it("falls back to REQ-001 for empty task", () => {
    expect(defaultRequirementIds(null)).toEqual(["REQ-001"]);
    expect(defaultRequirementIds({})).toEqual(["REQ-001"]);
    expect(defaultRequirementIds({ must_requirement_ids: [] })).toEqual(["REQ-001"]);
  });

  it("filters non-string ids", () => {
    expect(defaultRequirementIds({ must_requirement_ids: ["R1", "", null, "R2"] })).toEqual([
      "R1",
      "R2",
    ]);
  });
});

describe("driftStatusForConfig", () => {
  it("returns stageProfile override when present", () => {
    expect(driftStatusForConfig("phased_default", { drift_status: "verified" })).toBe("verified");
  });

  it("returns violated for baseline_single_agent", () => {
    expect(driftStatusForConfig("baseline_single_agent", {})).toBe("violated");
  });

  it("returns verified for phased_dual_extractor_drift", () => {
    expect(driftStatusForConfig("phased_dual_extractor_drift", {})).toBe("verified");
  });

  it("returns partial for context-budget config", () => {
    expect(driftStatusForConfig("phased_with_context_budgets", {})).toBe("partial");
  });

  it("returns partial for unknown config", () => {
    expect(driftStatusForConfig("unknown", {})).toBe("partial");
  });
});
