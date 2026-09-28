/** Selects providers while retaining RAE's public autonomous execution facade. */
import {
  DEFAULT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_BYTES,
  executableFromPath,
  failureExcerpt,
  minimalChildEnvironment,
  parseArtifact,
  boundedProcessFailure,
} from "./agent-provider-runtime.js";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";
import {
  codexDoctorResult,
  providerRuntimeIdentity as codexProviderRuntimeIdentity,
  runCodexPhase,
  type CodexPhaseOptions,
} from "./codex-adapter.js";
import {
  openCodeDoctor,
  opencodeVersion,
  runOpenCodePhase,
  type OpenCodePhaseOptions,
} from "./opencode-adapter.js";
import type { CapabilitySet } from "../workflow/execution-profile.js";

export { minimalChildEnvironment, signalProcessGroup } from "./agent-provider-runtime.js";

export type AgentProvider = "codex" | "opencode" | "command";

export interface AgentPhaseOptions {
  provider?: AgentProvider | "auto";
  env?: NodeJS.ProcessEnv;
  command?: string;
  commandArgs?: readonly string[];
  phase: string;
  runId: string;
  workspaceRoot: string;
  schemaPath: string;
  outputPath?: string;
  eventLogPath?: string;
  eventLogRoot?: string;
  prompt: string;
  sandboxMode: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowUnsafeCommand?: boolean;
  model?: string;
  reasoningEffort?: string;
  capabilities?: CapabilitySet | null;
  variant?: string;
  routeId?: string | null;
  platform?: NodeJS.Platform | string;
  allowTestSandbox?: boolean;
  sandboxExecutable?: string;
  sourceRoot?: string;
  runDir?: string;
  authPath?: string;
  inPlace?: boolean;
}

interface ResolvedAgentPhaseOptions extends AgentPhaseOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface AgentExecutionResult extends Record<string, unknown> {
  artifact: Record<string, unknown>;
  eventLogPath?: string;
  eventCount?: number;
  commandEventCount?: number;
  commandEvents?: Array<Record<string, unknown>>;
}

interface CommandProviderInvocation {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  encoding: "utf8";
  timeout: number;
  detached: boolean;
  killSignal: "SIGTERM";
  maxBuffer: number;
}

function resolveProvider(options: Pick<AgentPhaseOptions, "provider" | "env">): AgentProvider {
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

async function runCommandProvider({
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
  signal,
}: ResolvedAgentPhaseOptions): Promise<AgentExecutionResult> {
  if (!command) throw new Error("--provider command requires --agent-command <executable>");
  const executable = executableFromPath(command, env);
  if (!executable) throw new Error(`agent command is not executable: ${command}`);
  const invocation = commandProviderInvocation({
    phase,
    runId,
    workspaceRoot,
    schemaPath,
    prompt,
    sandboxMode,
    timeoutMs,
    env,
  });
  const proc = await runBoundedProcess({
    command: executable,
    args: commandArgs ?? [],
    cwd: invocation.cwd,
    env: invocation.env,
    input: invocation.input,
    timeoutMs,
    signal,
  });
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
}: ResolvedAgentPhaseOptions): CommandProviderInvocation {
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

function assertCommandProcessSucceeded(proc: BoundedProcessResult, timeoutMs: number): void {
  const boundedFailure = boundedProcessFailure("agent command", timeoutMs, proc);
  if (boundedFailure) throw boundedFailure;
  if (proc.error) {
    throw new Error(`agent command failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0)
    throw new Error(`agent command exited with status ${proc.status}: ${failureExcerpt(proc)}`);
}

/** Executes the selected provider without leaking raw credentials or accepting malformed agent artifacts. */
export async function runAgentPhase(
  options: AgentPhaseOptions,
): Promise<AgentExecutionResult & { provider: AgentProvider; durationMs: number }> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new DOMException("Agent phase aborted", "AbortError");
  }
  const provider = resolveProvider(options);
  if (provider === "command" && options.allowUnsafeCommand !== true) {
    throw new Error(
      "the unsandboxed command provider is disabled; test integrations must pass --allow-unsafe-command-provider explicitly",
    );
  }
  const startedAt = Date.now();
  const execution = await runProviderAdapter(provider, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
  });
  return { provider, ...execution, durationMs: Date.now() - startedAt };
}

async function runProviderAdapter(
  provider: AgentProvider,
  options: ResolvedAgentPhaseOptions,
): Promise<AgentExecutionResult> {
  if (provider === "codex") {
    return (await runCodexPhase(options as unknown as CodexPhaseOptions)) as AgentExecutionResult;
  }
  if (provider === "opencode") {
    return (await runOpenCodePhase(
      options as unknown as OpenCodePhaseOptions,
    )) as AgentExecutionResult;
  }
  return runCommandProvider(options);
}

export interface ProviderIdentityOptions {
  env?: NodeJS.ProcessEnv;
  [key: string]: unknown;
}
export interface ProviderRuntimeIdentity extends Record<string, unknown> {
  version: string;
  binary_digest?: string | null;
}

/** Returns the exact provider runtime identity used in immutable run provenance. */
export function providerRuntimeIdentity(
  provider: AgentProvider,
  options: ProviderIdentityOptions = {},
): ProviderRuntimeIdentity {
  if (provider === "opencode") return opencodeVersion(options) as ProviderRuntimeIdentity;
  return codexProviderRuntimeIdentity(provider, options) as ProviderRuntimeIdentity;
}

interface AgentDoctorOptions extends ProviderIdentityOptions {
  provider?: AgentProvider | "auto";
  command?: string;
}

export interface DoctorResult extends Record<string, unknown> {
  success: boolean;
  provider: string;
}

function unavailableCodexDoctorResult(): DoctorResult {
  return {
    success: false,
    provider: "codex",
    executable: null,
    sandbox_enforced: false,
    detail: "Codex CLI is not available on PATH",
  };
}

function commandDoctorResult(
  options: AgentDoctorOptions,
  childEnv: NodeJS.ProcessEnv,
  provider: AgentProvider,
): DoctorResult {
  const executable = options.command ? executableFromPath(options.command, childEnv) : null;
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
export function agentDoctor(options: AgentDoctorOptions = {}): DoctorResult {
  const sourceEnv = options.env ?? process.env;
  const childEnv = minimalChildEnvironment(sourceEnv, process.cwd());
  if (options.provider === "opencode")
    return openCodeDoctor({ ...options, env: sourceEnv }) as DoctorResult;
  let codexExecutable = null;
  if (["auto", "codex"].includes(options.provider ?? "auto")) {
    codexExecutable = executableFromPath("codex", childEnv);
    if (!codexExecutable) return unavailableCodexDoctorResult();
  }
  const provider = resolveProvider({ ...options, env: childEnv });
  if (provider === "command") return commandDoctorResult(options, childEnv, provider);
  const executable = codexExecutable ?? executableFromPath("codex", childEnv);
  if (!executable) return unavailableCodexDoctorResult();
  return codexDoctorResult({
    executable,
    options,
    sourceEnv,
    provider,
  }) as DoctorResult;
}
