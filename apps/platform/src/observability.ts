/** Purpose: structured logging, trace propagation, and Prometheus metrics. */
import crypto from "node:crypto";

const traceparentPattern = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/;

export function traceparent(value: unknown) {
  if (typeof value === "string" && traceparentPattern.test(value)) return value;
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
}

export function createLogger(base: Record<string, unknown> = {}) {
  const redact = (value: unknown, key = ""): unknown => {
    if (/token|authorization|secret|password|cookie|credential/i.test(key)) return "[redacted]";
    if (typeof value === "string")
      return value
        .replace(/(bearer\s+|token=|authorization:|x-amz-signature=)[^\s,&]+/gi, "$1[redacted]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1[redacted]@")
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]");
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]),
      );
    return value;
  };
  return (level: string, message: string, fields: Record<string, unknown> = {}) =>
    process.stdout.write(
      `${JSON.stringify(redact({ level, message, ...base, ...fields, at: new Date().toISOString() }))}\n`,
    );
}

export class Metrics {
  requests = new Map<string, number>();
  requestDurationMs = new Map<string, number>();
  leaseClaims = 0;
  leaseFailures = 0;
  leaseExpiries = 0;
  reconciliations = 0;
  artifactMismatches = 0;
  outboxPending = 0;
  queueDepth = 0;
  activeWaits = 0;
  workerFreshnessSeconds = 0;
  signalLatencySeconds = 0;
  contextIncludedBytes = 0;
  contextOmittedItems = 0;
  modelInputTokens = 0;
  modelOutputTokens = 0;
  ready = 0;
  observe(method: string, status: number, durationMs = 0) {
    const label = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(method)
      ? method
      : "OTHER";
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
    const key = `${label}:${code}`;
    this.requests.set(key, (this.requests.get(key) || 0) + 1);
    this.requestDurationMs.set(
      key,
      (this.requestDurationMs.get(key) || 0) + nonnegative(durationMs),
    );
  }
  applySnapshot(
    snapshot: Partial<
      Record<"queueDepth" | "activeWaits" | "workerFreshnessSeconds" | "outboxPending", number>
    > = {},
  ) {
    for (const key of [
      "queueDepth",
      "activeWaits",
      "workerFreshnessSeconds",
      "outboxPending",
    ] as const)
      if (typeof snapshot[key] === "number" && Number.isFinite(snapshot[key]))
        this[key] = snapshot[key];
  }
  observeAttempt(result: Record<string, unknown> = {}) {
    const usage = record(result.resource_usage || result.resourceUsage);
    const manifest = record(result.context_manifest || result.contextManifest);
    this.modelInputTokens = cappedAdd(
      this.modelInputTokens,
      usage.input_tokens || usage.inputTokens,
    );
    this.modelOutputTokens = cappedAdd(
      this.modelOutputTokens,
      usage.output_tokens || usage.outputTokens,
    );
    this.contextIncludedBytes = cappedAdd(
      this.contextIncludedBytes,
      manifest.included_bytes || manifest.includedBytes,
    );
    this.contextOmittedItems += Array.isArray(manifest.omitted) ? manifest.omitted.length : 0;
  }
  render() {
    const lines = ["# TYPE rae_platform_http_requests_total counter"];
    for (const [key, count] of this.requests) {
      const [method, status] = key.split(":");
      lines.push(
        `rae_platform_http_requests_total{method="${method}",status="${status}"} ${count}`,
      );
      lines.push(
        `rae_platform_http_request_duration_milliseconds_sum{method="${method}",status="${status}"} ${this.requestDurationMs.get(key) || 0}`,
      );
    }
    lines.push(
      "# TYPE rae_platform_lease_claims_total counter",
      `rae_platform_lease_claims_total ${this.leaseClaims}`,
      `rae_platform_lease_failures_total ${this.leaseFailures}`,
      `rae_platform_lease_expiries_total ${this.leaseExpiries}`,
      `rae_platform_reconciliations_total ${this.reconciliations}`,
      `rae_platform_artifact_mismatches_total ${this.artifactMismatches}`,
      `rae_platform_queue_depth ${this.queueDepth}`,
      `rae_platform_active_waits ${this.activeWaits}`,
      `rae_platform_worker_freshness_seconds ${this.workerFreshnessSeconds}`,
      `rae_platform_signal_latency_seconds ${this.signalLatencySeconds}`,
      `rae_platform_context_included_bytes_total ${this.contextIncludedBytes}`,
      `rae_platform_context_omitted_items_total ${this.contextOmittedItems}`,
      `rae_platform_model_input_tokens_total ${this.modelInputTokens}`,
      `rae_platform_model_output_tokens_total ${this.modelOutputTokens}`,
      `rae_platform_outbox_pending ${this.outboxPending}`,
      `rae_platform_ready ${this.ready}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonnegative(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(number) && number >= 0 ? Math.min(number, Number.MAX_SAFE_INTEGER) : 0;
}

function cappedAdd(current: number, value: unknown): number {
  return Math.min(Number.MAX_SAFE_INTEGER, nonnegative(current) + nonnegative(value));
}
