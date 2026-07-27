/** Verifies provider phases accept only authorized concurrent operator transitions. */
import { describe, expect, it } from "vitest";
import { validateConcurrentOperatorChanges } from "../autonomous.mjs";

const beforeControl = {
  schema_version: "1.0.0",
  run_id: "run-1",
  status: "running",
  stop_requested: false,
  updated_at: "2026-07-17T10:00:00.000Z",
};
const beforeTrace =
  '{"event":"phase_start","phase":"build","status":"ok","ts":"2026-07-17T10:00:00.000Z","run_id":"run-1"}\n';

describe("provider/operator concurrency", () => {
  it("allows only a sticky stop request and its append-only trace event", () => {
    const afterControl = {
      ...beforeControl,
      status: "stop-requested",
      stop_requested: true,
      stop_requested_at: "2026-07-17T10:00:01.000Z",
      updated_at: "2026-07-17T10:00:01.000Z",
    };
    const afterTrace = `${beforeTrace}{"event":"run_stop_requested","phase":"build","status":"ok","ts":"2026-07-17T10:00:01.000Z","run_id":"run-1"}\n`;
    expect(() =>
      validateConcurrentOperatorChanges({
        beforeControl,
        afterControl,
        beforeTrace,
        afterTrace,
        runId: "run-1",
      }),
    ).not.toThrow();
  });

  it("rejects control rewrites and non-stop trace injection", () => {
    expect(() =>
      validateConcurrentOperatorChanges({
        beforeControl,
        afterControl: { ...beforeControl, status: "completed" },
        beforeTrace,
        afterTrace: beforeTrace,
        runId: "run-1",
      }),
    ).toThrow(/invalid operator-control transition/);
    expect(() =>
      validateConcurrentOperatorChanges({
        beforeControl,
        afterControl: beforeControl,
        beforeTrace,
        afterTrace: `${beforeTrace}{"event":"run_completed"}\n`,
        runId: "run-1",
      }),
    ).toThrow(/stop trace without stop control/);
  });

  it("rejects a stop trace attributed to a different active phase", () => {
    const afterControl = {
      ...beforeControl,
      status: "stop-requested",
      stop_requested: true,
      stop_requested_at: "2026-07-17T10:00:01.000Z",
      updated_at: "2026-07-17T10:00:01.000Z",
    };
    const afterTrace = `${beforeTrace}{"event":"run_stop_requested","phase":"post-build","status":"ok","ts":"2026-07-17T10:00:01.000Z","run_id":"run-1"}\n`;
    expect(() =>
      validateConcurrentOperatorChanges({
        beforeControl,
        afterControl,
        beforeTrace,
        afterTrace,
        runId: "run-1",
        expectedPhase: "build",
      }),
    ).toThrow(/non-stop operator trace event/);
  });
});
