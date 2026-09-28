/** Enforces loopback request authentication, project confinement, and input bounds. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { IncomingMessage } from "node:http";

export interface OperatorProject {
  id: string;
  root: string;
  label: string;
}
type HttpError = Error & { status?: number };

export const MAX_BODY_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function opaqueProjectId() {
  return randomBytes(12).toString("base64url");
}

export function canonicalGitRoot(pathValue: unknown): string {
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

export function createProjectRegistry(paths: unknown): OperatorProject[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one --project Git root is required");
  }
  const seen = new Set<string>();
  return paths.map((pathValue) => {
    const root = canonicalGitRoot(pathValue);
    if (seen.has(root)) throw new Error(`duplicate project root: ${root}`);
    seen.add(root);
    return { id: opaqueProjectId(), root, label: basename(root) };
  });
}

export function findProject(
  projects: OperatorProject[],
  projectId: unknown,
): OperatorProject | null {
  if (typeof projectId !== "string" || !SAFE_ID.test(projectId)) return null;
  return projects.find((project) => project.id === projectId) ?? null;
}

export function isAuthorized(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const candidate = header.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(token);
  const candidateBuffer = Buffer.from(candidate);
  return (
    expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer)
  );
}

export function validateLoopbackRequest(
  req: Pick<IncomingMessage, "headers">,
  {
    host,
    origin,
    requireOrigin = false,
  }: { host: string; origin: string; requireOrigin?: boolean },
) {
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

function bodyTooLarge(limit: number): HttpError {
  return Object.assign(new Error(`request body exceeds ${limit} bytes`), { status: 413 });
}

function declaredBodyLength(req: Pick<IncomingMessage, "headers">, limit: number): void {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > limit) throw bodyTooLarge(limit);
}

async function collectBodyChunks(
  req: IncomingMessage,
  limit: number,
): Promise<{ size: number; chunks: Buffer[] }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw bodyTooLarge(limit);
    chunks.push(bytes);
  }
  return { size, chunks };
}

function parseJsonObject(chunks: Buffer[]): Record<string, unknown> {
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  declaredBodyLength(req, limit);
  const { size, chunks } = await collectBodyChunks(req, limit);
  if (size === 0) return {};
  try {
    return parseJsonObject(chunks);
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    const badRequest: HttpError = new Error(
      `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    );
    badRequest.status = 400;
    throw badRequest;
  }
}

export function validateRunId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw Object.assign(new Error("invalid run id"), { status: 400 });
  }
  return value as string;
}

export function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw Object.assign(new Error(`value must be an integer from 0 to ${maximum}`), {
      status: 400,
    });
  }
  return number;
}
