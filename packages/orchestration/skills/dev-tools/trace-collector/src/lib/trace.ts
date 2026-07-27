/**
 * Loads, schema-validates, and summarizes pipeline traces within workspace boundaries.
 */
import { readFileSync } from "node:fs";
import { createAjvInstance, resolveWithinWorkspace } from "@coding-agents-space/shared";
import type { AjvValidateFunction } from "@coding-agents-space/shared";
import type { Input, TraceEvent, TraceResult, TraceSummary } from "../types.js";

interface TraceOptions {
  workspaceRoot?: string;
  schemaRoot?: string;
}

export function readJsonlEvents(tracePath: string): TraceEvent[] {
  const raw = readFileSync(tracePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as TraceEvent;
    } catch (error) {
      throw Object.assign(new Error(`Invalid JSONL at line ${idx + 1}: ${String(error)}`), {
        code: "E_BAD_TRACE",
      });
    }
  });
}

export function buildSummary(events: TraceEvent[], issues: string[]): TraceSummary {
  const eventsByType: Record<string, number> = {};
  const gateResults = { pass: 0, fail: 0, warn: 0 };
  const phaseStarts = new Map<string, number>();
  const phaseDurations: Record<string, number> = {};
  const activityResolutions = new Map<string, Record<string, unknown>>();

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;
  let failures = 0;
  let retries = 0;

  for (const event of events) {
    eventsByType[event.event] = (eventsByType[event.event] ?? 0) + 1;
    const activityId =
      typeof event.activity_id === "string"
        ? event.activity_id
        : typeof event.metadata?.activity_id === "string"
          ? event.metadata.activity_id
          : null;
    if (activityId) {
      const existing = activityResolutions.get(activityId) ?? {
        activity_id: activityId,
        tier:
          typeof event.tier === "string"
            ? event.tier
            : typeof event.metadata?.cognitive_tier === "string"
              ? event.metadata.cognitive_tier
              : undefined,
        model_hint:
          typeof event.model_hint === "string"
            ? event.model_hint
            : typeof event.metadata?.model_hint === "string"
              ? event.metadata.model_hint
              : undefined,
        runtime_name:
          typeof event.runtime_name === "string"
            ? event.runtime_name
            : typeof event.metadata?.runtime_name === "string"
              ? event.metadata.runtime_name
              : undefined,
        runtime_version:
          typeof event.runtime_version === "string"
            ? event.runtime_version
            : typeof event.metadata?.runtime_version === "string"
              ? event.metadata.runtime_version
              : undefined,
        count: 0,
      };
      existing.count = Number(existing.count ?? 0) + 1;
      activityResolutions.set(activityId, existing);
    }

    if (event.event === "phase_start") {
      const ts = Date.parse(event.ts);
      if (!Number.isNaN(ts)) {
        phaseStarts.set(event.phase, ts);
      }
    }

    if (event.event === "phase_end") {
      const ts = Date.parse(event.ts);
      const start = phaseStarts.get(event.phase);
      if (start !== undefined && !Number.isNaN(ts) && ts >= start) {
        phaseDurations[event.phase] = (phaseDurations[event.phase] ?? 0) + (ts - start);
      } else {
        issues.push(`phase_end without matching phase_start: ${event.phase}`);
      }
    }

    if (event.event === "gate_result") {
      if (event.status === "pass") gateResults.pass++;
      else if (event.status === "fail") gateResults.fail++;
      else if (event.status === "warn") gateResults.warn++;
    }

    if (event.event === "error") failures++;
    if (event.event === "retry") retries++;

    if (typeof event.tokens_in === "number") totalTokensIn += Math.max(0, event.tokens_in);
    if (typeof event.tokens_out === "number") totalTokensOut += Math.max(0, event.tokens_out);
    if (typeof event.cost_usd === "number") totalCostUsd += Math.max(0, event.cost_usd);
  }

  for (const phase of phaseStarts.keys()) {
    if (!(phase in phaseDurations)) {
      issues.push(`phase_start without matching phase_end: ${phase}`);
    }
  }

  const totalDurationMs = Object.values(phaseDurations).reduce((acc, value) => acc + value, 0);

  // Compute wall-clock duration from run_start to run_end events.
  const runStart = events.find((e) => e.event === "run_start");
  const runEnd = events.find((e) => e.event === "run_end");
  let wallClockMs: number | undefined;
  if (runStart && runEnd) {
    const startTs = Date.parse(runStart.ts);
    const endTs = Date.parse(runEnd.ts);
    if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
      issues.push("invalid run_start or run_end timestamp");
    } else if (endTs < startTs) {
      issues.push("run_end precedes run_start");
    } else {
      wallClockMs = endTs - startTs;
    }
  }

  return {
    total_events: events.length,
    events_by_type: eventsByType,
    gate_results: gateResults,
    phase_durations_ms: phaseDurations,
    activity_resolutions: [...activityResolutions.values()].sort((a, b) =>
      String(a.activity_id).localeCompare(String(b.activity_id)),
    ) as TraceSummary["activity_resolutions"],
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    total_cost_usd: Number(totalCostUsd.toFixed(6)),
    failure_count: failures,
    retry_count: retries,
    /** @deprecated Use summed_phase_duration_s instead. This sums phase durations, not wall-clock time. */
    total_duration_s: totalDurationMs > 0 ? Number((totalDurationMs / 1000).toFixed(3)) : undefined,
    summed_phase_duration_s:
      totalDurationMs > 0 ? Number((totalDurationMs / 1000).toFixed(3)) : undefined,
    total_wall_clock_s:
      wallClockMs !== undefined ? Number((wallClockMs / 1000).toFixed(3)) : undefined,
    security_time_to_closure_s:
      "security-review" in phaseDurations
        ? Number((phaseDurations["security-review"] / 1000).toFixed(3))
        : undefined,
  };
}

/**
 * Collects trace events from workspace-contained files and returns schema-backed summary metrics.
 */
export async function collectTrace(
  input: Input,
  logs: string[],
  opts: TraceOptions = {},
): Promise<TraceResult> {
  const workspaceRoot = opts.workspaceRoot ?? "/workspace";
  const schemaRoot = opts.schemaRoot ?? workspaceRoot;
  const schemaRef = input.schema_ref ?? "contracts/artifacts/execution-trace.schema.json";
  const schema = loadTraceSchema(schemaRoot, schemaRef);
  const events = loadTraceEvents(input, workspaceRoot, logs);
  const validate = (await createAjvInstance()).compile(schema);
  const issues: string[] = [];
  events.forEach((event, index) => validateTraceEvent(event, index, input.run_id, validate, issues));

  const summary = buildSummary(events, issues);
  return {
    run_id: input.run_id,
    valid: issues.length === 0,
    issues,
    summary,
  };
}

export function loadTraceSchema(schemaRoot: string, schemaRef: string): Record<string, unknown> {
  const schemaPath = resolveWithinWorkspace(schemaRoot, schemaRef, "Path", { rootLabel: "schema root" });
  return JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

export function loadTraceEvents(input: Input, workspaceRoot: string, logs: string[]): TraceEvent[] {
  if (!input.trace_path) {
    const events = input.events ?? [];
    logs.push(`Loaded inline trace events: ${events.length}`);
    return events;
  }
  const tracePath = resolveWithinWorkspace(workspaceRoot, input.trace_path, "Path", { rootLabel: "workspace root" });
  logs.push(`Loaded trace events from ${tracePath}`);
  return readJsonlEvents(tracePath);
}

export function validateTraceEvent(
  event: TraceEvent,
  index: number,
  runId: string,
  validate: { (value: unknown): boolean; errors?: Array<{ instancePath?: string; message?: string }> | null },
  issues: string[],
): void {
  if (!validate(event)) issues.push(`event[${index}] schema violation: ${formatSchemaErrors(validate.errors)}`);
  if (event.run_id !== runId) issues.push(`event[${index}] run_id mismatch: expected ${runId}, got ${event.run_id}`);
}

export function formatSchemaErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
}
