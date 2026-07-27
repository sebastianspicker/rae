/** Enforces loopback request authentication, project confinement, and input bounds. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export const MAX_BODY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function opaqueProjectId() {
  return randomBytes(12).toString("base64url");
}

export function canonicalGitRoot(pathValue) {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw new Error("project root must be a non-empty path");
  }
  const canonical = realpathSync(pathValue);
  const result = spawnSync(
    "git",
    ["-C", canonical, "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`project root is not a Git repository: ${pathValue}`);
  }
  const topLevel = realpathSync(result.stdout.trim());
  if (topLevel !== canonical) {
    throw new Error(`project root must be the Git top-level directory: ${topLevel}`);
  }
  return canonical;
}

export function createProjectRegistry(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one --project Git root is required");
  }
  const seen = new Set();
  return paths.map((pathValue) => {
    const root = canonicalGitRoot(pathValue);
    if (seen.has(root)) throw new Error(`duplicate project root: ${root}`);
    seen.add(root);
    return { id: opaqueProjectId(), root, label: basename(root) };
  });
}

export function findProject(projects, projectId) {
  if (!SAFE_ID.test(projectId ?? "")) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

export function isAuthorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(token);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

export function validateLoopbackRequest(req, { host, origin, requireOrigin = false }) {
  if (req.headers.host !== host) return { ok: false, status: 421, error: "invalid Host" };
  const suppliedOrigin = req.headers.origin;
  if (requireOrigin && suppliedOrigin !== origin) {
    return { ok: false, status: 403, error: "invalid Origin" };
  }
  if (suppliedOrigin !== undefined && suppliedOrigin !== origin) {
    return { ok: false, status: 403, error: "invalid Origin" };
  }
  return { ok: true };
}

function bodyTooLarge(limit) {
  return Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 });
}

function declaredBodyLength(req, limit) {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit) throw bodyTooLarge(limit);
}

async function collectBodyChunks(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw bodyTooLarge(limit);
    chunks.push(chunk);
  }
  return { size, chunks };
}

function parseJsonObject(chunks) {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value;
}

export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  declaredBodyLength(req, limit);
  const { size, chunks } = await collectBodyChunks(req, limit);
  if (size === 0) return {};
  try {
    return parseJsonObject(chunks);
  } catch (error) {
    if (error.status) throw error;
    const badRequest = new Error(`invalid JSON body: ${error.message}`);
    badRequest.status = 400;
    throw badRequest;
  }
}

export function validateRunId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value ?? "")) {
    throw Object.assign(new Error("invalid run id"), { status: 400 });
  }
  return value;
}

export function positiveInteger(value, fallback, maximum) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw Object.assign(new Error(`value must be an integer from 0 to ${maximum}`), {
      status: 400,
    });
  }
  return number;
}
