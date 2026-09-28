/** Loopback management serves cached readiness and metrics without per-request database work. */
import http from "node:http";
import { isLiteralLoopbackHost } from "./config.js";
import type { Metrics } from "./observability.js";
export type MetricSnapshot = Parameters<Metrics["applySnapshot"]>[0];
export interface ManagementSource {
  isReady(signal: AbortSignal): Promise<boolean>;
  lifecycleSnapshot(signal: AbortSignal): Promise<MetricSnapshot>;
}
export function createManagementServer({
  source,
  metrics,
  host = "127.0.0.1",
  intervalMs = 5000,
  timeoutMs = 2000,
}: {
  source: ManagementSource;
  metrics: Metrics;
  host?: string;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  if (!isLiteralLoopbackHost(host))
    throw new Error("Management listener requires a literal loopback host");
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 10 ||
    intervalMs > 60_000 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > intervalMs
  )
    throw new Error("Invalid management refresh bounds");
  let stopped = false;
  let pending = false;
  let refreshed = 0;
  let controller: AbortController | undefined;
  function ready(): boolean {
    return metrics.ready === 1 && Date.now() - refreshed <= intervalMs * 2;
  }
  async function refresh(): Promise<void> {
    if (stopped || pending) return;
    pending = true;
    const abort = new AbortController();
    controller = abort;
    const timeout = setTimeout(() => {
      metrics.ready = 0;
      abort.abort();
    }, timeoutMs);
    timeout.unref();
    try {
      const [available, snapshot] = await Promise.allSettled([
        source.isReady(abort.signal),
        source.lifecycleSnapshot(abort.signal),
      ]);
      if (available.status === "rejected" || snapshot.status === "rejected") {
        metrics.ready = 0;
        return;
      }
      if (!stopped && !abort.signal.aborted) {
        metrics.applySnapshot(snapshot.value);
        metrics.ready = available.value ? 1 : 0;
        refreshed = Date.now();
      }
    } catch {
      metrics.ready = 0;
    } finally {
      clearTimeout(timeout);
      pending = false;
      if (controller === abort) controller = undefined;
    }
  }
  const timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref();
  void refresh();
  const server = http.createServer((req, res) => {
    const peer = req.socket.remoteAddress;
    const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    let validHost = false;
    try {
      const authority = new URL(`http://${req.headers.host ?? ""}`);
      validHost =
        isLiteralLoopbackHost(authority.hostname) &&
        authority.pathname === "/" &&
        !authority.username &&
        !authority.password &&
        !authority.search &&
        !authority.hash;
    } catch {
      /* Invalid authorities are denied. */
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!local || !validHost) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }
    if (req.url === "/ready") {
      const available = ready();
      res.writeHead(available ? 200 : 503, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ready: available }));
    } else if (req.url === "/metrics") {
      if (!ready()) metrics.ready = 0;
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : metrics.render());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return {
    server,
    host,
    refresh,
    ready,
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
      metrics.ready = 0;
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
