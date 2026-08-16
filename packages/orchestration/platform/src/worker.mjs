/** Purpose: execute the worker polling protocol with fenced 60-second leases. */
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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

function normalizedHost(url) {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv4Number(address) {
  return address
    .split(".")
    .reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4Prefix(base, prefixLength) {
  const shift = 32 - prefixLength;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << shift) >>> 0;
  return { network: (ipv4Number(base) & mask) >>> 0, mask };
}

const NON_GLOBAL_IPV4_PREFIXES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, prefixLength]) => ipv4Prefix(base, prefixLength));

function privateIpv4(address) {
  const value = ipv4Number(address);
  return NON_GLOBAL_IPV4_PREFIXES.some(
    ({ network, mask }) => ((value & mask) >>> 0) === network,
  );
}

function ipv6Words(address) {
  let value = address.toLowerCase().split("%", 1)[0];
  const dottedTail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dottedTail) {
    const ipv4 = ipv4Number(dottedTail[1]);
    value = `${value.slice(0, -dottedTail[1].length)}${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [...left, ...Array(zeroCount).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
}

function ipv6Prefix(base, prefixLength) {
  return { words: ipv6Words(base), prefixLength };
}

const NON_GLOBAL_IPV6_PREFIXES = [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
].map(([base, prefixLength]) => ipv6Prefix(base, prefixLength));

function hasIpv6Prefix(words, prefix) {
  const wholeWords = Math.floor(prefix.prefixLength / 16);
  const remainder = prefix.prefixLength % 16;
  for (let index = 0; index < wholeWords; index += 1) {
    if (words[index] !== prefix.words[index]) return false;
  }
  if (remainder === 0) return true;
  const mask = (0xffff << (16 - remainder)) & 0xffff;
  return (words[wholeWords] & mask) === (prefix.words[wholeWords] & mask);
}

function privateIpv6(address) {
  const words = ipv6Words(address);
  return NON_GLOBAL_IPV6_PREFIXES.some((prefix) => hasIpv6Prefix(words, prefix));
}

function publicAddress(address) {
  if (net.isIPv4(address)) return !privateIpv4(address);
  if (net.isIPv6(address)) return !privateIpv6(address);
  return false;
}

function localDevelopmentHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function loopbackAddress(address) {
  return net.isIPv4(address) ? address.startsWith("127.") : address === "::1";
}

function publicDnsName(host) {
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

function endpointRelativeUrl(endpoint, path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new Error("worker control-plane paths must be endpoint-relative");
  }
  const target = new URL(path, endpoint.origin);
  if (target.origin !== endpoint.origin || target.username || target.password) {
    throw new Error("worker control-plane paths must not change origin or authority");
  }
  return target;
}

function validEndpointShape(endpoint, localDevelopment) {
  const validProtocol =
    endpoint.protocol === "https:" ||
    (localDevelopment && endpoint.protocol === "http:");
  return (
    validProtocol &&
    !endpoint.username &&
    !endpoint.password &&
    endpoint.pathname === "/" &&
    !endpoint.search &&
    !endpoint.hash
  );
}

function firstConnection(addresses) {
  const address = addresses[0].address;
  return { address, family: net.isIP(address) };
}

function assertTrustedAddresses(host, addresses, localDevelopment) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error("worker control-plane origin must resolve only to public addresses");
  }
  if (localDevelopment) {
    if (addresses.some(({ address }) => !loopbackAddress(address))) {
      throw new Error("development worker control-plane origin must resolve only to loopback addresses");
    }
    return firstConnection(addresses);
  }
  const invalidLiteral = net.isIP(host) && !publicAddress(host);
  const invalidResolution = addresses.some(({ address }) => !publicAddress(address));
  if (!publicDnsName(host) || invalidLiteral || invalidResolution) {
    throw new Error("worker control-plane origin must resolve only to public addresses");
  }
  return firstConnection(addresses);
}

async function assertTrustedEndpoint(endpoint, { allowInsecureDevelopment, resolveHostname }) {
  const host = normalizedHost(endpoint).replace(/\.$/, "");
  const localDevelopment = allowInsecureDevelopment && localDevelopmentHost(host);
  if (!validEndpointShape(endpoint, localDevelopment)) {
    throw new Error(
      "workers require a credential-free HTTPS control-plane origin; development HTTP is loopback-only",
    );
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await resolveHostname(host);
  return assertTrustedAddresses(host, addresses, localDevelopment);
}

function pinnedLookup({ address, family }) {
  return (_hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    done(null, address, family);
  };
}

function responseHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const part of Array.isArray(value) ? value : [value]) {
      if (part !== undefined) result.append(name, String(part));
    }
  }
  return result;
}

function pinnedRequest(target, options, connection) {
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        lookup: pinnedLookup(connection),
        ...(target.protocol === "https:" && !net.isIP(normalizedHost(target))
          ? { servername: normalizedHost(target) }
          : {}),
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          reject(new Error("worker control-plane redirects are forbidden"));
          return;
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: responseHeaders(response.headers),
          body: response,
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

/** Builds an origin-locked worker request function after validating the endpoint at construction and use. */
export async function createWorkerRequest({
  baseUrl,
  token,
  allowInsecureDevelopment = false,
  resolveHostname = (host) => lookup(host, { all: true, verbatim: true }),
  fetchImpl = null,
}) {
  const endpoint = new URL(baseUrl);
  await assertTrustedEndpoint(endpoint, { allowInsecureDevelopment, resolveHostname });
  return async (path, requestBody, idempotencyKey) => {
    const target = endpointRelativeUrl(endpoint, path);
    const connection = await assertTrustedEndpoint(endpoint, {
      allowInsecureDevelopment,
      resolveHostname,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const options = {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        redirect: "error",
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      };
      return fetchImpl
        ? await fetchImpl(target, options)
        : await pinnedRequest(target, options, connection);
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function runWorker({
  baseUrl,
  token,
  workerId,
  repositoryDigest,
  worktreeDigest,
  execute,
  allowInsecureDevelopment = false,
  resolveHostname,
  signal = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const request = await createWorkerRequest({
    baseUrl,
    token,
    allowInsecureDevelopment,
    ...(resolveHostname ? { resolveHostname } : {}),
  });

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
