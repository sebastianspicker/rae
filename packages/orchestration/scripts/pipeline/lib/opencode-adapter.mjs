/** Runs OpenCode behind RAE's macOS containment and normalized-event boundary. */
// DECISION: Workflow data stays provider-neutral. The local control plane alone
// resolves provider routes and grants contained write authority, while saving
// and exact-digest human activation remain separate operations.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_COUNT = 20_000;
const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const BROKER_PATH = resolve(import.meta.dirname, "verification-broker.mjs");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SAFE_PERMISSION_KEYS = [
  "*",
  "bash",
  "doom_loop",
  "edit",
  "external_directory",
  "glob",
  "grep",
  "lsp",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "rae-verification_verify",
];

function executableFromPath(command, env) {
  const candidates = isAbsolute(command)
    ? [command]
    : String(env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

function assertExecutable(pathValue, { requireRoot = false } = {}) {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${pathValue} is not a regular executable`);
  if (requireRoot && stat.uid !== 0) throw new Error(`${pathValue} must be root-owned`);
  accessSync(pathValue, fsConstants.X_OK);
  return realpathSync(pathValue);
}

function permissionSurface(writeAccess) {
  return Object.freeze({
    "*": "deny",
    bash: "deny",
    doom_loop: "deny",
    edit: writeAccess ? "allow" : "deny",
    external_directory: "deny",
    glob: "allow",
    grep: "allow",
    lsp: "deny",
    question: "deny",
    read: "allow",
    skill: "deny",
    task: "deny",
    todowrite: "deny",
    webfetch: "deny",
    websearch: "deny",
    "rae-verification_verify": "allow",
  });
}

function verificationCatalog(workspaceRoot) {
  void workspaceRoot;
  const commandLineToolsGit = "/Library/Developer/CommandLineTools/usr/bin/git";
  return {
    "git-diff-check": [
      existsSync(commandLineToolsGit) ? commandLineToolsGit : "/usr/bin/git",
      "diff",
      "--check",
    ],
  };
}

function inlineConfig({ writeAccess, workspaceRoot, catalogPath, evidencePath }) {
  const permission = permissionSurface(writeAccess);
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    plugin: [],
    command: {},
    instructions: [],
    subagent_depth: 0,
    permission,
    agent: {
      rae: {
        description: "RAE contained workflow node",
        mode: "primary",
        permission,
      },
    },
    mcp: {
      "rae-verification": {
        type: "local",
        command: [
          process.execPath,
          BROKER_PATH,
          "--workspace",
          workspaceRoot,
          "--catalog",
          catalogPath,
          "--evidence",
          evidencePath,
        ],
        enabled: true,
      },
    },
  };
}

function safeChildEnvironment(source, runtime, config, permission) {
  const output = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "NO_COLOR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return {
    ...output,
    HOME: runtime.home,
    XDG_CONFIG_HOME: runtime.config,
    XDG_CACHE_HOME: runtime.cache,
    XDG_DATA_HOME: runtime.data,
    XDG_STATE_HOME: runtime.state,
    TMPDIR: runtime.tmp,
    OPENCODE_CONFIG_DIR: runtime.opencodeConfig,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
}

function defaultAuthPath(sourceEnv) {
  const base = sourceEnv.HOME ? resolve(sourceEnv.HOME) : homedir();
  return resolve(base, ".local/share/opencode/auth.json");
}

function prepareRuntime({ env, workspaceRoot, sandboxMode, authPath }) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-opencode-")));
  chmodSync(root, 0o700);
  const runtime = Object.fromEntries(
    ["home", "config", "cache", "data", "state", "tmp", "opencodeConfig"].map((name) => {
      const pathValue = resolve(root, name);
      mkdirSync(pathValue, { recursive: true, mode: 0o700 });
      return [name, pathValue];
    }),
  );
  const authSource = authPath ?? defaultAuthPath(env);
  if (existsSync(authSource)) {
    const stat = lstatSync(authSource);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("OpenCode auth store must be a regular non-symlink file");
    const authDirectory = resolve(runtime.data, "opencode");
    mkdirSync(authDirectory, { mode: 0o700 });
    symlinkSync(realpathSync(authSource), resolve(authDirectory, "auth.json"));
    runtime.authSource = realpathSync(authSource);
  }
  runtime.root = root;
  runtime.catalogPath = resolve(root, "verification-catalog.json");
  runtime.evidencePath = resolve(root, "verification-evidence.jsonl");
  writeFileSync(runtime.catalogPath, `${JSON.stringify(verificationCatalog(workspaceRoot))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const config = inlineConfig({
    writeAccess: sandboxMode === "workspace-write",
    workspaceRoot,
    catalogPath: runtime.catalogPath,
    evidencePath: runtime.evidencePath,
  });
  runtime.configValue = config;
  runtime.permission = config.permission;
  runtime.env = safeChildEnvironment(env, runtime, config, config.permission);
  return runtime;
}

function escapeSeatbelt(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function pathNavigationLiterals(paths) {
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
  const workspace = escapeSeatbelt(realpathSync(workspaceRoot));
  const runtime = escapeSeatbelt(realpathSync(runtimeRoot));
  const binary = escapeSeatbelt(realpathSync(executable));
  const binaryDirectory = escapeSeatbelt(dirname(realpathSync(executable)));
  const node = escapeSeatbelt(realpathSync(process.execPath));
  const broker = escapeSeatbelt(realpathSync(BROKER_PATH));
  const navigation = pathNavigationLiterals([
    workspaceRoot,
    runtimeRoot,
    executable,
    process.execPath,
    BROKER_PATH,
  ]);
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
    `(allow file-read* ${navigation})`,
    '(allow file-read* (subpath "/$bunfs") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/libexec/git-core") (subpath "/usr/share") (subpath "/Library/Apple") (subpath "/Library/Developer/CommandLineTools") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/select") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero"))',
    `(allow file-read* (subpath "${workspace}") (subpath "${runtime}") (subpath "${binaryDirectory}") (literal "${binary}") (literal "${node}") (literal "${broker}"))`,
    `(allow file-write* (subpath "${runtime}"))`,
    '(allow file-write* (literal "/dev/null"))',
    "(allow network-outbound)",
    "(deny network-inbound)",
  ];
  if (sandboxMode === "workspace-write") rules.push(`(allow file-write* (subpath "${workspace}"))`);
  if (authSource) rules.push(`(allow file-read* (literal "${escapeSeatbelt(authSource)}"))`);
  // Default deny already excludes the source checkout and all sibling paths.
  // A broad source-root deny would also cover RAE worktrees stored below the
  // Git common directory and make the explicitly allowed worktree unusable.
  void sourceRoot;
  for (const protectedPath of [
    resolve(workspaceRoot, ".git"),
    resolve(workspaceRoot, ".pipeline"),
    runDir,
  ]) {
    if (protectedPath) {
      const escaped = escapeSeatbelt(protectedPath);
      rules.push(`(deny file-read* file-write* (literal "${escaped}") (subpath "${escaped}"))`);
    }
  }
  for (const evaluatorPath of ["evals/fixtures", "evals/judges", "evals/policies"]) {
    rules.push(
      `(deny file-write* (subpath "${escapeSeatbelt(resolve(workspaceRoot, evaluatorPath))}"))`,
    );
  }
  return rules.join("\n");
}

function sandboxInvocation(executable, args, options, runtime) {
  const sandboxExecutable = options.sandboxExecutable ?? SANDBOX_EXEC;
  if (!options.allowTestSandbox) assertExecutable(sandboxExecutable, { requireRoot: true });
  const profile = opencodeSandboxProfile({
    workspaceRoot: options.workspaceRoot,
    sourceRoot: options.sourceRoot,
    runDir: options.runDir,
    runtimeRoot: runtime.root,
    authSource: runtime.authSource,
    executable,
    sandboxMode: options.sandboxMode,
  });
  return { command: sandboxExecutable, args: ["-p", profile, executable, ...args], profile };
}

function spawnContained(executable, args, options, runtime, input = undefined) {
  const invocation = sandboxInvocation(executable, args, options, runtime);
  const proc = spawnSync(invocation.command, invocation.args, {
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
  return { proc, invocation };
}

function processFailure(label, proc) {
  if (proc.error?.code === "ETIMEDOUT") {
    if (Number.isInteger(proc.pid) && proc.pid > 0 && process.platform !== "win32") {
      try {
        process.kill(-proc.pid, "SIGTERM");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    return new Error(`${label} timed out; contained process-group termination was attempted`);
  }
  if (proc.error) return new Error(`${label} failed to start: ${proc.error.message}`);
  if (proc.status !== 0) {
    const detail = redactProcessOutput(`${proc.stderr ?? ""}\n${proc.stdout ?? ""}`)
      .trim()
      .slice(-4000);
    const outcome = proc.signal ? `signal ${proc.signal}` : `status ${proc.status}`;
    return new Error(`${label} exited with ${outcome}: ${detail || "no process output"}`);
  }
  return null;
}

function redactProcessOutput(value) {
  return String(value ?? "")
    .replace(
      /((?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

function exactPermission(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...SAFE_PERMISSION_KEYS].sort()) &&
    SAFE_PERMISSION_KEYS.every((key) => value[key] === expected[key])
  );
}

function assertEffectiveConfiguration(config, expected) {
  for (const [key, value] of Object.entries({
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    subagent_depth: 0,
  })) {
    if (config[key] !== value) throw new Error(`effective OpenCode config changed ${key}`);
  }
  if (!Array.isArray(config.plugin) || config.plugin.length !== 0) {
    throw new Error("effective OpenCode plugin surface is not empty");
  }
  if (!exactPermission(config.permission, expected.permission)) {
    throw new Error("effective OpenCode global permission surface is not exact");
  }
  if (!exactPermission(config.agent?.rae?.permission, expected.permission)) {
    throw new Error("effective OpenCode agent permission surface is not exact");
  }
  const mcpNames = Object.keys(config.mcp ?? {});
  if (mcpNames.length !== 1 || mcpNames[0] !== "rae-verification") {
    throw new Error("effective OpenCode MCP surface contains an unapproved server");
  }
}

function assertNoProjectExtensions(workspaceRoot) {
  for (const directory of [
    "agents",
    "agent",
    "commands",
    "command",
    "plugins",
    "plugin",
    "skills",
    "skill",
    "tools",
    "tool",
  ]) {
    const candidate = resolve(workspaceRoot, ".opencode", directory);
    if (existsSync(candidate) && readdirSync(candidate).length > 0) {
      throw new Error(`OpenCode project extension surface is not allowed: .opencode/${directory}`);
    }
  }
}

function probeEffectiveConfig(executable, options, runtime) {
  assertNoProjectExtensions(options.workspaceRoot);
  const { proc } = spawnContained(executable, ["--pure", "debug", "config"], options, runtime);
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

export function opencodeVersion(options = {}) {
  const env = options.env ?? process.env;
  const executable = executableFromPath("opencode", env);
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
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`OpenCode returned an invalid version: ${version || "empty"}`);
  }
  return Object.freeze({
    executor: "opencode",
    executable,
    version,
    binary_digest: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
}

function normalizedEvent(event) {
  const part = event?.part && typeof event.part === "object" ? event.part : {};
  return {
    type: typeof event?.type === "string" ? event.type : "unknown",
    ...(Number.isSafeInteger(event?.timestamp) ? { timestamp: event.timestamp } : {}),
    part: {
      type: typeof part.type === "string" ? part.type : null,
      ...(typeof part.tool === "string" ? { tool: part.tool } : {}),
      ...(typeof part.state?.status === "string" ? { status: part.state.status } : {}),
      ...(typeof part.text === "string" ? { text_bytes: Buffer.byteLength(part.text) } : {}),
    },
  };
}

function boundedEventLines(raw) {
  const lines = String(raw ?? "")
    .split("\n")
    .filter((line) => line.trim());
  if (lines.length < 1 || lines.length > MAX_EVENT_COUNT) {
    throw new Error("OpenCode emitted an invalid event count");
  }
  return lines;
}

function parseEventLine(line, index) {
  if (Buffer.byteLength(line) > MAX_EVENT_LINE_BYTES) {
    throw new Error(`OpenCode event ${index + 1} exceeds the line limit`);
  }
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`OpenCode event stream is invalid at line ${index + 1}: ${error.message}`);
  }
}

function validateFinalArtifact(texts) {
  if (texts.length !== 1) {
    throw new Error(`OpenCode must emit exactly one final text artifact; received ${texts.length}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(texts[0].trim());
  } catch (error) {
    throw new Error(`OpenCode returned invalid final JSON: ${error.message}`);
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error("OpenCode final artifact must be a JSON object");
  }
  return artifact;
}

function parseEvents(raw, eventLogPath) {
  const lines = boundedEventLines(raw);
  const events = [];
  const texts = [];
  for (const [index, line] of lines.entries()) {
    const event = parseEventLine(line, index);
    events.push(normalizedEvent(event));
    if (event?.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text);
    if (event?.type === "error") throw new Error("OpenCode emitted a terminal error event");
  }
  writeFileSync(eventLogPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { artifact: validateFinalArtifact(texts), eventCount: events.length };
}

function brokerEvidence(runtime, phase) {
  if (!existsSync(runtime.evidencePath)) return [];
  return readFileSync(runtime.evidencePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((entry) => ({
      verification_id: entry.verification_id,
      command: `verification:${entry.verification_id}`,
      working_directory: ".",
      phase,
      exit_code: entry.exit_code,
      successful: entry.successful,
      argv_digest: entry.argv_digest,
    }));
}

export function runOpenCodePhase(options) {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("OpenCode execution requires the documented macOS sandbox backend");
  }
  if (!options.model) throw new Error("OpenCode execution requires an explicit provider/model");
  if (
    options.sandboxMode === "workspace-write" &&
    (options.inPlace ||
      (options.sourceRoot &&
        realpathSync(options.sourceRoot) === realpathSync(options.workspaceRoot)))
  ) {
    throw new Error("OpenCode write routes require an isolated RAE worktree and reject --in-place");
  }
  const env = options.env ?? process.env;
  const identity = opencodeVersion({ env });
  const runtime = prepareRuntime({
    env,
    workspaceRoot: options.workspaceRoot,
    sandboxMode: options.sandboxMode,
    authPath: options.authPath,
  });
  try {
    const effectiveConfigDigest = probeEffectiveConfig(identity.executable, options, runtime);
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
    const { proc } = spawnContained(identity.executable, args, options, runtime, options.prompt);
    const failure = processFailure("OpenCode phase", proc);
    if (failure) throw failure;
    const parsed = parseEvents(proc.stdout, options.eventLogPath);
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
      effectiveConfigDigest,
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
  } finally {
    rmSync(runtime.root, { recursive: true, force: true });
  }
}

export function openCodeDoctor(options = {}) {
  const result = {
    success: false,
    provider: "opencode",
    sandbox_enforced: false,
    platform: options.platform ?? process.platform,
    model: options.model ?? null,
  };
  try {
    if (!options.model) throw new Error("OpenCode doctor requires an explicit provider/model");
    if (result.platform !== "darwin") {
      throw new Error("OpenCode write routes are supported only by the documented macOS backend");
    }
    const env = options.env ?? process.env;
    const identity = opencodeVersion({ env });
    if (!options.allowTestSandbox)
      assertExecutable(options.sandboxExecutable ?? SANDBOX_EXEC, { requireRoot: true });
    const workspaceRoot = realpathSync(options.workspaceRoot ?? process.cwd());
    const runtime = prepareRuntime({
      env,
      workspaceRoot,
      sandboxMode: options.sandboxMode ?? "read-only",
      authPath: options.authPath,
    });
    try {
      const effectiveConfigDigest = probeEffectiveConfig(
        identity.executable,
        { ...options, workspaceRoot, timeoutMs: options.timeoutMs ?? 10_000 },
        runtime,
      );
      return {
        ...result,
        success: true,
        executable: identity.executable,
        version: identity.version,
        sandbox_enforced: true,
        effective_config_digest: effectiveConfigDigest,
        readiness: runtime.authSource
          ? "authenticated-store-present"
          : "credential-store-unavailable",
        detail:
          "OpenCode has an exact denied-by-default tool surface under the macOS sandbox backend",
      };
    } finally {
      rmSync(runtime.root, { recursive: true, force: true });
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
