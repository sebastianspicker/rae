/** Shared safe process, redaction, and child-environment primitives for agent providers. */
import {
  constants as fsConstants,
  accessSync,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_AGENT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const PROCESS_GROUP_TERMINATION_GRACE_MS = 100;
const ASSIGNMENT_SECRET_PATTERN =
  /((?:token|secret|password|api[_-]?key|access[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const FLAG_SECRET_PATTERN =
  /(--?(?:api[_-]?key|access[_-]?key|auth[_-]?token|token|secret|password)(?:=|\s+))[^\s,;]+/gi;
const BEARER_SECRET_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi;
const OPENAI_SECRET_PATTERN = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g;
const GITHUB_SECRET_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g;
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

export function executableFromPath(command, env = process.env) {
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

export function redact(text) {
  return String(text ?? "")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1[REDACTED]")
    .replace(FLAG_SECRET_PATTERN, "$1[REDACTED]")
    .replace(BEARER_SECRET_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_SECRET_PATTERN, "[REDACTED]")
    .replace(GITHUB_SECRET_PATTERN, "[REDACTED]");
}

export function failureExcerpt(proc) {
  const combined = [proc.stderr, proc.stdout].filter(Boolean).join("\n").trim();
  return combined ? redact(combined.slice(-4000)) : "no process output";
}

function waitBounded(milliseconds) {
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

export function timeoutError(provider, timeoutMs, proc) {
  const processGroupTerminated = signalProcessGroup(proc.pid, "SIGTERM");
  if (processGroupTerminated) {
    waitBounded(PROCESS_GROUP_TERMINATION_GRACE_MS);
    signalProcessGroup(proc.pid, "SIGKILL");
  }
  const scope = processGroupTerminated ? "process group" : "direct process";
  return new Error(
    `${provider} timed out after ${Math.ceil(timeoutMs / 1000)} seconds; ${scope} termination was attempted; containment_uncertain (a detached session cannot be proven terminated)`,
  );
}

export function parseArtifact(raw, provider) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error(`${provider} returned an empty artifact`);
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

/** Builds the fixed Ralph-compatible child environment used at autonomous trust boundaries. */
export function minimalChildEnvironment(env, cwd, credentialEnvVars = null) {
  const sanitized = {};
  const allowlist = credentialEnvVars ? SEALED_CHILD_ENV_ALLOWLIST : CHILD_ENV_ALLOWLIST;
  for (const key of allowlist) if (env?.[key] !== undefined) sanitized[key] = env[key];
  for (const key of credentialEnvVars ?? [])
    if (env?.[key] !== undefined) sanitized[key] = env[key];
  sanitized.PWD = cwd;
  sanitized.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_cli_rs";
  return sanitized;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isOriginalDirectory(pathValue, identity) {
  const metadata = lstatSync(pathValue);
  return metadata.isDirectory() && !metadata.isSymbolicLink() && sameIdentity(metadata, identity);
}

function replacementParent(workspaceRoot, destination) {
  const requestedRoot = resolve(workspaceRoot);
  const requestedDestination = resolve(destination);
  const pathFromRoot = relative(requestedRoot, requestedDestination);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("event log path must be a file below the authorized workspace root");
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const components = pathFromRoot.split(/[/\\]+/).filter(Boolean);
  const fileName = components.pop();
  let parent = canonicalRoot;
  for (const component of components) {
    parent = join(parent, component);
    const metadata = lstatSync(parent);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("event log parent must contain only non-symlink directories");
    }
  }
  return { parent, fileName, parentIdentity: statSync(parent) };
}

function assertReplaceableDestination(destination) {
  try {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("event log destination must be absent or a regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function reservePrivateSiblingAttempt(parent, fileName) {
  const path = join(parent, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    return { path, descriptor, identity: fstatSync(descriptor) };
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

function createPrivateSibling(parent, fileName) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const reserved = reservePrivateSiblingAttempt(parent, fileName);
    if (reserved) return reserved;
  }
  throw new Error("could not reserve a private event-log replacement file");
}

function writeReplacementBody(descriptor, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("could not write private event-log replacement");
    offset += written;
  }
}

function cleanupPrivateSibling(temp, open) {
  if (open) closeSync(temp.descriptor);
  try {
    if (sameIdentity(lstatSync(temp.path), temp.identity)) rmSync(temp.path, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function replacementIsUnchanged(parent, parentIdentity, temp, bodySize) {
  const metadata = fstatSync(temp.descriptor);
  return (
    isOriginalDirectory(parent, parentIdentity) &&
    sameIdentity(metadata, temp.identity) &&
    metadata.size === bodySize &&
    sameIdentity(lstatSync(temp.path), temp.identity)
  );
}

/** Atomically replaces an event log only after its caller has prepared the complete body. */
export function replacePrivateFile({ authorizedRoot, destination, body }) {
  if (typeof authorizedRoot !== "string" || !authorizedRoot.trim())
    throw new Error("an explicit event-log authorized root is required");
  if (typeof body !== "string")
    throw new Error("private event-log replacement body must be a string");
  const { parent, fileName, parentIdentity } = replacementParent(authorizedRoot, destination);
  const resolvedDestination = join(parent, fileName);
  assertReplaceableDestination(resolvedDestination);
  const temp = createPrivateSibling(parent, fileName);
  let open = true;
  const bytes = Buffer.from(body, "utf8");
  try {
    ftruncateSync(temp.descriptor, 0);
    writeReplacementBody(temp.descriptor, bytes);
    fchmodSync(temp.descriptor, 0o600);
    if (!replacementIsUnchanged(parent, parentIdentity, temp, bytes.length)) {
      throw new Error("event-log parent or reserved replacement changed before commit");
    }
    // Node lacks fd-relative rename, leaving a detached same-UID post-check race.
    closeSync(temp.descriptor);
    open = false;
    renameSync(temp.path, resolvedDestination);
  } finally {
    cleanupPrivateSibling(temp, open);
  }
}
