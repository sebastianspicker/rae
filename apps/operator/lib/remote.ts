/** Constrains remote operator API forwarding to the console's known REST surface. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import type { IncomingMessage } from "node:http";

type HttpError = Error & { status: number };
type RoutePart = string | RegExp;
interface RemoteRouteSpec {
  method: string;
  path: readonly RoutePart[];
  query: readonly string[];
}
export interface RemoteForwardResult {
  status: number;
  contentType: string;
  body?: Buffer;
  stream?: ReadableStream<Uint8Array> | null;
}
export interface RemoteProxy {
  forward(req: IncomingMessage, url: URL): Promise<RemoteForwardResult>;
}

export const MAX_REMOTE_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const SAFE_PROJECT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_REVISION = /^[1-9][0-9]{0,8}$/;
const SAFE_PROPOSAL_JOB_ID = /^proposal-[a-f0-9-]{36}$/;
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._-]{1,128}$/;

const SEGMENTS: Readonly<Record<string, RegExp>> = Object.freeze({
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
const REMOTE_ROUTE_SPECS: readonly RemoteRouteSpec[] = Object.freeze([
  { method: "GET", path: ["api", "v1", "projects"], query: [] },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "execution-profiles"],
    query: [],
  },
  {
    method: "GET",
    path: ["api", "v1", "projects", SEGMENTS.projectId, "runs"],
    query: ["cursor", "limit", "view"],
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

function remoteError(message: string, status = 502): HttpError {
  return Object.assign(new Error(message), { status });
}

/** Validates the single upstream origin permitted for a remote console session. */
export function parseRemoteUrl(value: unknown): URL {
  let url: URL;
  try {
    if (typeof value !== "string") throw new TypeError("not a string");
    url = new URL(value);
  } catch {
    throw new Error("--remote-url must be an absolute HTTPS URL");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("--remote-url must contain only an origin");
  }
  if (url.protocol !== "https:") throw new Error("--remote-url must use HTTPS");
  return url;
}

function validateTokenFileStat(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw remoteError("upstream token file is unsafe");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw remoteError("upstream token file is unsafe");
  }
}

/** Reads one owner-only bearer token without following a symlink. */
export function readRemoteTokenFile(tokenFile: string): string {
  let descriptor: number | undefined;
  try {
    validateTokenFileStat(lstatSync(tokenFile));
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(tokenFile, constants.O_RDONLY | noFollow);
    validateTokenFileStat(fstatSync(descriptor));
    const token = readFileSync(descriptor, "utf8").trim();
    if (!/^[\x21-\x7e]{1,8192}$/.test(token)) throw remoteError("upstream token file is invalid");
    return token;
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw remoteError("upstream token file is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeParts(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw remoteError("remote operator path is not allowed", 404);
  }
}

function hasAllowedQuery(searchParams: URLSearchParams, allowed: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  for (const [key, value] of searchParams) {
    if (!allowed.has(key) || seen.has(key) || !SAFE_QUERY_VALUE.test(value)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function matchesRoutePart(expected: RoutePart, actual: string): boolean {
  return typeof expected === "string" ? expected === actual : expected.test(actual);
}

function matchesRoute(
  spec: RemoteRouteSpec,
  method: string,
  parts: readonly string[],
  searchParams: URLSearchParams,
): boolean {
  return (
    spec.method === method &&
    spec.path.length === parts.length &&
    spec.path.every((expected, index) => matchesRoutePart(expected, parts[index])) &&
    hasAllowedQuery(searchParams, new Set(spec.query))
  );
}

/** Returns true only for routes implemented by the local console UI. */
export function isAllowedRemoteRequest(
  method: string | undefined,
  pathname: string,
  searchParams: URLSearchParams,
): boolean {
  const parts = decodeParts(pathname);
  return REMOTE_ROUTE_SPECS.some((spec) => matchesRoute(spec, method ?? "", parts, searchParams));
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REQUEST_BYTES) {
    throw remoteError("request body exceeds 65536 bytes", 413);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw remoteError("request body exceeds 65536 bytes", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readResponseBody(response: Response): Promise<Buffer> {
  assertResponseLength(response);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const chunks: Buffer[] = [];
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

function assertResponseLength(response: Response): void {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_REMOTE_RESPONSE_BYTES) {
    throw remoteError("remote operator response exceeds size limit");
  }
}

/** Creates the server-side-only upstream credential and strict REST forwarder. */
export function createRemoteOperatorProxy({
  remoteUrl,
  tokenFile,
  fetchImpl = globalThis.fetch,
}: {
  remoteUrl: unknown;
  tokenFile: unknown;
  fetchImpl?: typeof globalThis.fetch;
}): RemoteProxy {
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
      const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "")
        ? await readRequestBody(req)
        : null;
      const response = await fetchImpl(target, {
        method: req.method ?? "GET",
        headers: {
          authorization: `Bearer ${readRemoteTokenFile(tokenFile)}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body?.length ? new Uint8Array(body) : undefined,
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
