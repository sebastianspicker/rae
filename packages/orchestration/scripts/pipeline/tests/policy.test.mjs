import { describe, it, expect } from "vitest";
import { decideFanout } from "../lib/policy.mjs";

describe("decideFanout", () => {
  it("returns fanout 1 for non-parallelizable phases", () => {
    const result = decideFanout({ phase: "arm" });
    expect(result.chosen_fanout).toBe(1);
    expect(result.max_fanout).toBe(1);
  });

  it("respects max_reviewers for adversarial-review", () => {
    const result = decideFanout({
      phase: "adversarial-review",
      policy: { max_reviewers: 3 },
      requestedFanout: 3,
    });
    expect(result.max_fanout).toBe(3);
    expect(result.chosen_fanout).toBeGreaterThanOrEqual(1);
    expect(result.chosen_fanout).toBeLessThanOrEqual(3);
  });

  it("respects max_builders for build phase", () => {
    const result = decideFanout({
      phase: "build",
      policy: { max_builders: 4 },
      requestedFanout: 4,
    });
    expect(result.max_fanout).toBe(4);
  });

  it("clamps fanout to max 12", () => {
    const result = decideFanout({
      phase: "adversarial-review",
      policy: { max_reviewers: 100 },
    });
    expect(result.max_fanout).toBe(12);
  });

  it("drops to 1 when budget is exceeded", () => {
    const result = decideFanout({
      phase: "adversarial-review",
      policy: { max_reviewers: 3, budget_usd: 10 },
      traceSummary: { total_cost_usd: 15 },
      requestedFanout: 3,
    });
    expect(result.chosen_fanout).toBe(1);
    expect(result.reason).toContain("budget");
  });

  it("drops to 1 when latency is exceeded", () => {
    const result = decideFanout({
      phase: "build",
      policy: { max_builders: 3, latency_budget_s: 60 },
      traceSummary: { total_duration_s: 120 },
      requestedFanout: 3,
    });
    expect(result.chosen_fanout).toBe(1);
    expect(result.reason).toContain("latency");
  });

  it("includes candidate scores in output", () => {
    const result = decideFanout({
      phase: "adversarial-review",
      policy: { max_reviewers: 3 },
      requestedFanout: 3,
    });
    expect(result.candidates).toBeInstanceOf(Array);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates[0]).toHaveProperty("fanout");
    expect(result.candidates[0]).toHaveProperty("delta");
  });

  it("returns structured thresholds and runtime totals", () => {
    const result = decideFanout({ phase: "arm" });
    expect(result.thresholds).toHaveProperty("lambda");
    expect(result.thresholds).toHaveProperty("mu");
    expect(result.runtime_totals).toHaveProperty("total_cost_usd");
    expect(result.runtime_totals).toHaveProperty("budget_exceeded");
  });

  it("handles all default parameters gracefully", () => {
    const result = decideFanout({ phase: "plan" });
    expect(result.chosen_fanout).toBe(1);
    expect(result.phase).toBe("plan");
    expect(result.reason).toBeDefined();
  });
});
