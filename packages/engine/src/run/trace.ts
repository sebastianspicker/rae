/**
 * Persists and summarizes bounded pipeline trace events without exposing malformed state.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureRunDirs, getRepoRoot, getRunDir, toWorkspaceRelative, writeJson } from "./state.js";
import { badInput, badTrace } from "../primitives/errors.js";
import { SKILL_ENTRYPOINTS } from "./constants.js";
import { spawnSkillTool } from "./subprocess.js";

/** Maximum number of trace events allowed per run. */
export const MAX_TRACE_EVENTS = 10000;
export const TRACE_SCHEMA_REFERENCE =
  "packages/contracts/v1/schemas/artifacts/execution-trace.schema.json";

export interface TracePayload extends Record<string, unknown> {
  event?: unknown;
  phase?: unknown;
  ts?: unknown;
}

export interface TraceEvent extends Record<string, unknown> {
  seq: number;
  event_id: string;
  run_id: string;
  event: unknown;
  phase: unknown;
  ts: unknown;
}

interface TraceCache {
  runId: string | null;
  root: string | null;
  events: TraceEvent[] | null;
}

/** Module-level trace event cache. */
let _traceCache: TraceCache = { runId: null, root: null, events: null };

/** Invalidate the trace event cache (exported for testing). */
export function invalidateTraceCache(): void {
  _traceCache = { runId: null, root: null, events: null };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getTracePath(runId: string, root = getRepoRoot()): string {
  return resolve(getRunDir(runId, root), "trace.jsonl");
}

export function ensureTraceFile(runId: string, root = getRepoRoot()): string {
  ensureRunDirs(runId, root);
  const tracePath = getTracePath(runId, root);
  // Opening in append mode atomically creates a missing file without ever
  // truncating an event written by another process racing to initialize it.
  closeSync(openSync(tracePath, "a", 0o600));
  return tracePath;
}

/**
 * Appends one validated trace event while bounding retained history for predictable runner state.
 */
export function appendTraceEvent(
  runId: string,
  payload: TracePayload,
  root = getRepoRoot(),
): TracePayload & { ts: unknown; run_id: string } {
  if (!payload || typeof payload !== "object") {
    throw badInput("trace payload must be an object");
  }
  if (!payload.event) {
    throw badInput("trace payload requires event");
  }
  if (!payload.phase) {
    throw badInput("trace payload requires phase");
  }

  const event = {
    ...payload,
    ts: payload.ts ?? nowIso(),
    run_id: runId,
  };

  const tracePath = ensureTraceFile(runId, root);
  appendFileSync(tracePath, `${JSON.stringify(event)}\n`, "utf8");
  invalidateTraceCache();
  return event;
}

export function readTraceEvents(runId: string, root = getRepoRoot()): TraceEvent[] {
  const tracePath = ensureTraceFile(runId, root);
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw.split("\n");

  const events: TraceEvent[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("trace event must be a JSON object");
      }
      // The physical JSONL line number is the replay cursor.  Older traces did
      // not persist a cursor, so project one without rewriting history.
      const seq = idx + 1;
      events.push({
        ...(parsed as Record<string, unknown>),
        seq,
        event_id:
          "event_id" in parsed && typeof parsed.event_id === "string"
            ? parsed.event_id
            : `${runId}:${seq}`,
        run_id: "run_id" in parsed ? (parsed.run_id as string) : runId,
        event: "event" in parsed ? parsed.event : undefined,
        phase: "phase" in parsed ? parsed.phase : undefined,
        ts: "ts" in parsed ? parsed.ts : undefined,
      } as TraceEvent);
    } catch (error) {
      throw badTrace(`corrupt trace JSONL at line ${idx + 1}: ${String(error)}`);
    }
  }

  if (events.length > MAX_TRACE_EVENTS) {
    throw badTrace(
      `trace file exceeds MAX_TRACE_EVENTS (${MAX_TRACE_EVENTS}): found ${events.length} events`,
    );
  }

  return events;
}

/**
 * Projects trace events into the deliberately small, replay-safe operator stream.
 * Raw messages, prompts, paths, and provider metadata remain private evidence.
 */
export function projectOperatorEvents(
  runId: string,
  root = getRepoRoot(),
): Array<Record<string, unknown>> {
  if (!existsSync(getTracePath(runId, root))) {
    throw badTrace(`operator trace does not exist for run: ${runId}`);
  }
  return readTraceEvents(runId, root).map((event) => {
    const projected: Record<string, unknown> = {
      seq: event.seq,
      event_id: event.event_id,
      run_id: event.run_id,
      ts: event.ts,
      event: event.event,
      phase: event.phase,
    };
    for (const key of ["status", "tier", "artifact_ref", "gate_id"]) {
      if (typeof event[key] === "string") projected[key] = event[key];
    }
    return projected;
  });
}

/**
 * Return cached trace events for the given runId, reading from disk only on miss.
 */
export function getCachedTraceEvents(runId: string, root = getRepoRoot()): TraceEvent[] {
  const resolvedRoot = resolve(root);
  if (
    _traceCache.runId === runId &&
    _traceCache.root === resolvedRoot &&
    _traceCache.events !== null
  ) {
    return _traceCache.events;
  }
  const events = readTraceEvents(runId, root);
  _traceCache = { runId, root: resolvedRoot, events };
  return events;
}

export function hasEvent(runId: string, eventType: unknown, root = getRepoRoot()): boolean {
  const events = getCachedTraceEvents(runId, root);
  return events.some((event) => event.event === eventType);
}

function runTraceCollector(runId: string, root = getRepoRoot()): unknown {
  return spawnSkillTool({
    entrypoint: SKILL_ENTRYPOINTS.trace_collector,
    input: {
      run_id: runId,
      trace_path: toWorkspaceRelative(getTracePath(runId, root), root),
      schema_ref: TRACE_SCHEMA_REFERENCE,
    },
    root,
    toolName: "trace-collector",
  });
}

export function summarizeRun(runId: string, root = getRepoRoot()): Record<string, unknown> {
  ensureRunDirs(runId, root);
  const traceData = runTraceCollector(runId, root);
  if (!traceData || typeof traceData !== "object" || Array.isArray(traceData)) {
    throw badTrace("trace collector returned a non-object result");
  }
  const record = traceData as Record<string, unknown>;
  const summary =
    record.summary && typeof record.summary === "object" && !Array.isArray(record.summary)
      ? (record.summary as Record<string, unknown>)
      : {};
  const summaryPath = resolve(getRunDir(runId, root), "trace.summary.json");
  const output = {
    run_id: record.run_id,
    valid: record.valid,
    issues: record.issues,
    ...summary,
  };
  writeJson(summaryPath, output);
  return output;
}
