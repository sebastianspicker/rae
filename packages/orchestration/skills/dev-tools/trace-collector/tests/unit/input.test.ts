import { describe, expect, it } from "vitest";
import { validateInput } from "../../src/lib/input.js";

describe("validateInput", () => {
  it("accepts trace_path input", () => {
    expect(() =>
      validateInput({
        run_id: "run-1",
        trace_path: ".pipeline/runs/run-1/trace.jsonl",
      }),
    ).not.toThrow();
  });

  it("accepts inline events input", () => {
    expect(() =>
      validateInput({
        run_id: "run-2",
        events: [
          {
            ts: "2026-02-22T00:00:00Z",
            run_id: "run-2",
            event: "run_start",
            phase: "arm",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("requires trace_path or events", () => {
    expect(() =>
      validateInput({
        run_id: "run-3",
      }),
    ).toThrow("Provide either trace_path or non-empty events array");
  });
});
