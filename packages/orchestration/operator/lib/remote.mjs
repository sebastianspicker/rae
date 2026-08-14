/** Constrains remote operator API forwarding to the console's known REST surface. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

export const MAX_REMOTE_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REVISION = /^[1-9][0-9]{0,8}$/;
const SAFE_PROPOSAL_JOB_ID = /^proposal-[a-f0-9-]{36}$/;
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

const SEGMENTS = Object.freeze({
  projectId: SAFE_PROJECT_ID,
  proposalJobId: SAFE_PROPOSAL_JOB_ID,
  revision: SAFE_REVISION,
  runId: SAFE_RUN_ID,
  workflowId: SAFE_WORKFLOW_ID,
});

/**
 * Fixed remote API contract. Keep each reachable console route explicit so an
 * upstream credential cannot become a general-purpose proxy capability.
 */
const REMOTE_ROUTE_SPECS = Object.freeze([
  { method: "GET", path: ["api", "v1", "projects"], query: [] },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "execution-profiles"],
    query: [],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs"],
    query: ["cursor", "limit"],
  },
  {
    method: "POST",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs"],
    query: ["cursor", "limit"],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs", SEGMENTS.runId],
    query: [],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs", SEGMENTS.runId, "events"],
    query: ["after", "limit"],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs", SEGMENTS.runId, "events", "stream"],
    query: ["after"],
  },
  ...["stop", "resume", "interrupt", "checkpoint-decision", "cleanup"].map((action) => ({
    method: "POST",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs", SEGMENTS.runId, action],
    query: [],
  })),
  { method: "GET", path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows"], query: [] },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows", "templates"],
    query: [],
  },
  {
    method: "POST",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows", "templates"],
    query: [],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows", SEGMENTS.workflowId],
    query: [],
  },
  {
    method: "POST",
    path: [
      "api",
      "v1",
      "projects",
      SEGMENTS.projectId,
      "workflows",
      SEGMENTS.workflowId,
      "analysis",
    ],
    query: [],
  },
  {
    method: "POST",
    path: [
      "api",
      "v1",
      "projects",
      SEGMENTS.projectId,
      "workflows",
      SEGMENTS.workflowId,
      "proposals",
    ],
    query: [],
  },
  {
    method: "GET",
    path: [
      "api",
      "v1",
      "projects",
      SEGMENTS.projectId,
      "workflows",
      SEGMENTS.workflowId,
      "proposals",
      SEGMENTS.proposalJobId,
    ],
    query: [],
  },
  {
    method: "POST",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows", SEGMENTS.workflowId, "drafts"],
    query: [],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "workflows", SEGMENTS.workflowId, "diff"],
    query: ["from", "to"],
  },
  ...["validate", "activate"].map((action) => ({
    method: "POST",
    path: [
      "api",
      "v1",
      "projects",
      SEGMENTS.projectId,
      "workflows",
      SEGMENTS.workflowId,
      "revisions",
      SEGMENTS.revision,
      action,
    ],
    query: [],
  })),
]);

function remoteError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "::1";
}

/** Validates the single upstream origin permitted for a remote console session. */
export function parseRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--remote-url must be an absolute HTTPS URL");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("--remote-url must contain only an origin");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("--remote-url must use HTTPS (HTTP is limited to loopback development)");
  }
  return url;
}

function validateTokenFileStat(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw remoteError("upstream token file is unsafe");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw remoteError("upstream token file is unsafe");
  }
}

/** Reads one owner-only bearer token without following a symlink. */
export function readRemoteTokenFile(tokenFile) {
  let descriptor;
  try {
    validateTokenFileStat(lstatSync(tokenFile));
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(tokenFile, constants.O_RDONLY | noFollow);
    validateTokenFileStat(fstatSync(descriptor));
    const token = readFileSync(descriptor, "utf8").trim();
    if (!/^[\x21-\x7e]{1,8192}$/.test(token)) throw remoteError("upstream token file is invalid");
    return token;
  } catch (error) {
    if (error?.status) throw error;
    throw remoteError("upstream token file is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeParts(pathname) {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw remoteError("remote operator path is not allowed", 404);
  }
}

function hasAllowedQuery(searchParams, allowed) {
  const seen = new Set();
  for (const [key, value] of searchParams) {
    if (!allowed.has(key) || seen.has(key) || !SAFE_QUERY_VALUE.test(value)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function matchesRoutePart(expected, actual) {
  return typeof expected === "string" ? expected === actual : expected.test(actual);
}

function matchesRoute(spec, method, parts, searchParams) {
  return (
    spec.method === method &&
    spec.path.length === parts.length &&
    spec.path.every((expected, index) => matchesRoutePart(expected, parts[index])) &&
    hasAllowedQuery(searchParams, new Set(spec.query))
  );
}

/** Returns true only for routes implemented by the local console UI. */
export function isAllowedRemoteRequest(method, pathname, searchParams) {
  const parts = decodeParts(pathname);
  return REMOTE_ROUTE_SPECS.some((spec) => matchesRoute(spec, method, parts, searchParams));
}

async function readRequestBody(req) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    throw remoteError("request body exceeds 65536 bytes", 413);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw remoteError("request body exceeds 65536 bytes", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response) {
  assertResponseLength(response);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REMOTE_RESPONSE_BYTES) {
      await reader.cancel();
      throw remoteError("remote operator response exceeds size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function assertResponseLength(response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REMOTE_RESPONSE_BYTES) {
    throw remoteError("remote operator response exceeds size limit");
  }
}

/** Creates the server-side-only upstream credential and strict REST forwarder. */
export function createRemoteOperatorProxy({ remoteUrl, tokenFile, fetchImpl = globalThis.fetch }) {
  if (typeof tokenFile !== "string" || tokenFile.length === 0) {
    throw new Error("--token-file is required with --remote-url");
  }
  if (typeof fetchImpl !== "function") throw new Error("remote fetch is unavailable");
  const upstream = parseRemoteUrl(remoteUrl);
  return {
    async forward(req, url) {
      if (!isAllowedRemoteRequest(req.method, url.pathname, url.searchParams)) {
        throw remoteError("remote operator path is not allowed", 404);
      }
      const target = new URL(`${url.pathname}${url.search}`, upstream);
      if (target.origin !== upstream.origin)
        throw remoteError("remote operator path is not allowed", 404);
      const body = ["POST", "PUT", "PATCH"].includes(req.method)
        ? await readRequestBody(req)
        : null;
      const response = await fetchImpl(target, {
        method: req.method,
        headers: {
          authorization: `Bearer ${readRemoteTokenFile(tokenFile)}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body?.length ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw remoteError("remote operator redirect rejected");
      }
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";
      if (url.pathname.endsWith("/events/stream")) {
        assertResponseLength(response);
        return { status: response.status, contentType, stream: response.body };
      }
      const responseBody = await readResponseBody(response);
      return {
        status: response.status,
        contentType,
        body: responseBody,
      };
    },
  };
}
