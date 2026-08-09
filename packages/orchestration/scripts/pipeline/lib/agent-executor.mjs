/**
 * Executes configured coding agents while redacting output and preserving structured phase artifacts.
 */
import {
  constants as fsConstants,
  accessSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  assertProjectCodexCapabilities,
  capabilitySurface,
  codexCapabilityArgs,
  codexCapabilityOverrides,
} from "./codex-capabilities.mjs";
import { credentialDigestManifest } from "./execution-profile.mjs";
import { openCodeDoctor, opencodeVersion, runOpenCodePhase } from "./opencode-adapter.mjs";

const MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_GROUP_TERMINATION_GRACE_MS = 100;
const ASSIGNMENT_SECRET_PATTERN =
  /((?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const FLAG_SECRET_PATTERN =
  /(--?(?:api[_-]?key|access[_-]?key|auth[_-]?token|token|secret|password)(?:=|\s+))[^\s,;]+/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const OPENAI_SECRET_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g;
const GITHUB_SECRET_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|signing[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth(?:orization)?[_-]?token|token|secret|password|authorization|cookie)$/i;
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];
const SEALED_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "CODEX_HOME",
];

function executableFromPath(command, env = process.env) {
  if (!command || typeof command !== "string") return null;
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((entry) => resolve(entry, command));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  return null;
}

function redact(text) {
  return String(text ?? "")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]")
    .replace(FLAG_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_SECRET_PATTERN, "[REDACTED]")
    .replace(GITHUB_SECRET_PATTERN, "[REDACTED]");
}

function sensitiveKey(key) {
  const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function redactEventValue(value, key = "") {
  if (sensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactEventValue(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactEventValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

function failureExcerpt(proc) {
  const combined = [proc.stderr, proc.stdout].filter(Boolean).join("\n").trim();
  if (!combined) return "no process output";
  return redact(combined.slice(-4000));
}

function waitBounded(milliseconds) {
  // Keep the synchronous public API while giving SIGTERM a bounded chance to
  // flush and exit before the group-wide SIGKILL fallback.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function signalProcessGroup(pid, signal) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function terminateTimedOutProcessGroup(proc) {
  // `spawnSync` only signals its immediate child on timeout. Providers run in
  // an isolated process group so ordinary descendants receive the same bounded
  // TERM -> KILL sequence. A descendant can still call setsid(2), which POSIX
  // deliberately permits; without a cgroup/job object or approved process
  // inspection, that escape cannot be proven absent. Callers must treat this
  // timeout as containment-uncertain rather than a clean cancellation.
  const hasProcessGroup = signalProcessGroup(proc.pid, "SIGTERM");
  if (hasProcessGroup) {
    waitBounded(PROCESS_GROUP_TERMINATION_GRACE_MS);
    signalProcessGroup(proc.pid, "SIGKILL");
  }
  return {
    processGroupTerminated: hasProcessGroup,
    containmentCertain: false,
  };
}

function timeoutError(provider, timeoutMs, proc) {
  const termination = terminateTimedOutProcessGroup(proc);
  const scope = termination.processGroupTerminated ? "process group" : "direct process";
  return new Error(
    `${provider} timed out after ${Math.ceil(timeoutMs / 1000)} seconds; ${scope} termination was attempted; containment_uncertain (a detached session cannot be proven terminated)`,
  );
}

function parseArtifact(raw, provider) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error(`${provider} returned an empty artifact`);
  }
  try {
    const artifact = JSON.parse(trimmed);
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("artifact must be a JSON object");
    }
    return artifact;
  } catch (error) {
    throw new Error(`${provider} returned invalid JSON: ${error.message}`);
  }
}

const CODEX_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
];

function codexResourceUsage(events) {
  const usageEvents = events
    .filter((event) => event?.type === "turn.completed" && event.usage)
    .map((event) => event.usage);
  if (usageEvents.length === 0) {
    return {
      measurement_status: "unavailable",
      missing_measurements: [...CODEX_USAGE_FIELDS],
      parser: "codex-turn-completed-usage-v1",
    };
  }

  const measurement = {
    missing_measurements: [],
    parser: "codex-turn-completed-usage-v1",
  };
  for (const field of CODEX_USAGE_FIELDS) {
    const values = usageEvents.map((usage) => usage[field]);
    if (values.some((value) => value === undefined)) {
      measurement.missing_measurements.push(field);
      continue;
    }
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Codex usage field ${field} must be a non-negative safe integer`);
    }
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
  if (!relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return relativePath || ".";
  }
  return null;
}

function redactEventPaths(value, workspaceRoot, key = "") {
  if (["cwd", "working_directory", "workingDirectory"].includes(key)) {
    return evidenceWorkingDirectory(value, workspaceRoot);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactEventPaths(entry, workspaceRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactEventPaths(entryValue, workspaceRoot, entryKey),
      ]),
    );
  }
  return value;
}

function persistCodexEvents(raw, eventLogPath, phase, workspaceRoot) {
  const lines = String(raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Codex completed without emitting its JSON event stream");
  }
  const commandEvents = [];
  const events = [];
  const persistedLines = [];
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
    if (
      safeEvent?.type === "item.completed" &&
      safeEvent.item?.type === "command_execution" &&
      typeof safeEvent.item.command === "string" &&
      safeEvent.item.command.trim() &&
      Number.isSafeInteger(safeEvent.item.exit_code)
    ) {
      commandEvents.push({
        command: safeEvent.item.command.trim(),
        working_directory: evidenceWorkingDirectory(
          safeEvent.item.cwd ?? safeEvent.item.working_directory ?? safeEvent.cwd,
          workspaceRoot,
        ),
        phase: typeof phase === "string" ? phase : null,
        exit_code: safeEvent.item.exit_code,
        successful: safeEvent.item.exit_code === 0,
      });
    }
  }
  writeFileSync(eventLogPath, `${persistedLines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
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

/** Builds the fixed Ralph-compatible child environment used at autonomous trust boundaries. */
export function minimalChildEnvironment(env, cwd, credentialEnvVars = null) {
  const sanitized = {};
  const allowlist = credentialEnvVars ? SEALED_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
  for (const key of allowlist) {
    if (env?.[key] !== undefined) sanitized[key] = env[key];
  }
  for (const key of credentialEnvVars ?? []) {
    if (env?.[key] !== undefined) sanitized[key] = env[key];
  }
  sanitized.PWD = cwd;
  sanitized.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_cli_rs";
  return sanitized;
}

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

function runCodex({
  phase,
  workspaceRoot,
  schemaPath,
  outputPath,
  eventLogPath,
  prompt,
  sandboxMode,
  model,
  reasoningEffort,
  capabilities,
  timeoutMs,
  env,
}) {
  const executable = executableFromPath("codex", env);
  if (!executable) {
    throw new Error("Codex CLI is not available on PATH");
  }

  const projectConfig = assertProjectCodexCapabilities(workspaceRoot, capabilities);
  const credentials = credentialDigestManifest(capabilities, env);

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
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  args.push("-");

  const proc = spawnSync(executable, args, {
    cwd: workspaceRoot,
    env: minimalChildEnvironment(env, workspaceRoot, capabilities?.credential_env_vars ?? null),
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    detached: process.platform !== "win32",
    killSignal: "SIGTERM",
    maxBuffer: MAX_AGENT_OUTPUT_BYTES,
  });

  if (proc.error) {
    if (proc.error.code === "ETIMEDOUT") {
      throw timeoutError("Codex phase", timeoutMs, proc);
    }
    throw new Error(`Codex failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`Codex exited with status ${proc.status}: ${failureExcerpt(proc)}`);
  }
  if (!existsSync(outputPath)) {
    throw new Error("Codex completed without writing its structured final message");
  }
  const events = persistCodexEvents(proc.stdout, eventLogPath, phase, workspaceRoot);
  return {
    artifact: parseArtifact(readFileSync(outputPath, "utf8"), "codex"),
    eventLogPath,
    ...events,
    capabilitySurface: capabilitySurface(capabilities),
    credentialManifest: credentials,
    projectConfig,
  };
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
  if (!command) {
    throw new Error("--provider command requires --agent-command <executable>");
  }
  const executable = executableFromPath(command, env);
  if (!executable) {
    throw new Error(`agent command is not executable: ${command}`);
  }
  const request = {
    protocol_version: "rae-agent-v1",
    phase,
    run_id: runId,
    workspace_root: workspaceRoot,
    schema_path: schemaPath,
    sandbox_mode: sandboxMode,
    prompt,
  };
  const sanitizedEnv = minimalChildEnvironment(env, workspaceRoot);
  const proc = spawnSync(executable, commandArgs ?? [], {
    cwd: workspaceRoot,
    env: {
      ...sanitizedEnv,
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
  });

  if (proc.error) {
    if (proc.error.code === "ETIMEDOUT") {
      throw timeoutError("agent command", timeoutMs, proc);
    }
    throw new Error(`agent command failed to start: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`agent command exited with status ${proc.status}: ${failureExcerpt(proc)}`);
  }
  return { artifact: parseArtifact(proc.stdout, "agent command") };
}

/**
 * Executes the selected provider without leaking raw credentials or accepting malformed agent artifacts.
 */
export function runAgentPhase(options) {
  const provider = resolveProvider(options);
  if (provider === "command" && options.allowUnsafeCommand !== true) {
    throw new Error(
      "the unsandboxed command provider is disabled; test integrations must pass --allow-unsafe-command-provider explicitly",
    );
  }
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const execution = runProviderAdapter(provider, { ...options, timeoutMs, env });

  return {
    provider,
    ...execution,
    durationMs: Date.now() - startedAt,
  };
}

function runProviderAdapter(provider, options) {
  if (provider === "codex") return runCodex(options);
  if (provider === "opencode") return runOpenCodePhase(options);
  return runCommandProvider(options);
}

/** Returns the exact provider runtime identity used in immutable run provenance. */
export function providerRuntimeIdentity(provider, options = {}) {
  if (provider === "opencode") return opencodeVersion(options);
  if (provider === "codex") {
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
  return Object.freeze({ executor: provider, executable: null, version: null });
}

/**
 * Checks agent availability and runtime capabilities before an autonomous workflow starts work.
 */
export function agentDoctor(options = {}) {
  const sourceEnv = options.env ?? process.env;
  const childEnv = minimalChildEnvironment(sourceEnv, process.cwd());
  if (options.provider === "opencode") {
    return openCodeDoctor({ ...options, env: sourceEnv });
  }
  if (["auto", "codex"].includes(options.provider ?? "auto")) {
    const executable = executableFromPath("codex", childEnv);
    if (!executable) {
      return {
        success: false,
        provider: "codex",
        executable: null,
        sandbox_enforced: false,
        detail: "Codex CLI is not available on PATH",
      };
    }
  }
  const provider = resolveProvider({ ...options, env: childEnv });
  if (provider === "command") {
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

  const executable = executableFromPath("codex", childEnv);
  const probe = spawnSync(executable, ["exec", "--help"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: childEnv,
  });
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
  let effectiveSurface = null;
  if (options.capabilities) {
    const doctorHome = mkdtempSync(resolve(tmpdir(), "rae-codex-doctor-home-"));
    try {
      assertProjectCodexCapabilities(options.workspaceRoot ?? process.cwd(), options.capabilities);
      credentialDigestManifest(options.capabilities, sourceEnv);
      const surfaceProbe = spawnSync(
        executable,
        [...codexCapabilityOverrides(options.capabilities), "mcp", "list", "--json"],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          cwd: doctorHome,
          env: {
            ...minimalChildEnvironment(
              sourceEnv,
              doctorHome,
              options.capabilities.credential_env_vars,
            ),
            CODEX_HOME: doctorHome,
          },
        },
      );
      if (surfaceProbe.status !== 0) throw new Error(failureExcerpt(surfaceProbe));
      const actual = JSON.parse(surfaceProbe.stdout || "[]");
      const expected = capabilitySurface(options.capabilities);
      const normalizedActual = actual.map((server) => ({
        name: server.name,
        url: server.url,
        enabled_tools: [...(server.enabled_tools ?? [])].sort(),
      }));
      const normalizedExpected = expected.mcp_servers.map((server) => ({
        name: server.name,
        url: server.url,
        enabled_tools: server.enabled_tools,
      }));
      if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
        throw new Error("effective Codex MCP surface contains missing or extra servers/tools");
      }
      effectiveSurface = expected;
    } catch (error) {
      capabilities.profile_surface = false;
      capabilities.profile_surface_error = error.message;
    } finally {
      rmSync(doctorHome, { recursive: true, force: true });
    }
  }
  if (options.capabilities && capabilities.profile_surface !== false) {
    capabilities.profile_surface = true;
  }
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
