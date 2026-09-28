/** Runs provider children with independent byte caps and bounded process-group cleanup. */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export const MAX_STDOUT_BYTES = 20 * 1024 * 1024;
export const MAX_STDERR_BYTES = 16 * 1024 * 1024;
export const REDACTED_TAIL_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;

export interface BoundedProcessRequest {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  signal?: AbortSignal;
}

export interface TerminationEvidence {
  reason: "timeout" | "stdout_overflow" | "stderr_overflow" | "aborted";
  groupTerminationAttempted: boolean;
  directTerminationAttempted: boolean;
  closeObserved: boolean;
  groupAbsentObserved: boolean;
  containmentUncertain: boolean;
}

export interface BoundedProcessResult {
  pid: number | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTail: string;
  stderrTail: string;
  error?: Error;
  termination?: TerminationEvidence;
}

interface StreamCapture {
  chunks: Buffer[];
  tail: Buffer;
  bytes: number;
  limit: number;
  overflow: boolean;
}

/** Keeps decoded and redacted diagnostics within the byte budget, including malformed input. */
export function boundedDiagnosticTail(text: string): string {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - REDACTED_TAIL_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

function appendCapture(capture: StreamCapture, chunk: Buffer): void {
  capture.bytes += chunk.length;
  if (!capture.overflow && capture.bytes <= capture.limit) capture.chunks.push(chunk);
  else {
    capture.overflow = true;
    capture.chunks = [];
  }
  const combined = capture.tail.length ? Buffer.concat([capture.tail, chunk]) : chunk;
  capture.tail = combined.subarray(Math.max(0, combined.length - REDACTED_TAIL_BYTES));
}

function attachCapture(
  stream: Readable | null,
  capture: StreamCapture,
  overflow: () => void,
): void {
  stream?.on("data", (value: Buffer | string) => {
    appendCapture(capture, Buffer.isBuffer(value) ? value : Buffer.from(value));
    if (capture.overflow) overflow();
  });
}

function groupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitFor(predicate: () => boolean, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(20);
  }
  return predicate();
}

interface SignalEvidence {
  group: boolean;
  direct: boolean;
  failed: boolean;
}
function sendTerminationSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
  evidence: SignalEvidence,
): void {
  let delivered = false;
  try {
    if (child.pid !== undefined) delivered = signalGroup(child.pid, signal);
  } catch {
    evidence.failed = true;
  }
  evidence.group ||= delivered;
  if (!delivered && child.exitCode === null && child.signalCode === null) {
    evidence.direct = true;
    try {
      child.kill(signal);
    } catch {
      evidence.failed = true;
    }
  }
}
async function terminate(
  child: ChildProcess,
  reason: TerminationEvidence["reason"],
  closed: () => boolean,
): Promise<TerminationEvidence> {
  const evidence: SignalEvidence = { group: false, direct: false, failed: false };
  sendTerminationSignal(child, "SIGTERM", evidence);
  await waitFor(closed, TERMINATION_GRACE_MS);
  const pid = child.pid;
  if ((pid !== undefined && groupExists(pid)) || !closed()) {
    sendTerminationSignal(child, "SIGKILL", evidence);
    await waitFor(closed, TERMINATION_GRACE_MS);
  }
  const groupAbsentObserved =
    pid !== undefined && process.platform !== "win32"
      ? await waitFor(() => !groupExists(pid), TERMINATION_GRACE_MS)
      : false;
  return {
    reason,
    groupTerminationAttempted: evidence.group,
    directTerminationAttempted: evidence.direct,
    closeObserved: closed(),
    groupAbsentObserved,
    containmentUncertain: evidence.failed || !closed() || !groupAbsentObserved,
  };
}
function capture(limit: number): StreamCapture {
  return { chunks: [], tail: Buffer.alloc(0), bytes: 0, limit, overflow: false };
}
function abortedBeforeSpawn(): BoundedProcessResult {
  return {
    pid: undefined,
    status: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTail: "",
    stderrTail: "",
    termination: {
      reason: "aborted",
      groupTerminationAttempted: false,
      directTerminationAttempted: false,
      closeObserved: true,
      groupAbsentObserved: true,
      containmentUncertain: false,
    },
  };
}
function processResult(
  child: ChildProcess,
  stdout: StreamCapture,
  stderr: StreamCapture,
  error?: Error,
  termination?: TerminationEvidence,
): BoundedProcessResult {
  return {
    pid: child.pid,
    status: child.exitCode,
    signal: child.signalCode,
    stdout: termination ? "" : Buffer.concat(stdout.chunks).toString("utf8"),
    stderr: termination ? "" : Buffer.concat(stderr.chunks).toString("utf8"),
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTail: boundedDiagnosticTail(stdout.tail.toString("utf8")),
    stderrTail: boundedDiagnosticTail(stderr.tail.toString("utf8")),
    ...(error ? { error } : {}),
    ...(termination ? { termination } : {}),
  };
}

/** Resolves only after exit or after bounded TERM/KILL cleanup on timeout or overflow. */
export async function runBoundedProcess(
  request: BoundedProcessRequest,
): Promise<BoundedProcessResult> {
  if (request.signal?.aborted) return abortedBeforeSpawn();
  const stdout = capture(request.stdoutLimitBytes ?? MAX_STDOUT_BYTES);
  const stderr = capture(request.stderrLimitBytes ?? MAX_STDERR_BYTES);
  const child = spawn(request.command, [...(request.args ?? [])], {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false;
  let spawnError: Error | undefined;
  let requestedReason: TerminationEvidence["reason"] | undefined;
  let resolveClosed: (() => void) | undefined;
  const closedPromise = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", () => {
    closed = true;
    resolveClosed?.();
  });
  const requestOverflow = (reason: TerminationEvidence["reason"]): void => {
    requestedReason ??= reason;
  };
  const requestAbort = (): void => {
    requestedReason ??= "aborted";
  };
  if (request.signal?.aborted) requestAbort();
  else request.signal?.addEventListener("abort", requestAbort, { once: true });
  attachCapture(child.stdout, stdout, () => requestOverflow("stdout_overflow"));
  attachCapture(child.stderr, stderr, () => requestOverflow("stderr_overflow"));
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") spawnError ??= error;
  });
  if (request.input !== undefined) child.stdin?.end(request.input);
  else child.stdin?.end();
  const timer = setTimeout(() => {
    requestedReason ??= "timeout";
  }, request.timeoutMs);
  timer.unref();
  while (!closed && !requestedReason) await Promise.race([closedPromise, delay(10)]);
  clearTimeout(timer);
  request.signal?.removeEventListener("abort", requestAbort);
  const termination = requestedReason
    ? await terminate(child, requestedReason, () => closed)
    : undefined;
  if (!closed) await Promise.race([closedPromise, delay(TERMINATION_GRACE_MS)]);
  if (!closed) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  return processResult(child, stdout, stderr, spawnError, termination);
}
