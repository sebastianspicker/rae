/** Selects providers while retaining RAE's public autonomous execution facade. */
import { spawnSync } from "node:child_process";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_BYTES,
  executableFromPath,
  failureExcerpt,
  minimalChildEnvironment,
  parseArtifact,
  timeoutError,
} from "./agent-provider-runtime.mjs";
import {
  codexDoctorResult,
  providerRuntimeIdentity as codexProviderRuntimeIdentity,
  runCodexPhase,
} from "./codex-adapter.mjs";
import { openCodeDoctor, opencodeVersion, runOpenCodePhase } from "./opencode-adapter.mjs";

export { minimalChildEnvironment, signalProcessGroup } from "./agent-provider-runtime.mjs";

function resolveProvider(options) {
  const requested = options.provider ?? "auto";
  if (requested === "auto") {
    if (executableFromPath("codex", options.env)) return "codex";
    throw new Error(
      "no autonomous agent provider is available; install Codex CLI or pass --provider command with --agent-command",
    );
  }
  if (!["codex", "opencode", "command"].includes(requested)) {
    throw new Error(
      `unsupported autonomous provider: ${requested} (expected codex, opencode, or command)`,
    );
  }
  return requested;
}

function runCommandProvider({
  command,
  commandArgs,
  phase,
  runId,
  workspaceRoot,
  schemaPath,
  prompt,
  sandboxMode,
  timeoutMs,
  env,
}) {
  if (!command) throw new Error("--provider command requires --agent-command <executable>");
  const executable = executableFromPath(command, env);
  if (!executable) throw new Error(`agent command is not executable: ${command}`);
  const proc = spawnSync(
    executable,
    commandArgs ?? [],
    commandProviderInvocation({
      phase,
      runId,
      workspaceRoot,
      schemaPath,
      prompt,
      sandboxMode,
      timeoutMs,
      env,
    }),
  );
  assertCommandProcessSucceeded(proc, timeoutMs);
  return { artifact: parseArtifact(proc.stdout, "agent command") };
}

function commandProviderInvocation({
  phase,
  runId,
  workspaceRoot,
  schemaPath,
  prompt,
  sandboxMode,
  timeoutMs,
  env,
}) {
  const request = {
    protocol_version: "rae-agent-v1",
    phase,
    run_id: runId,
    workspace_root: workspaceRoot,
    schema_path: schemaPath,
    sandbox_mode: sandboxMode,
    prompt,
  };
  return {
    cwd: workspaceRoot,
    env: {
      ...minimalChildEnvironment(env, workspaceRoot),
      RAE_AGENT_PROTOCOL: "rae-agent-v1",
      RAE_AGENT_PHASE: phase,
      RAE_AGENT_RUN_ID: runId,
      RAE_AGENT_WORKSPACE_ROOT: workspaceRoot,
      RAE_AGENT_SCHEMA_PATH: schemaPath,
      RAE_AGENT_SANDBOX_MODE: sandboxMode,
    },
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: timeoutMs,
    detached: process.platform !== "win32",
    killSignal: "SIGTERM",
    maxBuffer: MAX_AGENT_OUTPUT_BYTES,
  };
}

function assertCommandProcessSucceeded(proc, timeoutMs) {
  if (proc.error) {
    if (proc.error.code === "ETIMEDOUT") throw timeoutError("agent command", timeoutMs, proc);
    throw new Error(`agent command failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0)
    throw new Error(`agent command exited with status ${proc.status}: ${failureExcerpt(proc)}`);
}

/** Executes the selected provider without leaking raw credentials or accepting malformed agent artifacts. */
export function runAgentPhase(options) {
  const provider = resolveProvider(options);
  if (provider === "command" && options.allowUnsafeCommand !== true) {
    throw new Error(
      "the unsandboxed command provider is disabled; test integrations must pass --allow-unsafe-command-provider explicitly",
    );
  }
  const startedAt = Date.now();
  const execution = runProviderAdapter(provider, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
  });
  return { provider, ...execution, durationMs: Date.now() - startedAt };
}

function runProviderAdapter(provider, options) {
  if (provider === "codex") return runCodexPhase(options);
  if (provider === "opencode") return runOpenCodePhase(options);
  return runCommandProvider(options);
}

/** Returns the exact provider runtime identity used in immutable run provenance. */
export function providerRuntimeIdentity(provider, options = {}) {
  if (provider === "opencode") return opencodeVersion(options);
  return codexProviderRuntimeIdentity(provider, options);
}

function unavailableCodexDoctorResult() {
  return {
    success: false,
    provider: "codex",
    executable: null,
    sandbox_enforced: false,
    detail: "Codex CLI is not available on PATH",
  };
}

function commandDoctorResult(options, childEnv, provider) {
  const executable = executableFromPath(options.command, childEnv);
  return {
    success: false,
    provider,
    executable,
    sandbox_enforced: false,
    available: Boolean(executable),
    detail: executable
      ? "custom command protocol is available but intentionally fails doctor because it has no enforced sandbox"
      : "custom agent command is unavailable and has no enforced sandbox",
  };
}

/** Checks agent availability and runtime capabilities before an autonomous workflow starts work. */
export function agentDoctor(options = {}) {
  const sourceEnv = options.env ?? process.env;
  const childEnv = minimalChildEnvironment(sourceEnv, process.cwd());
  if (options.provider === "opencode") return openCodeDoctor({ ...options, env: sourceEnv });
  let codexExecutable = null;
  if (["auto", "codex"].includes(options.provider ?? "auto")) {
    codexExecutable = executableFromPath("codex", childEnv);
    if (!codexExecutable) return unavailableCodexDoctorResult();
  }
  const provider = resolveProvider({ ...options, env: childEnv });
  if (provider === "command") return commandDoctorResult(options, childEnv, provider);
  return codexDoctorResult({
    executable: codexExecutable ?? executableFromPath("codex", childEnv),
    options,
    sourceEnv,
    provider,
  });
}
