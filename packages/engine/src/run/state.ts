/**
 * Owns pipeline state storage, locking, and containment-safe workspace path resolution.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { badInput } from "../primitives/errors.js";
import { engineRuntimeRoot } from "../primitives/installation-paths.js";

const packageRoot = engineRuntimeRoot;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_KEY_BY_PHASE = {
  arm: "brief",
  design: "design",
  "adversarial-review": "review",
  plan: "plan",
  pmatch: "drift_reports",
  build: "build",
  "release-readiness": "release_readiness",
  "post-build": "post_build",
};
const QUALITY_REPORT_PHASES = new Set(["security-review", "denoise"]);
let activeWorkspaceRoot: string | null = null;
export interface PipelineConfiguration extends Record<string, unknown> {
  feature_flags?: Record<string, unknown>;
  context_budgets?: Record<string, unknown>;
  cognitive_tiers?: Record<string, unknown>;
  activity_assignments?: Record<string, Record<string, unknown>>;
}

export interface PipelineState extends Record<string, unknown> {
  run_id?: string;
  current_phase?: string;
  completed_gates?: unknown[];
  artifacts?: Record<string, unknown>;
  config?: PipelineConfiguration;
  workspace?: Record<string, unknown>;
}
interface ResolveOptions {
  allowAbsolute?: boolean;
  allowBase?: boolean;
  baseLabel?: string;
}

export function getPackageRoot(): string {
  return packageRoot;
}

export function getWorkspaceRoot(): string {
  return resolve(packageRoot);
}

export function getRepoRoot(): string {
  return activeWorkspaceRoot ?? getWorkspaceRoot();
}

export function activateWorkspaceRoot(pathValue: string): string {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    throw badInput("project root must be a non-empty path");
  }
  const resolvedRoot = resolve(pathValue);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw badInput(`project root is not a directory: ${pathValue}`);
  }
  activeWorkspaceRoot = realpathSync(resolvedRoot);
  return activeWorkspaceRoot;
}

export function getPipelineDir(root = getRepoRoot()): string {
  return resolve(root, ".pipeline");
}

export function getPipelineStatePath(root = getRepoRoot()): string {
  return resolve(getPipelineDir(root), "pipeline-state.json");
}

export function getRunDir(runId: string, root = getRepoRoot()): string {
  if (!runId || typeof runId !== "string") {
    throw badInput("run_id is required");
  }
  if (!RUN_ID_PATTERN.test(runId)) {
    throw badInput(
      "run_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ and must not contain path separators",
    );
  }
  return resolve(getPipelineDir(root), "runs", runId);
}

export function ensureRunDirs(runId: string, root = getRepoRoot()): string {
  const runDir = getRunDir(runId, root);
  mkdirSync(resolve(runDir, "gates"), { recursive: true });
  mkdirSync(resolve(runDir, "drift-reports"), { recursive: true });
  mkdirSync(resolve(runDir, "quality-reports"), { recursive: true });
  return runDir;
}

export function readJson<T = null>(
  path: string,
  fallback: T = null as T,
): Record<string, unknown> | T {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw badInput(
      `failed to parse JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function readJsonStrict(path: string, context = path): Record<string, unknown> {
  if (!existsSync(path)) {
    throw badInput(`file not found: ${context}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw badInput(
      `failed to parse JSON at ${context}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function writeJson(path: string, value: unknown): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  // A state or artifact reader must never observe a partially written JSON file.
  // Keep the temporary file in the target directory so rename is atomic on the
  // same filesystem, then replace the old version only after the full payload
  // has been written.
  const temporaryPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function loadPipelineState(root = getRepoRoot()): PipelineState {
  const path = getPipelineStatePath(root);
  const state = readJson(path, null);
  if (!state) {
    throw badInput(
      `pipeline state not found at ${path}. Run npm run rae -- orchestrate init to initialize a pipeline run.`,
    );
  }
  return state as PipelineState;
}

export function savePipelineState(state: PipelineState, root = getRepoRoot()): void {
  writeJson(getPipelineStatePath(root), state);
}

export function getWorkspaceFromState(
  state: PipelineState,
  root = getRepoRoot(),
): {
  mode: unknown;
  root: string;
  primary_repo_root: string;
  branch: unknown;
  worktree_path: unknown;
  cleanup_command: unknown;
} {
  const resolvedRoot = resolve(root);
  const workspace =
    state.workspace && typeof state.workspace === "object" && !Array.isArray(state.workspace)
      ? (state.workspace as Record<string, unknown>)
      : {};
  return {
    mode: workspace.mode ?? "main-repo",
    root: typeof workspace.root === "string" ? workspace.root : resolvedRoot,
    primary_repo_root:
      typeof workspace.primary_repo_root === "string" ? workspace.primary_repo_root : resolvedRoot,
    branch: workspace.branch ?? "",
    worktree_path: workspace.worktree_path ?? null,
    cleanup_command: workspace.cleanup_command ?? null,
  };
}

/**
 * Execute fn with exclusive access to pipeline-state.json.
 * Uses a .lock sentinel file with O_EXCL to prevent concurrent access.
 *
 * @param {string} [root] Repository root (defaults to detected repo root)
 * @param {(state: object) => *} fn Callback receiving the loaded state; may mutate it.
 * @returns {*} The value returned by fn.
 */
/**
 * Serializes state updates with an exclusive lock so concurrent pipeline commands cannot overwrite each other.
 */
export function withLockedState<T>(
  root = getRepoRoot(),
  fn: (state: PipelineState) => T | Promise<T>,
): T | Promise<T> {
  const lockPath = join(getPipelineDir(root), "pipeline-state.lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600); // fails if lock exists
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      throw badInput(
        `Pipeline state is locked by another process. If this is stale, remove: ${lockPath}`,
      );
    }
    throw err;
  }
  const releaseLock = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore cleanup errors */
    }
  };

  closeSync(fd);
  let state: ReturnType<typeof loadPipelineState>;
  try {
    state = loadPipelineState(root);
  } catch (error) {
    releaseLock();
    throw error;
  }
  let result: ReturnType<typeof fn>;
  try {
    result = fn(state);
  } catch (error) {
    releaseLock();
    throw error;
  }

  if (
    result &&
    typeof result === "object" &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    return Promise.resolve(result)
      .then((value) => {
        savePipelineState(state, root);
        return value;
      })
      .finally(releaseLock);
  }

  try {
    savePipelineState(state, root);
    return result;
  } finally {
    releaseLock();
  }
}

function assertPathWithinBase(
  resolvedPath: string,
  baseReal: string,
  pathRef: string,
  allowBase = false,
  baseLabel = "base directory",
): void {
  const rel = relative(baseReal, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel) || (!allowBase && rel.length === 0)) {
    if (!allowBase && rel.length === 0) {
      throw badInput(`path reference must not point to ${baseLabel}`);
    }
    throw badInput(`path escapes ${baseLabel}: ${pathRef}`);
  }
}

function findNearestExistingAncestor(pathValue: string): string {
  let current = resolve(pathValue);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

function resolveWithinBase(pathRef: string, baseDir: string, options: ResolveOptions = {}): string {
  if (!pathRef || typeof pathRef !== "string") {
    throw badInput("path reference must be a non-empty string");
  }

  const allowAbsolute = options.allowAbsolute === true;
  const allowBase = options.allowBase === true;
  const baseLabel = options.baseLabel || "base directory";
  if (isAbsolute(pathRef) && !allowAbsolute) {
    throw badInput("path reference must be relative");
  }

  const baseReal = realpathSync(baseDir);
  const resolved = isAbsolute(pathRef) ? resolve(pathRef) : resolve(baseReal, pathRef);
  assertPathWithinBase(resolved, baseReal, pathRef, allowBase, baseLabel);

  const nearestExisting = findNearestExistingAncestor(resolved);
  const nearestReal = realpathSync(nearestExisting);
  // The nearest existing ancestor can legitimately be the base directory itself
  // when resolving a new file path under baseDir.
  assertPathWithinBase(nearestReal, baseReal, pathRef, true, baseLabel);

  if (existsSync(resolved)) {
    const resolvedReal = realpathSync(resolved);
    assertPathWithinBase(resolvedReal, baseReal, pathRef, allowBase, baseLabel);
    return resolvedReal;
  }

  return resolved;
}

/**
 * Resolves a user-provided reference only when it remains contained by the active repository root.
 */
export function resolveWithinRepo(pathRef: string, root = getRepoRoot()): string {
  return resolveWithinBase(pathRef, root, {
    allowAbsolute: true,
    allowBase: false,
    baseLabel: "repository root",
  });
}

export function resolveWithinDirectory(
  baseDir: string,
  pathRef: string,
  options: ResolveOptions = {},
): string {
  return resolveWithinBase(pathRef, baseDir, {
    allowAbsolute: options.allowAbsolute === true,
    allowBase: options.allowBase === true,
    baseLabel: options.baseLabel || "base directory",
  });
}

export function toWorkspaceRelative(absPath: string, root = getRepoRoot()): string {
  const rootReal = realpathSync(root);
  const resolved = existsSync(absPath) ? realpathSync(absPath) : resolve(absPath);
  const rel = relative(rootReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.length === 0) {
    throw badInput(`path is outside repository root: ${absPath}`);
  }
  return rel;
}

export function gateFileNameForPhase(phase: string): string {
  if (phase === "post-build") {
    return "postbuild-gate.json";
  }
  return `${phase}-gate.json`;
}

export function phaseToArtifactKey(phase: string): string | null {
  const directKey = Object.hasOwn(ARTIFACT_KEY_BY_PHASE, phase)
    ? ARTIFACT_KEY_BY_PHASE[phase as keyof typeof ARTIFACT_KEY_BY_PHASE]
    : undefined;
  if (directKey) return directKey;
  if (phase.startsWith("quality") || QUALITY_REPORT_PHASES.has(phase)) {
    return "quality_reports";
  }
  return null;
}

export function parseBooleanFlag(value: unknown): boolean {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return false;
}

function findGitTopLevel(root: string): string {
  let gitTopLevel = resolve(root);
  while (!existsSync(resolve(gitTopLevel, ".git")) && dirname(gitTopLevel) !== gitTopLevel) {
    gitTopLevel = dirname(gitTopLevel);
  }
  return gitTopLevel;
}

function addNestedWorktreeRoots(candidateRoots: Set<string>, gitTopLevel: string): void {
  const worktreesDir = resolve(gitTopLevel, ".worktrees");
  if (!existsSync(worktreesDir)) return;

  for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidateRoots.add(resolve(worktreesDir, entry.name));
    }
  }
}

function addRegisteredWorktreeRoots(candidateRoots: Set<string>, gitTopLevel: string): void {
  // Custom --worktree-root paths are not descendants of .worktrees. Git's
  // registry is the authoritative source for every linked worktree location.
  const worktreeList = spawnSync(
    "git",
    ["-C", gitTopLevel, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8" },
  );
  if (worktreeList.status !== 0) return;

  for (const field of worktreeList.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      candidateRoots.add(resolve(field.slice("worktree ".length)));
    }
  }
}

function discoverWorkspaceCandidateRoots(root: string): Set<string> {
  const gitTopLevel = findGitTopLevel(root);
  const candidateRoots = new Set<string>();
  addNestedWorktreeRoots(candidateRoots, gitTopLevel);
  addRegisteredWorktreeRoots(candidateRoots, gitTopLevel);
  return candidateRoots;
}

export function resolveWorkspaceRootForRun(runId: string, root = getRepoRoot()): string {
  const directState = readJson(getPipelineStatePath(root), null);
  if (directState && directState.run_id === runId) {
    return getWorkspaceFromState(directState, root).root;
  }

  for (const candidateRoot of discoverWorkspaceCandidateRoots(root)) {
    const candidateState = readJson(
      resolve(candidateRoot, ".pipeline", "pipeline-state.json"),
      null,
    );
    if (candidateState && candidateState.run_id === runId) {
      return getWorkspaceFromState(candidateState, candidateRoot).root;
    }
  }

  return root;
}

export function activateWorkspaceForRun(runId: string, root = getRepoRoot()): string {
  return resolveWorkspaceRootForRun(runId, root);
}
