/** Initializes autonomous workspaces and restores immutable run requests. */
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { loadAutonomousPolicy, policyDigest, validateAutonomousPolicy } from "..\/..\/lib\/autonomous-policy.mjs";
import { getRunDir, readJsonStrict, writeJson } from "./state.mjs";
import { checkpointPolicy } from "./operator-control.mjs";
import { assertGitRepository, changedPaths, gitOutput, gitStateSnapshot, requireDirectory, runProcess } from "./autonomous-git.mjs";
import { reconcileRuntimeStateGuard } from "./runtime-state-guard.mjs";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PIPELINE_INIT = resolve(PACKAGE_ROOT, "scripts/pipeline-init.sh");
const MAX_TASK_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 1800;
function assertCleanForInPlace(root) {
  const dirty = changedPaths(root);
  if (dirty.length > 0) {
    throw new Error(
      `--in-place requires a clean checkout; existing changes: ${dirty.slice(0, 8).join(", ")}`,
    );
  }
  if (existsSync(resolve(root, ".pipeline", "pipeline-state.json"))) {
    throw new Error(
      "--in-place would overwrite an existing .pipeline run; use resume from that workspace or the default worktree mode",
    );
  }
}

function parseInitField(output, field) {
  const match = output.match(new RegExp(`^\\s*${field}:\\s*(.+)$`, "m"));
  if (!match) throw new Error(`pipeline initialization did not report ${field}`);
  return match[1].trim();
}

function initializeRun(projectRoot, inPlace) {
  if (inPlace) assertCleanForInPlace(projectRoot);
  const args = [PIPELINE_INIT, projectRoot];
  if (!inPlace) {
    const gitCommonDir = gitOutput(projectRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).trim();
    args.push("--use-worktree", "--worktree-root", resolve(gitCommonDir, "rae-worktrees"));
  }
  const proc = runProcess("bash", args, {
    cwd: PACKAGE_ROOT,
    timeout: 60_000,
    label: "pipeline initialization",
  });
  const runId = parseInitField(proc.stdout, "run_id");
  const workspaceRoot = requireDirectory(
    parseInitField(proc.stdout, "workspace_root"),
    "workspace",
  );
  return { runId, workspaceRoot, initializationOutput: proc.stdout };
}

const TASK_FILE_IO = {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
};

function sameTaskIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedTask(descriptor, io) {
  const buffer = Buffer.alloc(MAX_TASK_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = io.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > MAX_TASK_BYTES) {
    throw new Error(`task file exceeds ${MAX_TASK_BYTES} bytes`);
  }
  return buffer.subarray(0, offset);
}

/** Accepts a descriptor-bound, bounded repository-local Markdown or text task file. */
export function safeTaskFile(pathValue, projectRoot, fsSeam = {}) {
  const io = { ...TASK_FILE_IO, ...fsSeam };
  if (typeof pathValue !== "string" || pathValue.length === 0 || isAbsolute(pathValue)) {
    throw new Error("--task-file must be a relative path under the project root");
  }
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("--task-file must not contain empty or traversal path segments");
  }
  if (segments.some(protectedTaskSegment)) {
    throw new Error(`refusing to read a protected credential task path: ${pathValue}`);
  }
  const canonicalRoot = io.realpathSync(projectRoot);
  const candidate = resolve(canonicalRoot, ...segments);
  const withinRoot = relative(canonicalRoot, candidate);
  if (!withinRoot || withinRoot.startsWith(`..${sep}`) || withinRoot === ".." || isAbsolute(withinRoot)) {
    throw new Error("--task-file must resolve below the project root");
  }
  if (![".md", ".txt"].includes(extname(candidate).toLowerCase())) {
    throw new Error("--task-file must name a .md or .txt file");
  }
  const suppliedStat = io.lstatSync(candidate, { bigint: true });
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isFile()) {
    throw new Error("--task-file must be a regular, non-symlink file");
  }
  const resolvedPath = io.realpathSync(candidate);
  if (resolvedPath !== candidate) {
    throw new Error("--task-file path must not traverse a symlink");
  }
  if (protectedTaskSegment(basename(resolvedPath).toLowerCase())) {
    throw new Error(`refusing to read a protected credential task file: ${pathValue}`);
  }
  if (suppliedStat.size > BigInt(MAX_TASK_BYTES)) {
    throw new Error(`task file exceeds ${MAX_TASK_BYTES} bytes: ${pathValue}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  let bytes;
  try {
    descriptor = io.openSync(resolvedPath, fsConstants.O_RDONLY | noFollow);
    const before = io.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error("--task-file must be a regular, non-symlink file");
    }
    if (before.size > BigInt(MAX_TASK_BYTES)) {
      throw new Error(`task file exceeds ${MAX_TASK_BYTES} bytes: ${pathValue}`);
    }
    if (!sameTaskIdentity(suppliedStat, before)) {
      throw new Error("--task-file changed before its descriptor was opened");
    }
    io.afterOpen?.({ candidate, descriptor });
    bytes = readBoundedTask(descriptor, io);
    const after = io.fstatSync(descriptor, { bigint: true });
    if (!sameTaskIdentity(before, after) || after.size !== BigInt(bytes.length)) {
      throw new Error("--task-file changed while it was being read");
    }
    const currentPathStat = io.lstatSync(candidate, { bigint: true });
    if (
      currentPathStat.isSymbolicLink() ||
      !currentPathStat.isFile() ||
      currentPathStat.dev !== after.dev ||
      currentPathStat.ino !== after.ino ||
      io.realpathSync(candidate) !== resolvedPath
    ) {
      throw new Error("--task-file path changed while it was being read");
    }
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
  }
  let task;
  try {
    task = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("--task-file must contain valid UTF-8 text");
  }
  if (!task) throw new Error("--task-file must not be empty");
  return task;
}

function protectedTaskSegment(segment) {
  const name = segment.toLowerCase();
  return name === ".env" || name.startsWith(".env.") || /\.(?:key|pem|p12|pfx)$/.test(name) || ["auth.json", ".git-credentials", ".netrc", ".npmrc", ".pypirc", "id_rsa", "id_rsa.pub", "id_ed25519", "id_ed25519.pub"].includes(name) || [".git", ".ssh", ".aws", ".azure", ".docker", ".gnupg", ".kube"].includes(name);
}

function resolveTask(options, projectRoot) {
  if (options.task && options["task-file"]) {
    throw new Error("use exactly one of --task or --task-file");
  }
  const task = options.task ?? (options["task-file"] ? safeTaskFile(options["task-file"], projectRoot) : "");
  if (!task.trim()) throw new Error("run requires --task <text> or --task-file <path>");
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new Error(`task exceeds ${MAX_TASK_BYTES} bytes`);
  }
  return task.trim();
}

function readRunRequest(workspaceRoot) {
  const state = readJsonStrict(resolve(workspaceRoot, ".pipeline", "pipeline-state.json"));
  const requestPath = resolve(getRunDir(state.run_id, workspaceRoot), "request.json");
  return { state, request: readJsonStrict(requestPath) };
}

export function savedAgentOptions(request) {
  const saved = request.agent ?? {};
  const storedProvider = saved.provider ?? request.provider ?? "auto";
  return {
    provider: storedProvider === "command" ? "auto" : storedProvider,
    agentArgs: [],
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.reasoning_effort ? { "reasoning-effort": saved.reasoning_effort } : {}),
    ...(saved.timeout_seconds ? { "timeout-seconds": String(saved.timeout_seconds) } : {}),
    "checkpoint-policy": request.checkpoint_policy ?? "none",
  };
}

export function mergeResumeOptions(saved, supplied) {
  assertResumeCheckpointPolicy(saved, supplied);
  const providerChanged = Boolean(supplied.provider && supplied.provider !== saved.provider);
  const base = providerChanged ? resetProviderOptions(saved) : saved;
  return {
    ...base,
    ...supplied,
    "checkpoint-policy": saved["checkpoint-policy"],
    agentArgs: supplied.agentArgs?.length
      ? supplied.agentArgs
      : providerChanged
        ? []
        : (saved.agentArgs ?? []),
  };
}

export function assertResumeCheckpointPolicy(saved, supplied) {
  if (supplied["checkpoint-policy"] && supplied["checkpoint-policy"] !== saved["checkpoint-policy"]) throw new Error("checkpoint policy is immutable for an existing autonomous run");
}

function resetProviderOptions(saved) {
  return { ...saved, "agent-command": undefined, agentArgs: [], "allow-unsafe-command-provider": false };
}

/**
 * Acquires an exclusive workflow lock and rejects concurrent runs that target the same workspace.
 */
export function acquireWorkflowLock(workspaceRoot, runId) {
  const lockPath = resolve(getRunDir(runId, workspaceRoot), "autonomous.lock");
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `autonomous run ${runId} is already active; inspect ${lockPath} and remove it only after confirming the owning process is gone`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(lockPath);
    throw error;
  }
  return () => {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}

export function initializeOrResume(command, options) {
  const projectRoot = requireDirectory(options["project-root"] ?? process.cwd(), "project root");
  assertGitRepository(projectRoot);
  if (command === "resume") {
    try {
      reconcileRuntimeStateGuard(projectRoot, { recovery: true });
    } catch (error) {
      error.pipelineStateUnsafe = true;
      throw error;
    }
    return resumeContext(projectRoot, options);
  }
  return newRunContext(projectRoot, options);
}

function resumeContext(projectRoot, options) {
  if (!options["run-id"]) throw new Error("resume requires --run-id <id>");
  const { state, request } = readRunRequest(projectRoot);
  if (state.run_id !== options["run-id"]) {
    throw new Error(`run-id mismatch: workspace has ${state.run_id}`);
  }
  const initialGitStatePath = resolve(getRunDir(state.run_id, projectRoot), "initial-git-state.json");
  if (!existsSync(initialGitStatePath)) {
    throw new Error(
      `resume requires the initial Git-state snapshot at ${initialGitStatePath}; start a new run instead`,
    );
  }
  const storedPolicy = storedRunPolicy(request, options);
  return {
    runId: state.run_id,
    workspaceRoot: projectRoot,
    projectRoot: state.workspace?.primary_repo_root ?? projectRoot,
    task: request.task,
    initialGitState: readJsonStrict(initialGitStatePath),
    resumed: true,
    savedAgentOptions: savedAgentOptions(request),
    policy: storedPolicy,
    policyDigest: policyDigest(storedPolicy),
  };
}

function storedRunPolicy(request, options) {
  const storedPolicy = request.policy?.snapshot
    ? validateAutonomousPolicy(request.policy.snapshot)
    : loadAutonomousPolicy().policy;
  const digest = policyDigest(storedPolicy);
  if (request.policy?.digest && request.policy.digest !== digest) {
    throw new Error("stored autonomous policy digest does not match its snapshot");
  }
  if (options.policy && loadAutonomousPolicy(options.policy).digest !== digest) {
    throw new Error("resume policy digest does not match the stored run policy");
  }
  return storedPolicy;
}

function newRunContext(projectRoot, options) {
  const task = resolveTask(options, projectRoot);
  // Fail before branch/worktree creation when the policy is malformed or points
  // at protected credential material.
  const resolvedPolicy = loadAutonomousPolicy(options.policy);
  const initialized = initializeRun(projectRoot, options["in-place"] === true);
  const runDir = resolve(initialized.workspaceRoot, ".pipeline", "runs", initialized.runId);
  writeJson(resolve(runDir, "request.json"), newRunRequest(task, projectRoot, initialized, options, resolvedPolicy));
  const gitStatePath = resolve(runDir, "initial-git-state.json");
  writeJson(gitStatePath, gitStateSnapshot(initialized.workspaceRoot));
  return {
    ...initialized,
    projectRoot,
    task,
    initialGitState: readJsonStrict(gitStatePath),
    resumed: false,
    policy: resolvedPolicy.policy,
    policyDigest: resolvedPolicy.digest,
  };
}

function newRunRequest(task, projectRoot, initialized, options, resolvedPolicy) {
  return {
    schema_version: "1.0.0",
    task,
    provider: options.provider ?? "auto",
    agent: requestedAgent(options),
    requested_at: new Date().toISOString(),
    primary_project_root: projectRoot,
    workspace_root: initialized.workspaceRoot,
    workspace_mode: options["in-place"] ? "main-repo" : "git-worktree",
    mutation_policy: "workspace-only-no-commit-no-push",
    checkpoint_policy: checkpointPolicy(options["checkpoint-policy"]),
    policy: requestedPolicy(resolvedPolicy),
  };
}

function requestedAgent(options) {
  return {
    provider: options.provider ?? "auto",
    ...agentCommand(options),
    command_args: options.agentArgs,
    ...agentTuning(options),
    allow_unsafe_command_provider: options["allow-unsafe-command-provider"] === true,
  };
}

function agentCommand(options) { return { command: options["agent-command"] ?? null }; }
function agentTuning(options) {
  return {
    model: options.model ?? null,
    reasoning_effort: options["reasoning-effort"] ?? null,
    timeout_seconds: Number(options["timeout-seconds"] ?? DEFAULT_TIMEOUT_SECONDS),
  };
}

function requestedPolicy(resolvedPolicy) {
  return {
    policy_id: resolvedPolicy.policy.policy_id,
    digest: resolvedPolicy.digest,
    source: resolvedPolicy.source,
    snapshot: resolvedPolicy.policy,
  };
}
