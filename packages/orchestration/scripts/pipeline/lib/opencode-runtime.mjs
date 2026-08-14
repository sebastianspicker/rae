/** Creates the sealed OpenCode runtime and verifies its executable identity. */
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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, resolve } from "node:path";
import { inlineConfig, safeChildEnvironment, verificationCatalog } from "./opencode-policy.mjs";

const RUNTIME_DIRECTORIES = Object.freeze([
  "home",
  "config",
  "cache",
  "data",
  "state",
  "tmp",
  "opencodeConfig",
]);

export function executableFromPath(command, env) {
  for (const candidate of isAbsolute(command)
    ? [command]
    : String(env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, command))) {
    const executable = executableCandidate(candidate);
    if (executable) return executable;
  }
  return null;
}

function executableCandidate(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}
export function assertExecutable(pathValue, { requireRoot = false } = {}) {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${pathValue} is not a regular executable`);
  if (requireRoot && stat.uid !== 0) throw new Error(`${pathValue} must be root-owned`);
  accessSync(pathValue, fsConstants.X_OK);
  return realpathSync(pathValue);
}

function initializeDirectories(root) {
  chmodSync(root, 0o700);
  return Object.fromEntries(
    RUNTIME_DIRECTORIES.map((name) => {
      const pathValue = resolve(root, name);
      mkdirSync(pathValue, { recursive: true, mode: 0o700 });
      return [name, pathValue];
    }),
  );
}

function configuredAuthSource(env, authPath) {
  return (
    authPath ?? resolve(env.HOME ? resolve(env.HOME) : homedir(), ".local/share/opencode/auth.json")
  );
}

function initializeAuth(runtime, authSource) {
  if (!existsSync(authSource)) return;
  const stat = lstatSync(authSource);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("OpenCode auth store must be a regular non-symlink file");
  const directory = resolve(runtime.data, "opencode");
  mkdirSync(directory, { mode: 0o700 });
  symlinkSync(realpathSync(authSource), resolve(directory, "auth.json"));
  runtime.authSource = realpathSync(authSource);
}

function initializeConfiguration(runtime, workspaceRoot, sandboxMode) {
  runtime.catalogPath = resolve(runtime.root, "verification-catalog.json");
  runtime.evidencePath = resolve(runtime.root, "verification-evidence.jsonl");
  writeFileSync(runtime.catalogPath, `${JSON.stringify(verificationCatalog())}\n`, {
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
}

function initializeRuntime(createdRoot, options) {
  const root = realpathSync(createdRoot);
  const runtime = initializeDirectories(root);
  runtime.root = root;
  initializeAuth(runtime, configuredAuthSource(options.env, options.authPath));
  initializeConfiguration(runtime, options.workspaceRoot, options.sandboxMode);
  runtime.env = safeChildEnvironment(options.env, runtime, runtime.configValue, runtime.permission);
  return runtime;
}

function rollbackRuntime(root) {
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function prepareRuntime({ env, workspaceRoot, sandboxMode, authPath }) {
  const createdRoot = mkdtempSync(resolve(tmpdir(), "rae-opencode-"));
  try {
    return initializeRuntime(createdRoot, { env, workspaceRoot, sandboxMode, authPath });
  } catch (error) {
    rollbackRuntime(createdRoot);
    throw error;
  }
}
export function runtimeIdentity(executable, version) {
  return Object.freeze({
    executor: "opencode",
    executable,
    version,
    binary_digest: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
}
