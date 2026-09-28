/** Purpose: structured logging, trace propagation, and Prometheus metrics. */
import crypto from "node:crypto";

const traceparentPattern = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-0[01]$/;

export function traceparent(value) {
  if (typeof value === "string" && traceparentPattern.test(value)) return value;
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`;
}

export function createLogger(base = {}) {
  const redact = (value, key = "") => {
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
  return (level, message, fields = {}) =>
    process.stdout.write(
      `${JSON.stringify(redact({ level, message, ...base, ...fields, at: new Date().toISOString() }))}\n`,
    );
}

export class Metrics {
  constructor() {
    this.requests = new Map();
    this.requestDurationMs = new Map();
    this.leaseClaims = 0;
    this.leaseFailures = 0;
    this.leaseExpiries = 0;
    this.reconciliations = 0;
    this.artifactMismatches = 0;
    this.outboxPending = 0;
    this.queueDepth = 0;
    this.activeWaits = 0;
    this.workerFreshnessSeconds = 0;
    this.signalLatencySeconds = 0;
    this.contextIncludedBytes = 0;
    this.contextOmittedItems = 0;
    this.modelInputTokens = 0;
    this.modelOutputTokens = 0;
    this.ready = 0;
  }
  observe(method, status, durationMs = 0) {
    const key = `${method}:${status}`;
    this.requests.set(key, (this.requests.get(key) || 0) + 1);
    this.requestDurationMs.set(key, (this.requestDurationMs.get(key) || 0) + durationMs);
  }
  applySnapshot(snapshot = {}) {
    for (const key of ["queueDepth", "activeWaits", "workerFreshnessSeconds", "outboxPending"])
      if (Number.isFinite(snapshot[key])) this[key] = snapshot[key];
  }
  observeAttempt(result = {}) {
    const usage = result.resource_usage || result.resourceUsage || {};
    const manifest = result.context_manifest || result.contextManifest || {};
    this.modelInputTokens += Number(usage.input_tokens || usage.inputTokens || 0);
    this.modelOutputTokens += Number(usage.output_tokens || usage.outputTokens || 0);
    this.contextIncludedBytes += Number(manifest.included_bytes || manifest.includedBytes || 0);
    this.contextOmittedItems += Number(manifest.omitted?.length || 0);
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
