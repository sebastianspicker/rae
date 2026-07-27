/**
 * Persists and summarizes bounded pipeline trace events without exposing malformed state.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureRunDirs, getRepoRoot, getRunDir, toWorkspaceRelative, writeJson } from "./state.mjs";
import { badInput, badTrace } from "./errors.mjs";
import { SKILL_ENTRYPOINTS } from "../../lib/constants.mjs";
import { spawnSkillTool } from "./subprocess.mjs";

/** Maximum number of trace events allowed per run. */
export const MAX_TRACE_EVENTS = 10000;

/** Module-level trace event cache. */
let _traceCache = { runId: null, root: null, events: null };

/** Invalidate the trace event cache (exported for testing). */
export function invalidateTraceCache() {
  _traceCache = { runId: null, root: null, events: null };
}

export function nowIso() {
  return new Date().toISOString();
}

export function getTracePath(runId, root = getRepoRoot()) {
  return resolve(getRunDir(runId, root), "trace.jsonl");
}

export function ensureTraceFile(runId, root = getRepoRoot()) {
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
export function appendTraceEvent(runId, payload, root = getRepoRoot()) {
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

export function readTraceEvents(runId, root = getRepoRoot()) {
  const tracePath = ensureTraceFile(runId, root);
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw.split("\n");

  const events = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      // The physical JSONL line number is the replay cursor.  Older traces did
      // not persist a cursor, so project one without rewriting history.
      const seq = idx + 1;
      events.push({
        ...parsed,
        seq,
        event_id: typeof parsed.event_id === "string" ? parsed.event_id : `${runId}:${seq}`,
      });
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
export function projectOperatorEvents(runId, root = getRepoRoot()) {
  if (!existsSync(getTracePath(runId, root))) {
    throw badTrace(`operator trace does not exist for run: ${runId}`);
  }
  return readTraceEvents(runId, root).map((event) => {
    const projected = {
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
export function getCachedTraceEvents(runId, root = getRepoRoot()) {
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

export function hasEvent(runId, eventType, root = getRepoRoot()) {
  const events = getCachedTraceEvents(runId, root);
  return events.some((event) => event.event === eventType);
}

function runTraceCollector(runId, root = getRepoRoot()) {
  return spawnSkillTool({
    entrypoint: SKILL_ENTRYPOINTS.trace_collector,
    input: {
      run_id: runId,
      trace_path: toWorkspaceRelative(getTracePath(runId, root), root),
    },
    root,
    toolName: "trace-collector",
  });
}

export function summarizeRun(runId, root = getRepoRoot()) {
  ensureRunDirs(runId, root);
  const traceData = runTraceCollector(runId, root);
  const summaryPath = resolve(getRunDir(runId, root), "trace.summary.json");
  const output = {
    run_id: traceData.run_id,
    valid: traceData.valid,
    issues: traceData.issues,
    ...traceData.summary,
  };
  writeJson(summaryPath, output);
  return output;
}
