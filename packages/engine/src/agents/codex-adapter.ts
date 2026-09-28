/** Runs Codex behind RAE's sealed environment, evidence, and doctor boundaries. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  boundedProcessFailure,
  executableFromPath,
  failureExcerpt,
  minimalChildEnvironment,
  parseArtifact,
  readBoundedProviderFile,
  replacePrivateFile,
  redact,
} from "./agent-provider-runtime.js";
import { runBoundedProcess, type BoundedProcessResult } from "./bounded-process.js";
import {
  assertProjectCodexCapabilities,
  capabilitySurface,
  codexCapabilityArgs,
  codexCapabilityOverrides,
  credentialDigestManifest,
  type CapabilitySet,
} from "./codex-capabilities.js";

const CODEX_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];
const SENSITIVE_EVENT_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?[_-]?token|token|secret|password|authorization|cookie)$/i;

interface CodexArgumentsOptions {
  workspaceRoot: string;
  schemaPath: string;
  outputPath: string;
  sandboxMode: string;
  model?: string;
  reasoningEffort?: string;
  capabilities?: CapabilitySet | null;
}

export interface CodexPhaseOptions extends CodexArgumentsOptions {
  phase: string;
  eventLogPath: string;
  eventLogRoot?: string;
  prompt: string;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface JsonObject extends Record<string, unknown> {}
interface CommandEvent {
  command: string;
  working_directory: string | null;
  phase: string | null;
  exit_code: number;
  successful: boolean;
}

interface UsageMeasurement extends Record<string, unknown> {
  measurement_status: "complete" | "partial" | "unavailable";
  missing_measurements: string[];
  parser: string;
}

interface CodexCapabilities extends Record<string, boolean | string | undefined> {
  workspace_sandbox: boolean;
  structured_output: boolean;
  ephemeral_sessions: boolean;
  event_stream: boolean;
  ignore_user_config: boolean;
  strict_config: boolean;
  authenticated: boolean;
}

export function buildCodexExecArguments({
  workspaceRoot,
  schemaPath,
  outputPath,
  sandboxMode,
  model,
  reasoningEffort,
  capabilities,
}: CodexArgumentsOptions): string[] {
  const args: string[] = [
    "-a",
    "never",
    "exec",
    ...codexCapabilityArgs(capabilities),
    "-C",
    workspaceRoot,
    "-s",
    sandboxMode,
    "--ephemeral",
    "--color",
    "never",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
  ];
  if (model) args.push("-m", model);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push("-");
  return args;
}

export function assertCodexProcessSucceeded(proc: BoundedProcessResult, timeoutMs: number) {
  const boundedFailure = boundedProcessFailure("Codex phase", timeoutMs, proc);
  if (boundedFailure) throw boundedFailure;
  if (proc.error) {
    throw new Error(`Codex failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0)
    throw new Error(`Codex exited with status ${proc.status}: ${failureExcerpt(proc)}`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function codexResourceUsage(events: unknown[]): UsageMeasurement {
  const usageEvents = events
    .filter(
      (event): event is JsonObject =>
        isJsonObject(event) && event.type === "turn.completed" && isJsonObject(event.usage),
    )
    .map((event) => event.usage as JsonObject);
  if (usageEvents.length === 0)
    return {
      measurement_status: "unavailable",
      missing_measurements: [...CODEX_USAGE_FIELDS],
      parser: "codex-turn-completed-usage-v1",
    };
  const measurement: UsageMeasurement = {
    measurement_status: "partial",
    missing_measurements: [],
    parser: "codex-turn-completed-usage-v1",
  };
  for (const field of CODEX_USAGE_FIELDS) {
    const values = usageEvents.map((usage) => usage[field]);
    if (values.some((value) => value === undefined)) {
      measurement.missing_measurements.push(field);
      continue;
    }
    if (
      values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error(`Codex usage field ${field} must be a non-negative safe integer`);
    measurement[field] = values.reduce<number>((total, value) => total + Number(value), 0);
  }
  measurement.measurement_status =
    measurement.missing_measurements.length === 0 ? "complete" : "partial";
  return measurement;
}

function evidenceWorkingDirectory(value: unknown, workspaceRoot: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (!isAbsolute(value)) return value.trim();
  const relativePath = relative(workspaceRoot, value);
  return !relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    ? relativePath || "."
    : null;
}

function sensitiveEventKey(key: string): boolean {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_EVENT_KEY_PATTERN.test(normalized);
}

function redactEventValue(value: unknown, key = ""): unknown {
  if (sensitiveEventKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactEventValue(entryValue, entryKey),
      ]),
    );
  return value;
}

function redactEventPaths(value: unknown, workspaceRoot: string, key = ""): unknown {
  if (["cwd", "working_directory", "workingDirectory"].includes(key))
    return evidenceWorkingDirectory(value, workspaceRoot);
  if (Array.isArray(value)) return value.map((entry) => redactEventPaths(entry, workspaceRoot));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactEventPaths(entryValue, workspaceRoot, entryKey),
      ]),
    );
  return value;
}

function selectCommandWorkingDirectory(item: JsonObject, event: JsonObject): unknown {
  if (Object.hasOwn(item, "cwd")) return item.cwd;
  if (Object.hasOwn(item, "working_directory")) return item.working_directory;
  return event.cwd;
}

function commandEventFrom(
  safeEvent: unknown,
  phase: string,
  workspaceRoot: string,
): CommandEvent | null {
  if (!isJsonObject(safeEvent) || safeEvent.type !== "item.completed") return null;
  const item = safeEvent.item;
  if (!isJsonObject(item) || item.type !== "command_execution") return null;
  if (typeof item.command !== "string") return null;
  const command = item.command.trim();
  if (!command) return null;
  if (!Number.isSafeInteger(item.exit_code)) return null;
  const workingDirectory = selectCommandWorkingDirectory(item, safeEvent);
  return {
    command,
    working_directory: evidenceWorkingDirectory(workingDirectory, workspaceRoot),
    phase: typeof phase === "string" ? phase : null,
    exit_code: item.exit_code as number,
    successful: item.exit_code === 0,
  };
}

interface EventContext {
  authorizedRoot: string;
  eventLogPath: string;
  phase: string;
  workspaceRoot: string;
}

function persistCodexEvents(
  raw: unknown,
  eventContext: EventContext,
): {
  eventCount: number;
  commandEventCount: number;
  successfulCommandEventCount: number;
  commandEvents: CommandEvent[];
  resourceUsage: UsageMeasurement;
} {
  const { authorizedRoot, eventLogPath, phase, workspaceRoot } = eventContext;
  const lines = String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("Codex completed without emitting its JSON event stream");
  const commandEvents: CommandEvent[] = [],
    events: unknown[] = [],
    persistedLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Codex event stream is invalid at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    events.push(event);
    const safeEvent = redactEventPaths(redactEventValue(event), workspaceRoot);
    persistedLines.push(JSON.stringify(safeEvent));
    const commandEvent = commandEventFrom(safeEvent, phase, workspaceRoot);
    if (commandEvent) commandEvents.push(commandEvent);
  }
  const body = `${persistedLines.join("\n")}\n`;
  replacePrivateFile({
    authorizedRoot,
    destination: eventLogPath,
    body,
  });
  let resourceUsage: UsageMeasurement;
  try {
    resourceUsage = codexResourceUsage(events);
  } catch (error) {
    if (error instanceof Error) {
      (error as Error & { eventLogPath?: string }).eventLogPath = eventLogPath;
    }
    throw error;
  }
  return {
    eventCount: lines.length,
    commandEventCount: commandEvents.length,
    successfulCommandEventCount: commandEvents.filter((event) => event.successful).length,
    commandEvents,
    resourceUsage,
  };
}

export async function runCodexPhase(options: CodexPhaseOptions): Promise<Record<string, unknown>> {
  const {
    phase,
    workspaceRoot,
    outputPath,
    eventLogPath,
    prompt,
    capabilities,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
  } = options;
  const executable = executableFromPath("codex", env);
  if (!executable) throw new Error("Codex CLI is not available on PATH");
  const projectConfig = assertProjectCodexCapabilities(workspaceRoot, capabilities);
  const credentials = credentialDigestManifest(capabilities, env);
  const proc = await runBoundedProcess({
    command: executable,
    args: buildCodexExecArguments(options),
    cwd: workspaceRoot,
    env: minimalChildEnvironment(env, workspaceRoot, capabilities?.credential_env_vars ?? null),
    input: prompt,
    timeoutMs,
    signal: options.signal,
  });
  assertCodexProcessSucceeded(proc, timeoutMs);
  let artifactSource: string;
  try {
    artifactSource = readBoundedProviderFile(outputPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Codex completed without writing its structured final message");
    }
    throw error;
  }
  const events = persistCodexEvents(
    proc.stdout,
    Object.freeze({
      authorizedRoot: options.eventLogRoot ?? workspaceRoot,
      eventLogPath,
      phase,
      workspaceRoot,
    }),
  );
  return {
    artifact: parseArtifact(artifactSource, "codex"),
    eventLogPath,
    ...events,
    capabilitySurface: capabilitySurface(capabilities),
    credentialManifest: credentials,
    projectConfig,
  };
}

export function providerRuntimeIdentity(
  provider: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Readonly<Record<string, unknown>> {
  if (provider !== "codex")
    return Object.freeze({ executor: provider, executable: null, version: null });
  const executable = executableFromPath("codex", options.env ?? process.env);
  if (!executable) throw new Error("Codex CLI is not available on PATH");
  const proc = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: minimalChildEnvironment(options.env ?? process.env, process.cwd()),
  });
  if (proc.status !== 0) throw new Error(`Codex version probe failed: ${failureExcerpt(proc)}`);
  return Object.freeze({
    executor: "codex",
    executable,
    version: proc.stdout.trim(),
    binary_digest: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
}

interface McpServerSurface {
  name: string;
  url: string;
  enabled_tools?: string[];
}

function normalizeMcpServers(servers: Iterable<McpServerSurface>): Array<{
  name: string;
  url: string;
  enabled_tools: string[];
}> {
  return [...servers]
    .map((server) => ({
      name: server.name,
      url: server.url,
      enabled_tools: [...(server.enabled_tools ?? [])].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function probeCodexProfileSurface({
  executable,
  workspaceRoot,
  capabilities,
  sourceEnv,
}: {
  executable: string;
  workspaceRoot: string;
  capabilities: CapabilitySet;
  sourceEnv: NodeJS.ProcessEnv;
}): { effectiveSurface: unknown; error: string | null } {
  let doctorHome: string | null = null;
  try {
    doctorHome = mkdtempSync(resolve(tmpdir(), "rae-codex-doctor-home-"));
    assertProjectCodexCapabilities(workspaceRoot, capabilities);
    credentialDigestManifest(capabilities, sourceEnv);
    const probe = spawnSync(
      executable,
      [...codexCapabilityOverrides(capabilities), "mcp", "list", "--json"],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        cwd: doctorHome,
        env: {
          ...minimalChildEnvironment(sourceEnv, doctorHome, capabilities.credential_env_vars),
          CODEX_HOME: doctorHome,
        },
      },
    );
    if (probe.status !== 0) throw new Error(failureExcerpt(probe));
    const expected = capabilitySurface(capabilities) as {
      mcp_servers: McpServerSurface[];
      [key: string]: unknown;
    };
    if (
      JSON.stringify(
        normalizeMcpServers(JSON.parse(probe.stdout || "[]") as McpServerSurface[]),
      ) !== JSON.stringify(normalizeMcpServers(expected.mcp_servers as McpServerSurface[]))
    )
      throw new Error("effective Codex MCP surface contains missing or extra servers/tools");
    return { effectiveSurface: expected, error: null };
  } catch (error) {
    return {
      effectiveSurface: null,
      error: redact(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    if (doctorHome) rmSync(doctorHome, { recursive: true, force: true });
  }
}

interface CodexDoctorOptions {
  capabilities?: CapabilitySet | null;
  workspaceRoot?: string;
  [key: string]: unknown;
}

export function codexDoctorResult({
  executable,
  options,
  sourceEnv,
  provider = "codex",
}: {
  executable: string;
  options: CodexDoctorOptions;
  sourceEnv: NodeJS.ProcessEnv;
  provider?: string;
}): Record<string, unknown> {
  const childEnv = minimalChildEnvironment(sourceEnv, process.cwd());
  const probe = spawnSync(executable, ["exec", "--help"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: childEnv,
  });
  const capabilities = codexDoctorCapabilities(executable, childEnv, probe);
  const effectiveSurface = applyDoctorProfileSurface(executable, options, sourceEnv, capabilities);
  const success = probe.status === 0 && Object.values(capabilities).every(Boolean);
  return {
    success,
    provider,
    executable,
    sandbox_enforced: capabilities.workspace_sandbox,
    capabilities,
    effective_surface: effectiveSurface,
    detail: success
      ? "Codex is authenticated and supports workspace sandboxing, structured output, and ephemeral phase sessions"
      : "Codex is unauthenticated or missing one or more required autonomous execution capabilities",
  };
}

function codexDoctorCapabilities(
  executable: string,
  childEnv: NodeJS.ProcessEnv,
  probe: ReturnType<typeof spawnSync>,
): CodexCapabilities {
  const help = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const capabilities: CodexCapabilities = {
    workspace_sandbox: help.includes("--sandbox"),
    structured_output: help.includes("--output-schema"),
    ephemeral_sessions: help.includes("--ephemeral"),
    event_stream: help.includes("--json"),
    ignore_user_config: help.includes("--ignore-user-config"),
    strict_config: help.includes("--strict-config"),
    authenticated: false,
  };
  const authProbe = spawnSync(executable, ["login", "status"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: childEnv,
  });
  capabilities.authenticated = authProbe.status === 0;
  return capabilities;
}

function applyDoctorProfileSurface(
  executable: string,
  options: CodexDoctorOptions,
  sourceEnv: NodeJS.ProcessEnv,
  capabilities: CodexCapabilities,
): unknown {
  if (!options.capabilities) return null;
  const profileProbe = probeCodexProfileSurface({
    executable,
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
    capabilities: options.capabilities,
    sourceEnv,
  });
  if (profileProbe.error) {
    capabilities.profile_surface = false;
    capabilities.profile_surface_error = profileProbe.error;
  } else {
    capabilities.profile_surface = true;
  }
  return profileProbe.effectiveSurface;
}
