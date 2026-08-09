/** Purpose: execute the worker polling protocol with fenced 60-second leases. */
import crypto from "node:crypto";
import net from "node:net";

async function readJsonBounded(response, limit = 1024 * 1024) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error("control-plane response exceeds the worker limit");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("control-plane response exceeds the worker limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runWorker({
  baseUrl,
  token,
  workerId,
  repositoryDigest,
  worktreeDigest,
  execute,
  allowInsecureDevelopment = false,
  signal = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const endpoint = new URL(baseUrl);
  if (
    (endpoint.protocol !== "https:" &&
      !(allowInsecureDevelopment && endpoint.protocol === "http:")) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "workers require a credential-free HTTPS control-plane origin unless development HTTP is explicit",
    );
  const host = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateV4 =
    net.isIPv4(host) &&
    (/^10\./.test(host) ||
      /^127\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const privateV6 =
    net.isIPv6(host) &&
    (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host));
  if (!allowInsecureDevelopment && (host === "localhost" || privateV4 || privateV6))
    throw new Error("worker control-plane origin must not be private or loopback");
  const request = async (path, requestBody, idempotencyKey) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(new URL(path, endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        redirect: "error",
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };

  const registered = await request(
    "/api/v2/workers/register",
    { workerId, repositoryDigest, worktreeDigest },
    `register:${workerId}`,
  );
  if (!registered.ok) throw new Error(`worker registration failed: ${registered.status}`);
  while (!signal?.aborted) {
    const claimed = await request(
      "/api/v2/workers/claim",
      { workerId, longPollSeconds: 25 },
      `claim:${workerId}:${crypto.randomUUID()}`,
    );
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.status}`);
    const { claim } = await readJsonBounded(claimed);
    if (!claim) {
      await sleep(1000);
      continue;
    }

    let consecutiveHeartbeatFailures = 0;
    let heartbeatStopped = false;
    let stopHeartbeat;
    const heartbeatStop = new Promise((resolve) => {
      stopHeartbeat = resolve;
    });
    const abort = new AbortController();
    const heartbeatLoop = (async () => {
      while (!heartbeatStopped && !abort.signal.aborted) {
        await Promise.race([sleep(claim.heartbeatSeconds * 1000), heartbeatStop]);
        if (heartbeatStopped) break;
        try {
          const response = await request(
            "/api/v2/workers/heartbeat",
            { workerId, nodeId: claim.nodeId, fence: claim.fence },
            `heartbeat:${claim.attemptId}:${claim.fence}:${crypto.randomUUID()}`,
          );
          consecutiveHeartbeatFailures = response.ok ? 0 : consecutiveHeartbeatFailures + 1;
        } catch {
          consecutiveHeartbeatFailures += 1;
        }
        if (consecutiveHeartbeatFailures >= 2) abort.abort();
      }
    })();
    try {
      const result = await execute(claim, abort.signal);
      if (abort.signal.aborted) break;
      const response = await request(
        "/api/v2/workers/report",
        { workerId, nodeId: claim.nodeId, fence: claim.fence, result },
        `report:${claim.attemptId}:${claim.fence}`,
      );
      if (!response.ok) throw new Error(`report failed: ${response.status}`);
    } catch {
      if (abort.signal.aborted) break;
      const response = await request(
        "/api/v2/workers/failure",
        {
          workerId,
          nodeId: claim.nodeId,
          fence: claim.fence,
          result: { message: "worker execution failed" },
        },
        `failure:${claim.attemptId}:${claim.fence}`,
      );
      if (!response.ok) throw new Error(`failure report failed: ${response.status}`);
    } finally {
      heartbeatStopped = true;
      stopHeartbeat();
      abort.abort();
      await heartbeatLoop;
    }
  }
}
