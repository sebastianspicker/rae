/** Builds macOS Seatbelt containment and runs OpenCode within it. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redact } from "./agent-provider-runtime.mjs";
import {
  BROKER_PATH,
  assertEffectiveConfiguration,
  assertNoProjectExtensions,
} from "./opencode-policy.mjs";
import { assertExecutable } from "./opencode-runtime.mjs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const escapeSeatbelt = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
function terminateProcessGroup(proc) {
  if (!Number.isInteger(proc.pid) || proc.pid <= 0 || process.platform === "win32") return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    process.kill(-proc.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
function navigation(paths) {
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
}) {
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
  ])
    if (pathValue) {
      const value = escapeSeatbelt(pathValue);
      rules.push(`(deny file-read* file-write* (literal "${value}") (subpath "${value}"))`);
    }
  for (const pathValue of ["evals/fixtures", "evals/judges", "evals/policies"])
    rules.push(
      `(deny file-write* (subpath "${escapeSeatbelt(resolve(workspaceRoot, pathValue))}"))`,
    );
  return rules.join("\n");
}
export function processFailure(label, proc) {
  if (proc.error?.code === "ETIMEDOUT") {
    terminateProcessGroup(proc);
    return new Error(`${label} timed out; contained process-group termination was attempted`);
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
export function spawnContained(request) {
  const { executable, args, options, runtime, input } = request;
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
  const proc = spawnSync(sandbox, ["-p", profile, executable, ...args], {
    cwd: options.workspaceRoot,
    env: runtime.env,
    input,
    encoding: "utf8",
    timeout: options.timeoutMs,
    detached: process.platform !== "win32",
    killSignal: "SIGTERM",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
  });
  return { proc, profile };
}
export function probeEffectiveConfig(executable, options, runtime) {
  assertNoProjectExtensions(options.workspaceRoot);
  const { proc } = spawnContained({
    executable,
    args: ["--pure", "debug", "config"],
    options,
    runtime,
  });
  const error = processFailure("OpenCode effective-config probe", proc);
  if (error) throw error;
  let config;
  try {
    config = JSON.parse(proc.stdout);
  } catch (caught) {
    throw new Error(`OpenCode effective-config probe returned invalid JSON: ${caught.message}`);
  }
  assertEffectiveConfiguration(config, runtime.configValue);
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
