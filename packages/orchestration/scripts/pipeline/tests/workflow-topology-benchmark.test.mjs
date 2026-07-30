/** Verifies the deterministic topology fixture and its deliberately narrow claims. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const benchmark = resolve(import.meta.dirname, "../../eval/workflow-topology-benchmark.mjs");

describe("workflow topology benchmark", () => {
  test("reports stable order, critical paths, idle time, and no model-quality claim", () => {
    const result = JSON.parse(execFileSync(process.execPath, [benchmark], { encoding: "utf8" }));
    expect(result.fixture_id).toBe("workflow-topology-order-v1");
    expect(result.measurements.streaming_critical_path_ms).toBe(14);
    expect(result.measurements.barrier_critical_path_ms).toBe(18);
    expect(result.measurements.barrier_idle_time_ms).toBe(8);
    expect(
      result.measurements.event_order.map(
        ({ event, item_key: key }) => `${event}:${key ?? "entry"}`,
      ),
    ).toEqual([
      "entry_completed:entry",
      "first_stage_completed:b",
      "first_stage_completed:c",
      "first_stage_completed:a",
      "stream_stage_completed:c",
      "stream_stage_completed:b",
      "stream_stage_completed:a",
    ]);
    expect(result.interpretation).toMatchObject({
      model_quality_claim: false,
      universal_speed_claim: false,
    });
  });
});
