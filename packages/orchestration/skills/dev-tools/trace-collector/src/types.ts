export interface TraceEvent {
  ts: string;
  run_id: string;
  event: string;
  phase: string;
  status?: "pass" | "fail" | "warn" | "ok" | "error" | "retry";
  activity_id?: string;
  tier?: string;
  model_hint?: string;
  runtime_name?: string;
  runtime_version?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface Input {
  run_id: string;
  trace_path?: string;
  schema_ref?: string;
  events?: TraceEvent[];
}

export interface TraceSummary {
  total_events: number;
  events_by_type: Record<string, number>;
  gate_results: { pass: number; fail: number; warn: number };
  phase_durations_ms: Record<string, number>;
  activity_resolutions?: Array<{
    activity_id: string;
    tier?: string;
    model_hint?: string;
    runtime_name?: string;
    runtime_version?: string;
    count: number;
  }>;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  failure_count: number;
  retry_count: number;
  /** @deprecated Use summed_phase_duration_s instead. This sums phase durations, not wall-clock time. */
  total_duration_s?: number;
  summed_phase_duration_s?: number;
  total_wall_clock_s?: number;
  security_time_to_closure_s?: number;
}

export interface TraceResult {
  run_id: string;
  valid: boolean;
  issues: string[];
  summary: TraceSummary;
}
