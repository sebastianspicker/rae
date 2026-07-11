import { describe, expect, it } from "vitest";
import { aggregateMetrics, gatePassRate } from "../../eval/aggregate.mjs";

describe("evaluation aggregation key safety", () => {
  it.each(["__proto__", "constructor", "toString"])("rejects unsafe gate phase %s", (phase) => {
    expect(() => gatePassRate([{ phase, status: "pass" }])).toThrow("unsafe key");
  });

  it("preserves plain JSON objects for accepted configuration IDs", () => {
    const metrics = aggregateMetrics([
      {
        id: "phased_default",
        runs: [{ success: true, gate_results: [{ phase: "arm", status: "pass" }] }],
      },
    ]);

    expect(metrics.pipeline_success_rate).toEqual({ phased_default: 1 });
    expect(metrics.gate_pass_rate_by_phase).toEqual({
      phased_default: { arm: 1 },
    });
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics);
  });
});
