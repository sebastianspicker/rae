/** Runs Codex behind RAE's sealed environment, evidence, and doctor boundaries. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_AGENT_OUTPUT_BYTES,
  executableFromPath,
  failureExcerpt,
  minimalChildEnvironment,
  parseArtifact,
  replacePrivateFile,
  redact,
  timeoutError,
} from "./agent-provider-runtime.mjs";
import {
  assertProjectCodexCapabilities,
  capabilitySurface,
  codexCapabilityArgs,
  codexCapabilityOverrides,
} from "./codex-capabilities.mjs";
import { credentialDigestManifest } from "./execution-profile.mjs";

const CODEX_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];
const SENSITIVE_EVENT_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?[_-]?token|token|secret|password|authorization|cookie)$/i;

export function buildCodexExecArguments({
  workspaceRoot,
  schemaPath,
  outputPath,
  sandboxMode,
  model,
  reasoningEffort,
  capabilities,
}) {
  const args = [
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

export function assertCodexProcessSucceeded(proc, timeoutMs) {
  if (proc.error) {
    if (proc.error.code === "ETIMEDOUT") throw timeoutError("Codex phase", timeoutMs, proc);
    throw new Error(`Codex failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0)
    throw new Error(`Codex exited with status ${proc.status}: ${failureExcerpt(proc)}`);
}

function codexResourceUsage(events) {
  const usageEvents = events
    .filter((event) => event?.type === "turn.completed" && event.usage)
    .map((event) => event.usage);
  if (usageEvents.length === 0)
    return {
      measurement_status: "unavailable",
      missing_measurements: [...CODEX_USAGE_FIELDS],
      parser: "codex-turn-completed-usage-v1",
    };
  const measurement = { missing_measurements: [], parser: "codex-turn-completed-usage-v1" };
  for (const field of CODEX_USAGE_FIELDS) {
    const values = usageEvents.map((usage) => usage[field]);
    if (values.some((value) => value === undefined)) {
      measurement.missing_measurements.push(field);
      continue;
    }
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error(`Codex usage field ${field} must be a non-negative safe integer`);
    measurement[field] = values.reduce((total, value) => total + value, 0);
  }
  measurement.measurement_status =
    measurement.missing_measurements.length === 0 ? "complete" : "partial";
  return measurement;
}

function evidenceWorkingDirectory(value, workspaceRoot) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (!isAbsolute(value)) return value.trim();
  const relativePath = relative(workspaceRoot, value);
  return !relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    ? relativePath || "."
    : null;
}

function sensitiveEventKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_EVENT_KEY_PATTERN.test(normalized);
}

function redactEventValue(value, key = "") {
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

function redactEventPaths(value, workspaceRoot, key = "") {
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

function selectCommandWorkingDirectory(item, event) {
  if (Object.hasOwn(item, "cwd")) return item.cwd;
  if (Object.hasOwn(item, "working_directory")) return item.working_directory;
  return event.cwd;
}

function commandEventFrom(safeEvent, phase, workspaceRoot) {
  if (safeEvent?.type !== "item.completed") return null;
  const item = safeEvent.item;
  if (item?.type !== "command_execution") return null;
  if (typeof item.command !== "string") return null;
  const command = item.command.trim();
  if (!command) return null;
  if (!Number.isSafeInteger(item.exit_code)) return null;
  const workingDirectory = selectCommandWorkingDirectory(item, safeEvent);
  return {
    command,
    working_directory: evidenceWorkingDirectory(workingDirectory, workspaceRoot),
    phase: typeof phase === "string" ? phase : null,
    exit_code: item.exit_code,
    successful: item.exit_code === 0,
  };
}

function persistCodexEvents(raw, eventContext) {
  const { authorizedRoot, eventLogPath, phase, workspaceRoot } = eventContext;
  const lines = String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("Codex completed without emitting its JSON event stream");
  const commandEvents = [],
    events = [],
    persistedLines = [];
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`Codex event stream is invalid at line ${index + 1}: ${error.message}`);
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
  let resourceUsage;
  try {
    resourceUsage = codexResourceUsage(events);
  } catch (error) {
    error.eventLogPath = eventLogPath;
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

export function runCodexPhase(options) {
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
  const proc = spawnSync(executable, buildCodexExecArguments(options), {
    cwd: workspaceRoot,
    env: minimalChildEnvironment(env, workspaceRoot, capabilities?.credential_env_vars ?? null),
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    detached: process.platform !== "win32",
    killSignal: "SIGTERM",
    maxBuffer: MAX_AGENT_OUTPUT_BYTES,
  });
  assertCodexProcessSucceeded(proc, timeoutMs);
  if (!existsSync(outputPath))
    throw new Error("Codex completed without writing its structured final message");
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
    artifact: parseArtifact(readFileSync(outputPath, "utf8"), "codex"),
    eventLogPath,
    ...events,
    capabilitySurface: capabilitySurface(capabilities),
    credentialManifest: credentials,
    projectConfig,
  };
}

export function providerRuntimeIdentity(provider, options = {}) {
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

function normalizeMcpServers(servers) {
  return [...servers]
    .map((server) => ({
      name: server.name,
      url: server.url,
      enabled_tools: [...(server.enabled_tools ?? [])].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function probeCodexProfileSurface({ executable, workspaceRoot, capabilities, sourceEnv }) {
  let doctorHome = null;
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
    const expected = capabilitySurface(capabilities);
    if (
      JSON.stringify(normalizeMcpServers(JSON.parse(probe.stdout || "[]"))) !==
      JSON.stringify(normalizeMcpServers(expected.mcp_servers))
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

export function codexDoctorResult({ executable, options, sourceEnv, provider = "codex" }) {
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

function codexDoctorCapabilities(executable, childEnv, probe) {
  const help = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  const capabilities = {
    workspace_sandbox: help.includes("--sandbox"),
    structured_output: help.includes("--output-schema"),
    ephemeral_sessions: help.includes("--ephemeral"),
    event_stream: help.includes("--json"),
    ignore_user_config: help.includes("--ignore-user-config"),
    strict_config: help.includes("--strict-config"),
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

function applyDoctorProfileSurface(executable, options, sourceEnv, capabilities) {
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
