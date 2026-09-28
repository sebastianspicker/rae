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
import { inlineConfig, safeChildEnvironment, verificationCatalog } from "./opencode-policy.js";
import type { OpenCodeRuntimePaths, PermissionSurface } from "./opencode-policy.js";

const RUNTIME_DIRECTORIES = Object.freeze([
  "home",
  "config",
  "cache",
  "data",
  "state",
  "tmp",
  "opencodeConfig",
]);

export interface OpenCodeRuntime extends OpenCodeRuntimePaths {
  root: string;
  authSource?: string;
  catalogPath: string;
  evidencePath: string;
  configValue: Record<string, unknown>;
  permission: PermissionSurface;
  env: NodeJS.ProcessEnv;
}

export interface PrepareRuntimeOptions {
  env: NodeJS.ProcessEnv;
  workspaceRoot: string;
  sandboxMode: string;
  authPath?: string;
}

export interface OpenCodeRuntimeIdentity extends Readonly<Record<string, string>> {
  executor: "opencode";
  executable: string;
  version: string;
  binary_digest: string;
}

export function executableFromPath(command: string, env: NodeJS.ProcessEnv): string | null {
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

function executableCandidate(candidate: string): string | null {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return realpathSync(candidate);
  } catch {
    return null;
  }
}
export function assertExecutable(
  pathValue: string,
  { requireRoot = false }: { requireRoot?: boolean } = {},
): string {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${pathValue} is not a regular executable`);
  if (requireRoot && stat.uid !== 0) throw new Error(`${pathValue} must be root-owned`);
  accessSync(pathValue, fsConstants.X_OK);
  return realpathSync(pathValue);
}

function initializeDirectories(root: string): OpenCodeRuntimePaths {
  chmodSync(root, 0o700);
  const paths = Object.fromEntries(
    RUNTIME_DIRECTORIES.map((name) => [name, resolve(root, name)]),
  ) as unknown as OpenCodeRuntimePaths;
  for (const pathValue of Object.values(paths)) {
    mkdirSync(pathValue, { recursive: true, mode: 0o700 });
  }
  return paths;
}

function configuredAuthSource(env: NodeJS.ProcessEnv, authPath?: string): string {
  return (
    authPath ?? resolve(env.HOME ? resolve(env.HOME) : homedir(), ".local/share/opencode/auth.json")
  );
}

function initializeAuth(runtime: OpenCodeRuntimePaths, authSource: string): string | undefined {
  if (!existsSync(authSource)) return undefined;
  const stat = lstatSync(authSource);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("OpenCode auth store must be a regular non-symlink file");
  const directory = resolve(runtime.data, "opencode");
  mkdirSync(directory, { mode: 0o700 });
  symlinkSync(realpathSync(authSource), resolve(directory, "auth.json"));
  return realpathSync(authSource);
}

function initializeRuntime(createdRoot: string, options: PrepareRuntimeOptions): OpenCodeRuntime {
  const root = realpathSync(createdRoot);
  const paths = initializeDirectories(root);
  const authSource = initializeAuth(paths, configuredAuthSource(options.env, options.authPath));
  const catalogPath = resolve(root, "verification-catalog.json");
  const evidencePath = resolve(root, "verification-evidence.jsonl");
  writeFileSync(catalogPath, `${JSON.stringify(verificationCatalog())}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const config = inlineConfig({
    writeAccess: options.sandboxMode === "workspace-write",
    workspaceRoot: options.workspaceRoot,
    catalogPath,
    evidencePath,
  });
  const permission = config.permission as PermissionSurface;
  const env = safeChildEnvironment(options.env, paths, config, permission);
  return {
    ...paths,
    root,
    ...(authSource ? { authSource } : {}),
    catalogPath,
    evidencePath,
    configValue: config,
    permission,
    env,
  };
}

function rollbackRuntime(root: string): boolean {
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function prepareRuntime({
  env,
  workspaceRoot,
  sandboxMode,
  authPath,
}: PrepareRuntimeOptions): OpenCodeRuntime {
  const createdRoot = mkdtempSync(resolve(tmpdir(), "rae-opencode-"));
  try {
    return initializeRuntime(createdRoot, { env, workspaceRoot, sandboxMode, authPath });
  } catch (error) {
    rollbackRuntime(createdRoot);
    throw error;
  }
}
export function runtimeIdentity(executable: string, version: string): OpenCodeRuntimeIdentity {
  return Object.freeze({
    executor: "opencode",
    executable,
    version,
    binary_digest: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
}
