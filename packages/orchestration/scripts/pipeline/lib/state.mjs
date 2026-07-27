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
import { badInput } from "./errors.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
let activeWorkspaceRoot = null;

export function getPackageRoot() {
  return packageRoot;
}

export function getWorkspaceRoot() {
  return resolve(packageRoot);
}

export function getRepoRoot() {
  return activeWorkspaceRoot ?? getWorkspaceRoot();
}

export function activateWorkspaceRoot(pathValue) {
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

export function getPipelineDir(root = getRepoRoot()) {
  return resolve(root, ".pipeline");
}

export function getPipelineStatePath(root = getRepoRoot()) {
  return resolve(getPipelineDir(root), "pipeline-state.json");
}

export function getRunDir(runId, root = getRepoRoot()) {
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

export function ensureRunDirs(runId, root = getRepoRoot()) {
  const runDir = getRunDir(runId, root);
  mkdirSync(resolve(runDir, "gates"), { recursive: true });
  mkdirSync(resolve(runDir, "drift-reports"), { recursive: true });
  mkdirSync(resolve(runDir, "quality-reports"), { recursive: true });
  return runDir;
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    return fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw badInput(`failed to parse JSON at ${path}: ${e.message}`);
  }
}

export function readJsonStrict(path, context = path) {
  if (!existsSync(path)) {
    throw badInput(`file not found: ${context}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw badInput(`failed to parse JSON at ${context}: ${e.message}`);
  }
}

export function writeJson(path, value) {
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

export function loadPipelineState(root = getRepoRoot()) {
  const path = getPipelineStatePath(root);
  const state = readJson(path, null);
  if (!state) {
    throw badInput(
      `pipeline state not found at ${path}. Run ./scripts/pipeline-init.sh to initialize a pipeline run.`,
    );
  }
  return state;
}

export function savePipelineState(state, root = getRepoRoot()) {
  writeJson(getPipelineStatePath(root), state);
}

export function getWorkspaceFromState(state, root = getRepoRoot()) {
  const resolvedRoot = resolve(root);
  const workspace = state?.workspace ?? {};
  return {
    mode: workspace.mode ?? "main-repo",
    root: workspace.root ?? resolvedRoot,
    primary_repo_root: workspace.primary_repo_root ?? resolvedRoot,
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
export function withLockedState(root = getRepoRoot(), fn) {
  const lockPath = join(getPipelineDir(root), "pipeline-state.lock");
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600); // fails if lock exists
  } catch (err) {
    if (err.code === "EEXIST") {
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
  let state;
  try {
    state = loadPipelineState(root);
  } catch (error) {
    releaseLock();
    throw error;
  }
  let result;
  try {
    result = fn(state);
  } catch (error) {
    releaseLock();
    throw error;
  }

  if (result && typeof result.then === "function") {
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
  resolvedPath,
  baseReal,
  pathRef,
  allowBase = false,
  baseLabel = "base directory",
) {
  const rel = relative(baseReal, resolvedPath);
  if (rel.startsWith("..") || isAbsolute(rel) || (!allowBase && rel.length === 0)) {
    if (!allowBase && rel.length === 0) {
      throw badInput(`path reference must not point to ${baseLabel}`);
    }
    throw badInput(`path escapes ${baseLabel}: ${pathRef}`);
  }
}

function findNearestExistingAncestor(pathValue) {
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

function resolveWithinBase(pathRef, baseDir, options = {}) {
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
export function resolveWithinRepo(pathRef, root = getRepoRoot()) {
  return resolveWithinBase(pathRef, root, {
    allowAbsolute: true,
    allowBase: false,
    baseLabel: "repository root",
  });
}

export function resolveWithinDirectory(baseDir, pathRef, options = {}) {
  return resolveWithinBase(pathRef, baseDir, {
    allowAbsolute: options.allowAbsolute === true,
    allowBase: options.allowBase === true,
    baseLabel: options.baseLabel || "base directory",
  });
}

export function toWorkspaceRelative(absPath, root = getRepoRoot()) {
  const rootReal = realpathSync(root);
  const resolved = existsSync(absPath) ? realpathSync(absPath) : resolve(absPath);
  const rel = relative(rootReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.length === 0) {
    throw badInput(`path is outside repository root: ${absPath}`);
  }
  return rel;
}

export function gateFileNameForPhase(phase) {
  if (phase === "post-build") {
    return "postbuild-gate.json";
  }
  return `${phase}-gate.json`;
}

export function phaseToArtifactKey(phase) {
  const directKey = ARTIFACT_KEY_BY_PHASE[phase];
  if (directKey) return directKey;
  if (phase.startsWith("quality") || QUALITY_REPORT_PHASES.has(phase)) {
    return "quality_reports";
  }
  return null;
}

export function parseBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  }
  return false;
}

export function resolveWorkspaceRootForRun(runId, root = getRepoRoot()) {
  const directState = readJson(getPipelineStatePath(root), null);
  if (directState?.run_id === runId) {
    return getWorkspaceFromState(directState, root).root;
  }

  let gitTopLevel = resolve(root);
  while (!existsSync(resolve(gitTopLevel, ".git")) && dirname(gitTopLevel) !== gitTopLevel) {
    gitTopLevel = dirname(gitTopLevel);
  }

  const candidateRoots = new Set();
  const worktreesDir = resolve(gitTopLevel, ".worktrees");
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidateRoots.add(resolve(worktreesDir, entry.name));
      }
    }
  }

  // Custom --worktree-root paths are not descendants of .worktrees. Git's
  // registry is the authoritative source for every linked worktree location.
  const worktreeList = spawnSync(
    "git",
    ["-C", gitTopLevel, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8" },
  );
  if (worktreeList.status === 0) {
    for (const field of worktreeList.stdout.split("\0")) {
      if (field.startsWith("worktree ")) {
        candidateRoots.add(resolve(field.slice("worktree ".length)));
      }
    }
  }

  for (const candidateRoot of candidateRoots) {
    const candidateState = readJson(
      resolve(candidateRoot, ".pipeline", "pipeline-state.json"),
      null,
    );
    if (candidateState?.run_id === runId) {
      return getWorkspaceFromState(candidateState, candidateRoot).root;
    }
  }

  return root;
}

export function activateWorkspaceForRun(runId, root = getRepoRoot()) {
  return resolveWorkspaceRootForRun(runId, root);
}
