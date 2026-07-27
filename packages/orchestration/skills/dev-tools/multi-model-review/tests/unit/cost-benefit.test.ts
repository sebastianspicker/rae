/**
 * Exercises deterministic risk and remediation-cost ranking used to prioritize review findings.
 */
import { describe, it, expect } from "vitest";
import { analyzeCostBenefit } from "../../src/lib/cost-benefit.js";
import type { Finding } from "../../src/lib/models/types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f-1",
    category: "correctness",
    description: "A finding",
    severity: "medium",
    ...overrides,
  };
}

describe("analyzeCostBenefit", () => {
  it("maps critical severity to catastrophic risk and fix-now recommendation", () => {
    const findings = [makeFinding({ id: "c-1", severity: "critical" })];
    const result = analyzeCostBenefit(findings);

    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("critical");
    expect(result[0]?.risk_of_ignoring).toBe("catastrophic");
    expect(result[0]?.recommendation).toBe("fix-now");
  });

  it("maps high severity to high risk", () => {
    const findings = [makeFinding({ id: "h-1", severity: "high" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.risk_of_ignoring).toBe("high");
  });

  it("maps medium severity to moderate risk", () => {
    const findings = [makeFinding({ id: "m-1", severity: "medium" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.risk_of_ignoring).toBe("moderate");
  });

  it("maps low severity to low risk with accept recommendation", () => {
    const findings = [makeFinding({ id: "l-1", severity: "low" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.risk_of_ignoring).toBe("low");
    expect(result[0]?.recommendation).toBe("accept");
  });

  it("maps info severity to negligible risk", () => {
    const findings = [makeFinding({ id: "i-1", severity: "info" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.risk_of_ignoring).toBe("negligible");
  });

  it("estimates high fix cost for architecture category", () => {
    const findings = [makeFinding({ id: "a-1", category: "architecture", severity: "high" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.fix_cost).toBe("high");
    expect(result[0]?.recommendation).toBe("fix-before-ship");
  });

  it("estimates high fix cost for feasibility category", () => {
    const findings = [makeFinding({ id: "f-1", category: "feasibility", severity: "critical" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.fix_cost).toBe("prohibitive");
    expect(result[0]?.recommendation).toBe("fix-now");
  });

  it("uses trivial fix cost for short low-complexity findings", () => {
    const findings = [
      makeFinding({ id: "t-1", description: "Rename typo in heading", severity: "low" }),
    ];
    const result = analyzeCostBenefit(findings);
    expect(result[0]?.fix_cost).toBe("trivial");
  });

  it("returns empty array for empty input", () => {
    expect(analyzeCostBenefit([])).toEqual([]);
  });

  it("preserves finding_id linkage", () => {
    const findings = [makeFinding({ id: "alpha" }), makeFinding({ id: "beta" })];
    const result = analyzeCostBenefit(findings);

    expect(result[0]?.finding_id).toBe("alpha");
    expect(result[1]?.finding_id).toBe("beta");
  });
});
