/** Builds macOS Seatbelt containment and runs OpenCode within it. */
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redact } from "./agent-provider-runtime.js";
import { boundedProcessFailure } from "./agent-provider-runtime.js";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";
import {
  BROKER_PATH,
  assertEffectiveConfiguration,
  assertNoProjectExtensions,
} from "./opencode-policy.js";
import { assertExecutable } from "./opencode-runtime.js";
import type { OpenCodeRuntime } from "./opencode-runtime.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const escapeSeatbelt = (value: string): string =>
  String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

interface OpenCodeSandboxOptions {
  workspaceRoot: string;
  sourceRoot?: string;
  runDir?: string;
  sandboxMode: string;
  timeoutMs: number;
  sandboxExecutable?: string;
  allowTestSandbox?: boolean;
  signal?: AbortSignal;
}

interface OpenCodeSandboxProfileOptions {
  workspaceRoot: string;
  sourceRoot?: string;
  runDir?: string;
  runtimeRoot: string;
  authSource?: string;
  executable: string;
  sandboxMode: string;
}

interface ContainedRequest {
  executable: string;
  args: readonly string[];
  options: OpenCodeSandboxOptions;
  runtime: OpenCodeRuntime;
  input?: string;
}

interface ContainedResult {
  proc: SpawnSyncReturns<string>;
  profile: string;
}
interface AsyncContainedResult {
  proc: BoundedProcessResult;
  profile: string;
}
function navigation(paths: readonly string[]): string {
  const values = new Set(["/", "/tmp", "/var"]);
  for (const pathValue of paths) {
    let current = resolve(pathValue);
    while (current !== "/") {
      values.add(current);
      current = dirname(current);
    }
  }
  return [...values]
    .sort()
    .map((pathValue) => `(literal "${escapeSeatbelt(pathValue)}")`)
    .join(" ");
}

export function opencodeSandboxProfile({
  workspaceRoot,
  sourceRoot,
  runDir,
  runtimeRoot,
  authSource,
  executable,
  sandboxMode,
}: OpenCodeSandboxProfileOptions): string {
  const workspace = escapeSeatbelt(realpathSync(workspaceRoot)),
    runtime = escapeSeatbelt(realpathSync(runtimeRoot)),
    binary = escapeSeatbelt(realpathSync(executable)),
    directory = escapeSeatbelt(dirname(realpathSync(executable))),
    node = escapeSeatbelt(realpathSync(process.execPath));
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-info*)",
    `(allow process-exec (literal "${binary}") (literal "${node}") (literal "/usr/bin/git") (literal "/usr/bin/sandbox-exec") (literal "/usr/libexec/git-core/git") (literal "/Library/Developer/CommandLineTools/usr/bin/git"))`,
    "(allow signal (target self))",
    "(allow ipc-posix*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    `(allow file-read* ${navigation([workspaceRoot, runtimeRoot, executable, process.execPath, BROKER_PATH])})`,
    '(allow file-read* (subpath "/$bunfs") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/libexec/git-core") (subpath "/usr/share") (subpath "/Library/Apple") (subpath "/Library/Developer/CommandLineTools") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/select") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero"))',
    `(allow file-read* (subpath "${workspace}") (subpath "${runtime}") (subpath "${directory}") (literal "${binary}") (literal "${node}"))`,
    `(allow file-write* (subpath "${runtime}"))`,
    '(allow file-write* (literal "/dev/null"))',
    "(allow network-outbound)",
    "(deny network-inbound)",
  ];
  if (sandboxMode === "workspace-write") rules.push(`(allow file-write* (subpath "${workspace}"))`);
  if (authSource) rules.push(`(allow file-read* (literal "${escapeSeatbelt(authSource)}"))`);
  void sourceRoot;
  for (const pathValue of [
    resolve(workspaceRoot, ".git"),
    resolve(workspaceRoot, ".pipeline"),
    runDir,
  ]) {
    if (pathValue) {
      const value = escapeSeatbelt(pathValue);
      rules.push(`(deny file-read* file-write* (literal "${value}") (subpath "${value}"))`);
    }
  }
  return rules.join("\n");
}
export function processFailure(label: string, proc: SpawnSyncReturns<string>): Error | null {
  if (proc.error && "code" in proc.error && proc.error.code === "ETIMEDOUT") {
    return new Error(`${label} timed out; synchronous probe termination completed`);
  }
  if (proc.error) return new Error(`${label} failed to start: ${proc.error.message}`);
  if (proc.status !== 0)
    return new Error(
      `${label} exited with ${proc.signal ? `signal ${proc.signal}` : `status ${proc.status}`}: ${
        redact(`${proc.stderr ?? ""}\n${proc.stdout ?? ""}`)
          .trim()
          .slice(-4000) || "no process output"
      }`,
    );
  return null;
}
function sandboxInvocation(request: ContainedRequest): {
  sandbox: string;
  args: string[];
  profile: string;
} {
  const { executable, args, options, runtime, input } = request;
  void input;
  const sandbox = options.sandboxExecutable ?? SANDBOX_EXEC;
  if (!options.allowTestSandbox) assertExecutable(sandbox, { requireRoot: true });
  const profile = opencodeSandboxProfile({
    workspaceRoot: options.workspaceRoot,
    sourceRoot: options.sourceRoot,
    runDir: options.runDir,
    runtimeRoot: runtime.root,
    authSource: runtime.authSource,
    executable,
    sandboxMode: options.sandboxMode,
  });
  return { sandbox, args: ["-p", profile, executable, ...args], profile };
}

export function spawnContained(request: ContainedRequest): ContainedResult {
  const { sandbox, args, profile } = sandboxInvocation(request);
  const proc = spawnSync(sandbox, args, {
    cwd: request.options.workspaceRoot,
    env: request.runtime.env,
    input: request.input,
    encoding: "utf8",
    timeout: request.options.timeoutMs,
    killSignal: "SIGTERM",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
  });
  return { proc, profile };
}

/** Runs a provider under a detached process group and awaits bounded cleanup. */
export async function runContained(request: ContainedRequest): Promise<AsyncContainedResult> {
  const { sandbox, args, profile } = sandboxInvocation(request);
  const proc = await runBoundedProcess({
    command: sandbox,
    args,
    cwd: request.options.workspaceRoot,
    env: request.runtime.env,
    input: request.input,
    timeoutMs: request.options.timeoutMs,
    stdoutLimitBytes: MAX_OUTPUT_BYTES,
    stderrLimitBytes: MAX_OUTPUT_BYTES,
    signal: request.options.signal,
  });
  return { proc, profile };
}

export function containedProcessFailure(
  label: string,
  timeoutMs: number,
  proc: BoundedProcessResult,
): Error | null {
  const bounded = boundedProcessFailure(label, timeoutMs, proc, {
    stdout: MAX_OUTPUT_BYTES,
    stderr: MAX_OUTPUT_BYTES,
  });
  if (bounded) return bounded;
  if (proc.error) return new Error(`${label} failed to start: ${proc.error.message}`);
  if (proc.status !== 0) {
    return new Error(
      `${label} exited with ${proc.signal ? `signal ${proc.signal}` : `status ${proc.status}`}: ${
        redact(`${proc.stderr}\n${proc.stdout}`).trim().slice(-4000) || "no process output"
      }`,
    );
  }
  return null;
}
export function probeEffectiveConfig(
  executable: string,
  options: OpenCodeSandboxOptions,
  runtime: OpenCodeRuntime,
): string {
  assertNoProjectExtensions(options.workspaceRoot);
  const { proc } = spawnContained({
    executable,
    args: ["--pure", "debug", "config"],
    options,
    runtime,
  });
  const error = processFailure("OpenCode effective-config probe", proc);
  if (error) throw error;
  let config: unknown;
  try {
    config = JSON.parse(proc.stdout) as unknown;
  } catch (caught) {
    throw new Error(
      `OpenCode effective-config probe returned invalid JSON: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OpenCode effective-config probe returned a non-object configuration");
  }
  assertEffectiveConfiguration(config as Record<string, unknown>, runtime.configValue);
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function probeEffectiveConfigAsync(
  executable: string,
  options: OpenCodeSandboxOptions,
  runtime: OpenCodeRuntime,
): Promise<string> {
  assertNoProjectExtensions(options.workspaceRoot);
  const { proc } = await runContained({
    executable,
    args: ["--pure", "debug", "config"],
    options,
    runtime,
  });
  const failure = containedProcessFailure(
    "OpenCode effective-config probe",
    options.timeoutMs,
    proc,
  );
  if (failure) throw failure;
  let config: unknown;
  try {
    config = JSON.parse(proc.stdout) as unknown;
  } catch (caught) {
    throw new Error(
      `OpenCode effective-config probe returned invalid JSON: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OpenCode effective-config probe returned a non-object configuration");
  }
  assertEffectiveConfiguration(config as Record<string, unknown>, runtime.configValue);
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
