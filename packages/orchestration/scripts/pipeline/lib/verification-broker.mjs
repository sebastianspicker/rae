#!/usr/bin/env node
/** Executes only RAE-approved verification vectors behind a no-network boundary. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

function below(root, candidate) {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

function resolveExecutable(command, workspaceRoot, env) {
  const candidates =
    command.includes("/") || command.includes("\\")
      ? [resolve(workspaceRoot, command)]
      : String(env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the launcher's fixed PATH.
    }
  }
  throw new Error(`verification executable is unavailable: ${command}`);
}

function validateVerificationId(id) {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid verification id: ${id}`);
}

function validateVerificationArguments(id, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error(`verification ${id} must be an argv vector with 1 to 32 entries`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !entry || entry.length > 4096 || entry.includes("\0")) {
      throw new Error(`verification ${id} contains an invalid argument`);
    }
  }
}

function assertExecutablePolicy(id, command, executable, workspaceRoot) {
  if (command.includes("/") || command.includes("\\")) {
    const systemExecutable = [
      "/bin/",
      "/usr/bin/",
      "/Library/Developer/CommandLineTools/usr/bin/",
    ].some((prefix) => executable.startsWith(prefix));
    const stat = lstatSync(executable);
    if (!below(workspaceRoot, executable) && !(systemExecutable && stat.uid === 0)) {
      throw new Error(
        `verification ${id} executable must be workspace-owned or a root-owned system binary`,
      );
    }
  }
}

function validateVector(id, value, workspaceRoot, env) {
  validateVerificationId(id);
  validateVerificationArguments(id, value);
  const executable = resolveExecutable(value[0], workspaceRoot, env);
  assertExecutablePolicy(id, value[0], executable, workspaceRoot);
  return Object.freeze([executable, ...value.slice(1)]);
}

export function validateVerificationCatalog(value, workspaceRoot, env = process.env) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("verification catalog must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 32) {
    throw new Error("verification catalog must define 1 to 32 commands");
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([id, vector]) => [id, validateVector(id, vector, workspaceRoot, env)]),
    ),
  );
}

export function loadVerificationCatalog(pathValue, workspaceRoot, env = process.env) {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(pathValue) !== resolve(pathValue)) {
    throw new Error("verification catalog must be a canonical regular non-symlink file");
  }
  const bytes = readFileSync(pathValue);
  if (bytes.length > MAX_CATALOG_BYTES) throw new Error("verification catalog is too large");
  const after = lstatSync(pathValue);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) {
    throw new Error("verification catalog changed while it was being read");
  }
  return validateVerificationCatalog(JSON.parse(bytes.toString("utf8")), workspaceRoot, env);
}

function escapeSandboxLiteral(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function verificationSandboxProfile(workspaceRoot, executable) {
  const root = escapeSandboxLiteral(realpathSync(workspaceRoot));
  const binary = escapeSandboxLiteral(realpathSync(executable));
  return [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow process-info*)",
    "(allow signal (target self))",
    "(allow ipc-posix*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    '(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/libexec/git-core") (subpath "/usr/share") (subpath "/Library/Apple") (subpath "/Library/Developer/CommandLineTools") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/select") (literal "/") (literal "/tmp") (literal "/var") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero"))',
    `(allow file-read* (subpath "${root}") (literal "${binary}"))`,
    `(allow file-write* (subpath "${root}"))`,
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-write* (subpath "${root}/.git"))`,
    `(deny file-write* (subpath "${root}/.pipeline"))`,
    "(deny network*)",
  ].join("\n");
}

function redactedOutput(value) {
  return String(value ?? "")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, MAX_OUTPUT_BYTES);
}

export function runVerificationCommand({
  id,
  catalog,
  workspaceRoot,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  platform = process.platform,
  evidencePath = null,
}) {
  const vector = catalog[id];
  if (!vector) throw new Error(`verification id is not approved: ${id}`);
  if (platform !== "darwin") {
    throw new Error("verification broker requires the documented macOS sandbox backend");
  }
  const args = [
    "-p",
    verificationSandboxProfile(workspaceRoot, vector[0]),
    vector[0],
    ...vector.slice(1),
  ];
  const proc = spawnSync("/usr/bin/sandbox-exec", args, {
    cwd: workspaceRoot,
    env: Object.fromEntries(
      ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "NO_COLOR"]
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, env[key]]),
    ),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
  });
  if (proc.error?.code === "ETIMEDOUT") throw new Error(`verification ${id} timed out`);
  if (proc.error) throw new Error(`verification ${id} failed to start: ${proc.error.message}`);
  const evidence = Object.freeze({
    verification_id: id,
    argv_digest: createHash("sha256").update(JSON.stringify(vector)).digest("hex"),
    exit_code: proc.status,
    termination_signal: proc.signal ?? null,
    successful: proc.status === 0,
    stdout: redactedOutput(proc.stdout),
    stderr: redactedOutput(proc.stderr),
  });
  if (evidencePath) {
    appendFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return evidence;
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, error) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: error.message } };
}

function brokerResponse(message, state) {
  if (message.method === "initialize") {
    return rpcResult(message.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "rae-verification-broker", version: "1.0.0" },
    });
  }
  if (message.method === "tools/list") {
    return rpcResult(message.id, {
      tools: [
        {
          name: "verify",
          description: "Run one repository-approved verification by opaque id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["verification_id"],
            properties: { verification_id: { type: "string", pattern: ID_PATTERN.source } },
          },
        },
      ],
    });
  }
  if (message.method === "tools/call" && message.params?.name === "verify") {
    const evidence = runVerificationCommand({
      id: message.params.arguments?.verification_id,
      catalog: state.catalog,
      workspaceRoot: state.workspaceRoot,
      evidencePath: state.evidencePath,
    });
    return rpcResult(message.id, {
      content: [{ type: "text", text: JSON.stringify(evidence) }],
      isError: !evidence.successful,
    });
  }
  if (message.id === undefined) return null;
  return rpcError(message.id, new Error("unsupported verification broker method"));
}

export function serveVerificationBroker({ workspaceRoot, catalogPath, evidencePath = null }) {
  const canonicalRoot = realpathSync(workspaceRoot);
  const state = {
    workspaceRoot: canonicalRoot,
    catalog: loadVerificationCatalog(catalogPath, canonicalRoot),
    evidencePath,
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
      const response = brokerResponse(message, state);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(rpcError(message?.id ?? null, error))}\n`);
    }
  });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const workspaceIndex = process.argv.indexOf("--workspace");
  const catalogIndex = process.argv.indexOf("--catalog");
  const evidenceIndex = process.argv.indexOf("--evidence");
  if (workspaceIndex < 0 || catalogIndex < 0)
    throw new Error("broker requires --workspace and --catalog");
  serveVerificationBroker({
    workspaceRoot: process.argv[workspaceIndex + 1],
    catalogPath: process.argv[catalogIndex + 1],
    evidencePath: evidenceIndex < 0 ? null : process.argv[evidenceIndex + 1],
  });
}
