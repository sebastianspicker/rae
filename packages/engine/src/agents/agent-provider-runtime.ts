/** Shared safe process, redaction, and child-environment primitives for agent providers. */
import {
  constants as fsConstants,
  accessSync,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { openFileAt, openParent, openRoot, renameAt, unlinkAt } from "@rae/fs-bridge";
import {
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  boundedDiagnosticTail,
  type BoundedProcessResult,
  type TerminationEvidence,
} from "./bounded-process.js";

export const MAX_AGENT_OUTPUT_BYTES = MAX_STDOUT_BYTES;
export { MAX_STDERR_BYTES, MAX_STDOUT_BYTES } from "./bounded-process.js";
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const PROCESS_GROUP_TERMINATION_GRACE_MS = 100;
const ASSIGNMENT_SECRET_PATTERN =
  /((?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const FLAG_SECRET_PATTERN =
  /(--?(?:api[_-]?key|access[_-]?key|auth[_-]?token|token|secret|password)(?:=|\s+))[^\s,;]+/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const OPENAI_SECRET_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g;
const GITHUB_SECRET_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];
const SEALED_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "CODEX_HOME",
];

export function executableFromPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!command || typeof command !== "string") return null;
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  return null;
}

export function redact(text: unknown): string {
  return String(text ?? "")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]")
    .replace(FLAG_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_SECRET_PATTERN, "[REDACTED]")
    .replace(GITHUB_SECRET_PATTERN, "[REDACTED]");
}

interface ProcessOutput {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
}

export interface ProviderProcessError extends Error {
  code: "PROCESS_TIMEOUT" | "PROCESS_ABORTED" | "STDOUT_OVERFLOW" | "STDERR_OVERFLOW";
  termination: TerminationEvidence;
  stdoutTail: string;
  stderrTail: string;
}

export function failureExcerpt(proc: ProcessOutput): string {
  const combined = [proc.stderr, proc.stdout].filter(Boolean).join("\n").trim();
  return combined ? redact(combined.slice(-4000)) : "no process output";
}

/** Converts bounded process termination into redacted, machine-readable failure evidence. */
export function boundedProcessFailure(
  provider: string,
  timeoutMs: number,
  proc: BoundedProcessResult,
  limits: { stdout: number; stderr: number } = {
    stdout: MAX_STDOUT_BYTES,
    stderr: MAX_STDERR_BYTES,
  },
): ProviderProcessError | null {
  if (!proc.termination) return null;
  const reason = proc.termination.reason;
  const code =
    reason === "timeout"
      ? "PROCESS_TIMEOUT"
      : reason === "aborted"
        ? "PROCESS_ABORTED"
        : reason === "stdout_overflow"
          ? "STDOUT_OVERFLOW"
          : "STDERR_OVERFLOW";
  const limit = reason === "stdout_overflow" ? limits.stdout : limits.stderr;
  const description =
    reason === "timeout"
      ? `timed out after ${Math.ceil(timeoutMs / 1000)} seconds`
      : reason === "aborted"
        ? "was aborted"
        : `${reason === "stdout_overflow" ? "stdout" : "stderr"} exceeded ${limit} bytes`;
  const certainty = proc.termination.containmentUncertain
    ? "containment_uncertain"
    : "process_group_absence_observed";
  const error = new Error(
    `${provider} ${description}; process-group termination awaited; ${certainty}: ${failureExcerpt({ stdout: proc.stdoutTail, stderr: proc.stderrTail })}`,
  ) as ProviderProcessError;
  error.code = code;
  error.termination = proc.termination;
  error.stdoutTail = boundedDiagnosticTail(redact(proc.stdoutTail));
  error.stderrTail = boundedDiagnosticTail(redact(proc.stderrTail));
  return error;
}

function waitBounded(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (
    process.platform === "win32" ||
    typeof pid !== "number" ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") return false;
    throw error;
  }
}

export function timeoutError(provider: string, timeoutMs: number, proc: { pid?: number }): Error {
  const processGroupTerminated = signalProcessGroup(proc.pid, "SIGTERM");
  if (processGroupTerminated) {
    waitBounded(PROCESS_GROUP_TERMINATION_GRACE_MS);
    signalProcessGroup(proc.pid, "SIGKILL");
  }
  const scope = processGroupTerminated ? "process group" : "direct process";
  return new Error(
    `${provider} timed out after ${Math.ceil(timeoutMs / 1000)} seconds; ${scope} termination was attempted; containment_uncertain (a detached session cannot be proven terminated)`,
  );
}

export function parseArtifact(raw: unknown, provider: string): Record<string, unknown> {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error(`${provider} returned an empty artifact`);
  try {
    const artifact: unknown = JSON.parse(trimmed);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("artifact must be a JSON object");
    }
    return artifact as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `${provider} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Builds the fixed Ralph-compatible child environment used at autonomous trust boundaries. */
export function minimalChildEnvironment(
  env: NodeJS.ProcessEnv,
  cwd: string,
  credentialEnvVars: readonly string[] | null = null,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const allowlist = credentialEnvVars ? SEALED_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
  for (const key of allowlist) if (env?.[key] !== undefined) sanitized[key] = env[key];
  for (const key of credentialEnvVars ?? [])
    if (env?.[key] !== undefined) sanitized[key] = env[key];
  sanitized.PWD = cwd;
  sanitized.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_cli_rs";
  return sanitized;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Reads a provider-owned regular file without following a replaceable leaf symlink. */
export function readBoundedProviderFile(
  path: string,
  maximumBytes: number = MAX_AGENT_OUTPUT_BYTES,
): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("provider output byte limit must be a positive safe integer");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const initial = fstatSync(descriptor);
    if (!initial.isFile()) throw new Error("provider output must be a regular file");
    if (typeof process.getuid === "function" && initial.uid !== process.getuid()) {
      throw new Error("provider output must be owned by the current user");
    }
    if ((initial.mode & 0o022) !== 0) {
      throw new Error("provider output must not be writable by group or other users");
    }
    if (initial.size > maximumBytes) {
      throw new Error(`provider output exceeds ${maximumBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > maximumBytes) throw new Error(`provider output exceeds ${maximumBytes} bytes`);
    const final = fstatSync(descriptor);
    if (!sameIdentity(initial, final) || final.size !== total) {
      throw new Error("provider output changed while it was being read");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ReplacementParent {
  rootDescriptor: number;
  parentDescriptor: number;
  fileName: Buffer;
}

function replacementParent(workspaceRoot: string, destination: string): ReplacementParent {
  const requestedRoot = resolve(workspaceRoot);
  const requestedDestination = resolve(destination);
  const pathFromRoot = relative(requestedRoot, requestedDestination);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("event log path must be a file below the authorized workspace root");
  }
  const rootDescriptor = openRoot(requestedRoot);
  try {
    const { fd: parentDescriptor, name: fileName } = openParent(rootDescriptor, pathFromRoot);
    return { rootDescriptor, parentDescriptor, fileName };
  } catch (error) {
    closeSync(rootDescriptor);
    throw new Error("event log parents must be non-symlink directories", { cause: error });
  }
}

function assertReplaceableDestination(parentDescriptor: number, fileName: Buffer): void {
  let descriptor: number | undefined;
  try {
    descriptor = openFileAt(parentDescriptor, fileName, "read");
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("event log destination must be absent or a regular file");
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT")
      throw new Error("event log destination must be absent or a regular file", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface PrivateSibling {
  name: Buffer;
  descriptor: number;
  identity: Stats;
}

function reservePrivateSiblingAttempt(
  parentDescriptor: number,
  fileName: Buffer,
): PrivateSibling | null {
  const name = Buffer.from(`.${fileName.toString("utf8")}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = openFileAt(parentDescriptor, name, "create");
    return { name, descriptor, identity: fstatSync(descriptor) };
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") return null;
    throw error;
  }
}

function createPrivateSibling(parentDescriptor: number, fileName: Buffer): PrivateSibling {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const reserved = reservePrivateSiblingAttempt(parentDescriptor, fileName);
    if (reserved) return reserved;
  }
  throw new Error("could not reserve a private event-log replacement file");
}

function writeReplacementBody(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("could not write private event-log replacement");
    offset += written;
  }
}

function cleanupPrivateSibling(
  parentDescriptor: number,
  temp: PrivateSibling,
  open: boolean,
): void {
  if (open) closeSync(temp.descriptor);
  try {
    unlinkAt(parentDescriptor, temp.name);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

function replacementIsUnchanged(temp: PrivateSibling, bodySize: number): boolean {
  const metadata = fstatSync(temp.descriptor);
  return sameIdentity(metadata, temp.identity) && metadata.size === bodySize;
}

export interface ReplacePrivateFileRequest {
  authorizedRoot: string;
  destination: string;
  body: string;
}

/** Atomically replaces an event log only after its caller has prepared the complete body. */
export function replacePrivateFile({
  authorizedRoot,
  destination,
  body,
}: ReplacePrivateFileRequest): void {
  if (typeof authorizedRoot !== "string" || !authorizedRoot.trim())
    throw new Error("an explicit event-log authorized root is required");
  if (typeof body !== "string")
    throw new Error("private event-log replacement body must be a string");
  const { rootDescriptor, parentDescriptor, fileName } = replacementParent(
    authorizedRoot,
    destination,
  );
  let temp: PrivateSibling | undefined;
  let tempOpen = false;
  try {
    assertReplaceableDestination(parentDescriptor, fileName);
    temp = createPrivateSibling(parentDescriptor, fileName);
    tempOpen = true;
    const bytes = Buffer.from(body, "utf8");
    ftruncateSync(temp.descriptor, 0);
    writeReplacementBody(temp.descriptor, bytes);
    fchmodSync(temp.descriptor, 0o600);
    if (!replacementIsUnchanged(temp, bytes.length)) {
      throw new Error("reserved event-log replacement changed before commit");
    }
    closeSync(temp.descriptor);
    tempOpen = false;
    renameAt(parentDescriptor, temp.name, parentDescriptor, fileName, false);
  } finally {
    if (temp) cleanupPrivateSibling(parentDescriptor, temp, tempOpen);
    closeSync(parentDescriptor);
    closeSync(rootDescriptor);
  }
}
