/**
 * Verifies trace persistence, bounded event retention, caching, and summary semantics for pipeline auditability.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendTraceEvent,
  getCachedTraceEvents,
  readTraceEvents,
  ensureTraceFile,
  invalidateTraceCache,
  MAX_TRACE_EVENTS,
  getTracePath,
  projectOperatorEvents,
} from "../lib/trace.mjs";
import { getRunDir, getRepoRoot, ensureRunDirs } from "../lib/state.mjs";

const root = getRepoRoot();
const testRunId = "test-trace-unit";

describe("appendTraceEvent and readTraceEvents", () => {
  beforeEach(() => {
    const runDir = getRunDir(testRunId, root);
    mkdirSync(resolve(runDir, "gates"), { recursive: true });
  });

  afterEach(() => {
    const runDir = getRunDir(testRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("appends and reads trace events", () => {
    appendTraceEvent(testRunId, {
      event: "phase_start",
      phase: "arm",
      status: "ok",
    });

    const events = readTraceEvents(testRunId);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("phase_start");
    expect(events[0].phase).toBe("arm");
    expect(events[0].run_id).toBe(testRunId);
    expect(events[0].ts).toBeDefined();
    expect(events[0].seq).toBe(1);
    expect(events[0].event_id).toBe(`${testRunId}:1`);
  });

  it("appends multiple events", () => {
    appendTraceEvent(testRunId, { event: "phase_start", phase: "arm" });
    appendTraceEvent(testRunId, { event: "phase_end", phase: "arm", status: "ok" });

    const events = readTraceEvents(testRunId);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("phase_start");
    expect(events[1].event).toBe("phase_end");
  });

  it("rejects payload without event field", () => {
    expect(() => appendTraceEvent(testRunId, { phase: "arm" })).toThrow(/requires event/);
  });

  it("rejects payload without phase field", () => {
    expect(() => appendTraceEvent(testRunId, { event: "phase_start" })).toThrow(/requires phase/);
  });

  it("rejects non-object payload", () => {
    expect(() => appendTraceEvent(testRunId, "string")).toThrow(/must be an object/);
    expect(() => appendTraceEvent(testRunId, null)).toThrow(/must be an object/);
  });
});

describe("operator trace projection", () => {
  const runId = "test-operator-projection";

  afterEach(() => {
    rmSync(getRunDir(runId, root), { recursive: true, force: true });
  });

  it("uses physical line cursors and excludes private message and metadata fields", () => {
    ensureRunDirs(runId, root);
    const tracePath = getTracePath(runId, root);
    writeFileSync(
      tracePath,
      `\n${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", run_id: runId, event: "agent_call", phase: "arm", status: "ok", message: "private", metadata: { prompt: "private" } })}\n`,
      "utf8",
    );

    expect(projectOperatorEvents(runId, root)).toEqual([
      {
        seq: 2,
        event_id: `${runId}:2`,
        run_id: runId,
        ts: "2026-01-01T00:00:00.000Z",
        event: "agent_call",
        phase: "arm",
        status: "ok",
      },
    ]);
  });
});

describe("ensureTraceFile", () => {
  const ensureRunId = "test-ensure-trace";

  afterEach(() => {
    const runDir = getRunDir(ensureRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("creates trace file if it does not exist", () => {
    const tracePath = ensureTraceFile(ensureRunId);
    expect(existsSync(tracePath)).toBe(true);
    expect(readFileSync(tracePath, "utf8")).toBe("");
  });
});

describe("readTraceEvents with corrupt JSONL", () => {
  const corruptRunId = "test-trace-corrupt";

  beforeEach(() => {
    ensureRunDirs(corruptRunId, root);
  });

  afterEach(() => {
    const runDir = getRunDir(corruptRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("fails on corrupt JSONL lines with a trace error", () => {
    const tracePath = getTracePath(corruptRunId, root);
    const content = [
      JSON.stringify({
        ts: "2026-01-01T00:00:00.000Z",
        run_id: corruptRunId,
        event: "phase_start",
        phase: "arm",
      }),
      "NOT VALID JSON {{{",
      "",
      JSON.stringify({
        ts: "2026-01-01T00:00:01.000Z",
        run_id: corruptRunId,
        event: "phase_end",
        phase: "arm",
        status: "ok",
      }),
      "also broken",
    ].join("\n");
    writeFileSync(tracePath, content, "utf8");

    expect(() => readTraceEvents(corruptRunId, root)).toThrow(/corrupt trace JSONL at line 2/);
  });
});

describe("readTraceEvents MAX_TRACE_EVENTS limit", () => {
  const overflowRunId = "test-trace-overflow";

  beforeEach(() => {
    ensureRunDirs(overflowRunId, root);
  });

  afterEach(() => {
    const runDir = getRunDir(overflowRunId, root);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("throws when events exceed MAX_TRACE_EVENTS", () => {
    expect(MAX_TRACE_EVENTS).toBe(10000);

    const tracePath = getTracePath(overflowRunId, root);
    const event = JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z",
      run_id: overflowRunId,
      event: "phase_start",
      phase: "arm",
    });
    // Write MAX_TRACE_EVENTS + 1 lines
    const lines = `${new Array(MAX_TRACE_EVENTS + 1).fill(event).join("\n")}\n`;
    writeFileSync(tracePath, lines, "utf8");

    expect(() => readTraceEvents(overflowRunId, root)).toThrow(/exceeds MAX_TRACE_EVENTS/);
  });
});

describe("getCachedTraceEvents", () => {
  const cacheRunId = "test-trace-cache";
  let alternateRoot;

  beforeEach(() => {
    invalidateTraceCache();
    ensureRunDirs(cacheRunId, root);
    alternateRoot = resolve(root, ".pipeline-test-alt-root");
    ensureRunDirs(cacheRunId, alternateRoot);
  });

  afterEach(() => {
    invalidateTraceCache();
    rmSync(getRunDir(cacheRunId, root), { recursive: true, force: true });
    rmSync(alternateRoot, { recursive: true, force: true });
  });

  it("separates cache entries by runId and root", () => {
    appendTraceEvent(cacheRunId, { event: "phase_start", phase: "arm" }, root);
    appendTraceEvent(cacheRunId, { event: "phase_start", phase: "design" }, alternateRoot);

    const primaryEvents = getCachedTraceEvents(cacheRunId, root);
    const alternateEvents = getCachedTraceEvents(cacheRunId, alternateRoot);

    expect(primaryEvents).toHaveLength(1);
    expect(primaryEvents[0].phase).toBe("arm");
    expect(alternateEvents).toHaveLength(1);
    expect(alternateEvents[0].phase).toBe("design");
  });
});
