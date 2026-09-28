/** Supervises a process group with deadlines and bounded durable output. */
import { closeSync, fstatSync, writeSync, fsyncSync } from "node:fs";
import { basename, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { openFileAt, openRoot } from "@rae/fs-bridge";

export const TIMEOUT_EXIT = 124;
export const OVERFLOW_EXIT = 125;
export const CONTAINMENT_EXIT = 126;
export const ABORT_EXIT = 130;
export const RAW_LIMIT = 16 * 1024 * 1024;
export const REPORT_LIMIT = 2 * 1024 * 1024;
export interface SuperviseOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: Buffer;
  timeoutSeconds: number;
  graceSeconds?: number;
  rawOutput: string;
  report: string;
  rawLimit?: number;
  reportLimit?: number;
  signal?: AbortSignal;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}
async function waitUntil(done: () => boolean, duration: number): Promise<boolean> {
  const deadline = Date.now() + duration;
  while (!done() && Date.now() < deadline) await delay(20);
  return done();
}
class ProcessGroup {
  closed = false;
  cleanup: Promise<boolean> | undefined;
  private notifyStopped: () => void = () => {};
  readonly stopped = new Promise<void>((resolve) => {
    this.notifyStopped = resolve;
  });
  constructor(
    private readonly child: ChildProcess,
    private readonly grace: number,
  ) {}
  stop(): void {
    this.cleanup ??= this.terminate();
    this.notifyStopped();
  }
  private async terminate(): Promise<boolean> {
    const pid = this.child.pid;
    if (pid === undefined) return this.closed;
    try {
      signalGroup(pid, "SIGINT");
      const absent = (): boolean => this.closed && !groupExists(pid);
      if (await waitUntil(absent, this.grace)) return true;
      signalGroup(pid, "SIGKILL");
      return await waitUntil(absent, 1000);
    } catch {
      return false;
    }
  }
}
function reportSize(parent: number, name: string): number {
  let fd: number;
  try {
    fd = openFileAt(parent, name, "read");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}
class OutputCapture {
  written = 0;
  overflow = false;
  error: unknown;
  constructor(
    private readonly fd: number,
    private readonly limit: number,
    private readonly group: ProcessGroup,
  ) {}
  consume = (chunk: Buffer): void => {
    if (this.error) return;
    try {
      const kept = chunk.subarray(0, Math.max(0, this.limit - this.written));
      let offset = 0;
      while (offset < kept.length) offset += writeSync(this.fd, kept, offset, kept.length - offset);
      this.written += kept.length;
      if (kept.length < chunk.length) {
        this.overflow = true;
        this.group.stop();
      }
    } catch (error) {
      this.error = error;
      this.group.stop();
    }
  };
  checkReport(parent: number, name: string, limit: number): void {
    try {
      if (reportSize(parent, name) > limit) {
        this.overflow = true;
        this.group.stop();
      }
    } catch (error) {
      this.error = error;
      this.group.stop();
    }
  }
}
async function runChild(options: SuperviseOptions, parent: number, fd: number): Promise<number> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const group = new ProcessGroup(child, (options.graceSeconds ?? 15) * 1000);
  const capture = new OutputCapture(fd, options.rawLimit ?? RAW_LIMIT, group);
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      group.closed = true;
      resolve(status ?? 1);
    });
  });
  child.stdin?.on("error", () => {
    /* Early prompt closure is a provider outcome. */
  });
  child.stdout?.on("data", capture.consume);
  child.stderr?.on("data", capture.consume);
  child.stdin?.end(options.input);
  let timedOut = false;
  const abort = (): void => group.stop();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const deadline = setTimeout(() => {
    timedOut = true;
    group.stop();
  }, options.timeoutSeconds * 1000).unref();
  const checkReport = (): void =>
    capture.checkReport(parent, basename(options.report), options.reportLimit ?? REPORT_LIMIT);
  const reportWatch = setInterval(checkReport, 100).unref();
  try {
    // A close event is insufficient: descendants with private stdio can survive it.
    const result = await Promise.race([
      closed,
      group.stopped.then(async () => {
        await group.cleanup;
        return 1;
      }),
    ]);
    checkReport();
    if (group.cleanup && !(await group.cleanup)) {
      process.stderr.write("[ralph] process containment uncertain after group termination\n");
      return CONTAINMENT_EXIT;
    }
    if (capture.error) throw capture.error;
    if (options.signal?.aborted) return ABORT_EXIT;
    return capture.overflow ? OVERFLOW_EXIT : timedOut ? TIMEOUT_EXIT : result;
  } finally {
    clearTimeout(deadline);
    clearInterval(reportWatch);
    options.signal?.removeEventListener("abort", abort);
    if (group.cleanup) await group.cleanup;
    child.stdout?.off("data", capture.consume);
    child.stderr?.off("data", capture.consume);
    if (!group.closed) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  }
}
export async function supervise(options: SuperviseOptions): Promise<number> {
  if (options.signal?.aborted) return ABORT_EXIT;
  if (dirname(options.rawOutput) !== dirname(options.report))
    throw new Error("Provider outputs must share a private directory");
  const parent = openRoot(dirname(options.rawOutput));
  let fd: number | undefined;
  try {
    fd = openFileAt(parent, basename(options.rawOutput), "create");
    return await runChild(options, parent, fd);
  } finally {
    try {
      if (fd !== undefined) {
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      closeSync(parent);
    }
  }
}
