/** Facade for contained OpenCode execution, identity, and doctor checks. */
import { spawnSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { assertEffectiveConfiguration, permissionSurface } from "./opencode-policy.mjs";
import {
  executableFromPath,
  prepareRuntime,
  runtimeIdentity,
  assertExecutable,
} from "./opencode-runtime.mjs";
import { brokerEvidence, parseEvents } from "./opencode-events.mjs";
import { probeEffectiveConfig, processFailure, spawnContained } from "./opencode-sandbox.mjs";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export { opencodeSandboxProfile } from "./opencode-sandbox.mjs";

export function opencodeVersion(options = {}) {
  const env = options.env ?? process.env,
    executable = executableFromPath("opencode", env);
  if (!executable) throw new Error("OpenCode CLI is not available on PATH");
  const proc = spawnSync(executable, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  const error = processFailure("OpenCode version probe", proc);
  if (error) throw error;
  const version = String(proc.stdout).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`OpenCode returned an invalid version: ${version || "empty"}`);
  return runtimeIdentity(executable, version);
}
function assertEligibility(options) {
  if (unsupportedPlatform(options))
    throw new Error("OpenCode execution requires the documented macOS sandbox backend");
  if (missingModel(options))
    throw new Error("OpenCode execution requires an explicit provider/model");
  if (unsafeWriteRoute(options))
    throw new Error("OpenCode write routes require an isolated RAE worktree and reject --in-place");
}
function unsupportedPlatform(options) {
  return (options.platform ?? process.platform) !== "darwin";
}
function missingModel(options) {
  return !options.model;
}
function unsafeWriteRoute(options) {
  if (options.sandboxMode !== "workspace-write") return false;
  if (options.inPlace) return true;
  return Boolean(
    options.sourceRoot && realpathSync(options.sourceRoot) === realpathSync(options.workspaceRoot),
  );
}
function runArgs(options) {
  const args = [
    "--pure",
    "run",
    "--format",
    "json",
    "--dir",
    options.workspaceRoot,
    "--agent",
    "rae",
    "--model",
    options.model,
    "--title",
    `rae-${options.runId ?? "run"}-${options.phase ?? "phase"}`,
  ];
  if (options.variant) args.push("--variant", options.variant);
  return args;
}
function result(context) {
  const { parsed, identity, runtime, digest, options } = context;
  const commandEvents = brokerEvidence(runtime, options.phase);
  return {
    ...parsed,
    eventLogPath: options.eventLogPath,
    commandEvents,
    commandEventCount: commandEvents.length,
    successfulCommandEventCount: commandEvents.filter((event) => event.successful).length,
    resourceUsage: {
      measurement_status: "unavailable",
      missing_measurements: ["input_tokens", "output_tokens"],
      parser: "opencode-json-events-v1",
    },
    executorVersion: identity.version,
    executorPathDigest: identity.binary_digest,
    effectiveConfigDigest: digest,
    capabilitySurface: {
      read: true,
      glob: true,
      grep: true,
      edit: options.sandboxMode === "workspace-write",
      verification_broker: true,
      shell: false,
      web: false,
      external_directory: false,
      subagents: false,
      skills: false,
      plugins: false,
      mcp_servers: ["rae-verification"],
    },
    credentialManifest: runtime.authSource
      ? [{ provider: options.model?.split("/")[0] ?? null, source: "opencode-auth-store" }]
      : [],
  };
}
export function runOpenCodePhase(options) {
  assertEligibility(options);
  const env = options.env ?? process.env,
    identity = opencodeVersion({ env }),
    runtime = prepareRuntime({
      env,
      workspaceRoot: options.workspaceRoot,
      sandboxMode: options.sandboxMode,
      authPath: options.authPath,
    });
  try {
    const digest = probeEffectiveConfig(identity.executable, options, runtime),
      { proc } = spawnContained({
        executable: identity.executable,
        args: runArgs(options),
        options,
        runtime,
        input: options.prompt,
      }),
      failure = processFailure("OpenCode phase", proc);
    if (failure) throw failure;
    const parsed = parseEvents(
      proc.stdout,
      Object.freeze({
        authorizedRoot: options.eventLogRoot ?? options.workspaceRoot,
        eventLogPath: options.eventLogPath,
      }),
    );
    return result(Object.freeze({ parsed, identity, runtime, digest, options }));
  } finally {
    rmSync(runtime.root, { recursive: true, force: true });
  }
}
function doctorResult(options) {
  return {
    success: false,
    provider: "opencode",
    sandbox_enforced: false,
    platform: options.platform ?? process.platform,
    model: options.model ?? null,
  };
}
function doctorRuntime(options, result) {
  if (!options.model) throw new Error("OpenCode doctor requires an explicit provider/model");
  if (result.platform !== "darwin")
    throw new Error("OpenCode write routes are supported only by the documented macOS backend");
  const env = options.env ?? process.env,
    identity = opencodeVersion({ env });
  if (!options.allowTestSandbox)
    assertExecutable(options.sandboxExecutable ?? SANDBOX_EXEC, { requireRoot: true });
  const workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
  return {
    env,
    identity,
    workspaceRoot,
    runtime: prepareRuntime({
      env,
      workspaceRoot,
      sandboxMode: options.sandboxMode ?? "read-only",
      authPath: options.authPath,
    }),
  };
}
function doctorSuccess(context) {
  const { result, options, prepared } = context;
  const { identity, workspaceRoot, runtime } = prepared;
  return {
    ...result,
    success: true,
    executable: identity.executable,
    version: identity.version,
    sandbox_enforced: true,
    effective_config_digest: probeEffectiveConfig(
      identity.executable,
      { ...options, workspaceRoot, timeoutMs: options.timeoutMs ?? 10_000 },
      runtime,
    ),
    readiness: runtime.authSource ? "authenticated-store-present" : "credential-store-unavailable",
    detail: "OpenCode has an exact denied-by-default tool surface under the macOS sandbox backend",
  };
}
export function openCodeDoctor(options = {}) {
  const result = doctorResult(options);
  try {
    const prepared = doctorRuntime(options, result);
    try {
      return doctorSuccess({ result, options, prepared });
    } finally {
      rmSync(prepared.runtime.root, { recursive: true, force: true });
    }
  } catch (error) {
    return { ...result, detail: error.message };
  }
}
export const _test = Object.freeze({
  assertEffectiveConfiguration,
  parseEvents,
  permissionSurface,
});
