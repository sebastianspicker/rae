/** Captures isolated Chromium pages with explicit viewport emulation and bounded protocol messages. */
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Chromium protocol response");
  return value as JsonObject;
}
interface Pending {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
class Protocol {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      try {
        this.receive(event.data);
      } catch {
        this.fail(new Error("Invalid or oversized Chromium protocol message"));
      }
    });
    socket.addEventListener("close", () => this.fail(new Error("Chromium connection closed")));
    socket.addEventListener("error", () => this.fail(new Error("Chromium connection failed")));
  }
  private receive(data: unknown): void {
    if (typeof data !== "string" || Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
      throw new Error("Invalid message");
    const response = object(JSON.parse(data));
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    const result = response.error ? {} : object(response.result);
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error("Chromium command failed"));
    else pending.resolve(result);
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket.close();
  }
  request(method: string, params: JsonObject = {}): Promise<JsonObject> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chromium ${method} timed out`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void {
    this.fail(new Error("Chromium capture complete"));
  }
}
async function pageEndpoint(
  profile: string,
  child: ChildProcess,
  failed: () => Error | undefined,
): Promise<string> {
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 10_000;
  while (!existsSync(portFile)) {
    const error = failed();
    if (error) throw error;
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
      throw new Error("Chromium did not start its local debugger");
    await sleep(25);
  }
  const port = debuggerPort(portFile);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  const body = await targetListBytes(response);
  const targets: unknown = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(targets)) throw new Error("Invalid Chromium target list");
  const page = targets
    .map(object)
    .find((target) => target.type === "page" && target.url === "about:blank");
  if (typeof page?.webSocketDebuggerUrl !== "string")
    throw new Error("Chromium page target unavailable");
  const endpoint = new URL(page.webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" || endpoint.host !== `127.0.0.1:${port}`)
    throw new Error("Non-local Chromium debugger target");
  return endpoint.href;
}
function debuggerPort(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid Chromium debugger metadata");
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer);
    if (count > 4096) throw new Error("Oversized Chromium debugger metadata");
    const port = Number(buffer.subarray(0, count).toString("utf8").split("\n")[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid Chromium debugger port");
    return port;
  } finally {
    closeSync(fd);
  }
}
async function targetListBytes(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!response.ok || !reader) throw new Error("Chromium target list unavailable");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Oversized Chromium target list");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
}
async function connect(endpoint: string): Promise<Protocol> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Chromium connection timed out"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("Chromium connection failed"));
      },
      { once: true },
    );
  });
  return new Protocol(socket);
}
function browserState() {
  return {
    ready: document.documentElement.dataset.captureReady === "true",
    error: document.documentElement.dataset.captureError ?? null,
    width: window.innerWidth,
    height: window.innerHeight,
    contentWidth: document.documentElement.scrollWidth,
  };
}
async function waitForReady(protocol: Protocol, width: number, height: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const evaluation = await protocol.request("Runtime.evaluate", {
      expression: `(${browserState.toString()})()`,
      returnByValue: true,
    });
    const state = object(object(evaluation.result).value);
    if (state.error) throw new Error(`Operator fixture reported a browser error: ${state.error}`);
    if (state.ready) {
      if (state.width !== width || state.height !== height)
        throw new Error("Chromium viewport did not match requested dimensions");
      if (typeof state.contentWidth !== "number" || state.contentWidth > width)
        throw new Error(
          `Operator page overflows the ${width}px viewport (${state.contentWidth}px)`,
        );
      return;
    }
    await sleep(50);
  }
  throw new Error("Operator fixture did not reach the connected Graph view");
}
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
async function stop(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    const deadline = Date.now() + 1000;
    while (groupAlive(pid) && Date.now() < deadline) await sleep(25);
    if (!groupAlive(pid)) return;
  }
  child.unref();
  throw new Error("Chromium process-group containment is uncertain; capture profile retained");
}
export async function captureViewport(
  browser: string,
  url: string,
  output: string,
  width: number,
  height: number,
): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "rae-browser-capture-"));
  const child = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  let startupError: Error | undefined;
  child.once("error", (error) => {
    startupError = error;
  });
  let protocol: Protocol | undefined;
  try {
    protocol = await connect(await pageEndpoint(profile, child, () => startupError));
    if (startupError) throw startupError;
    await protocol.request("Page.enable");
    // Explicit dimensions avoid Chromium window-manager minimum widths on macOS.
    await protocol.request("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await protocol.request("Page.navigate", { url });
    await waitForReady(protocol, width, height);
    const screenshot = await protocol.request("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (typeof screenshot.data !== "string")
      throw new Error("Chromium did not return a screenshot");
    writeFileSync(output, Buffer.from(screenshot.data, "base64"));
    console.log(`Captured connected Graph view at ${width}x${height} without page overflow`);
  } finally {
    protocol?.close();
    await stop(child);
    rmSync(profile, { recursive: true, force: true });
  }
}
