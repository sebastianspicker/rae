/** Initializes autonomous workspaces and restores immutable run requests. */
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import {
  loadAutonomousPolicy,
  policyDigest,
  validateAutonomousPolicy,
} from "./autonomous-policy.js";
import { getRunDir, readJsonStrict, writeJson } from "./state.js";
import { checkpointPolicy } from "./operator-control.js";
import {
  assertGitRepository,
  changedPaths,
  gitOutput,
  gitStateSnapshot,
  requireDirectory,
  runProcess,
} from "./autonomous-git.js";
import { reconcileRuntimeStateGuard } from "./runtime-state-guard.js";
import { loadWorkflow, validateWorkflow, workflowDigest } from "../workflow/workflow-contract.js";
import {
  contextPolicyDigest,
  contextPolicySnapshot,
  validateContextPolicy,
} from "../workflow/workflow-context-bounded.js";
import type { ContextMode, ContextPolicy } from "../workflow/workflow-context-bounded.js";
import type { WorkflowContract } from "../workflow/workflow-contract.js";
import type { ExecutionProfile } from "../workflow/execution-profile.js";
import type { AutonomousPolicy } from "@rae/contracts";
import type { GitStateSnapshot } from "./autonomous-git.js";
import type { AgentProvider } from "../agents/agent-executor.js";
import { DEFAULT_WORKFLOW_PATH, resolveActivatedWorkflow } from "../workflow/workflow-registry.js";
import {
  assertExecutionProfileCoverage,
  executionProfileExecutors,
  executionProfileDigest,
  loadExecutionProfile,
  resolveWorkflowRoutes,
  validateExecutionProfile,
} from "../workflow/execution-profile.js";
import { providerRuntimeIdentity } from "../agents/agent-executor.js";
import { engineRuntimeRoot, pipelineInitEntrypoint } from "../primitives/installation-paths.js";
import { isContainedRelative } from "../primitives/paths.js";
const PIPELINE_INIT = pipelineInitEntrypoint();
const MAX_TASK_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 1800;

export interface AutonomousCommandOptions extends Record<string, unknown> {
  "project-root"?: string;
  "run-id"?: string;
  "task-file"?: string;
  task?: string;
  policy?: string;
  workflow?: string;
  "execution-profile"?: string;
  "execution-profile-snapshot"?: boolean;
  "context-mode"?: ContextMode;
  "checkpoint-policy"?: string;
  "graph-memory"?: string;
  "legacy-linear"?: boolean;
  "max-concurrency"?: string | number;
  "max-repair-rounds"?: string | number;
  "in-place"?: boolean;
  provider?: AgentProvider | "auto";
  "agent-command"?: string;
  agentArgs?: readonly string[];
  model?: string;
  "reasoning-effort"?: string;
  variant?: string;
  "timeout-seconds"?: string | number;
  "allow-unsafe-command-provider"?: boolean;
}

interface TaskFileIo {
  closeSync(descriptor: number): void;
  fstatSync(descriptor: number, options: { bigint: true }): BigIntStats;
  lstatSync(path: string, options: { bigint: true }): BigIntStats;
  openSync(path: string, flags: number): number;
  readSync(
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): number;
  realpathSync(path: string): string;
  afterOpen?: (context: { candidate: string; descriptor: number }) => void;
}

interface TaskPath {
  candidate: string;
  resolvedPath: string;
  suppliedStat: BigIntStats;
}

type LoadedWorkflow = Readonly<{ workflow: WorkflowContract; digest: string; source: string }>;
type ResolvedWorkflow = Readonly<{ workflow: WorkflowContract; digest: string; source?: string }>;
type LoadedProfile = Readonly<{ profile: ExecutionProfile; digest: string; source: string }>;
type ResolvedPolicy = ReturnType<typeof loadAutonomousPolicy>;
interface RuntimeIdentity extends Record<string, unknown> {
  executor: AgentProvider;
  version: string;
  binary_digest: string | null;
}
interface StoredRuntimeSnapshot extends Record<string, unknown> {
  routes: Array<
    Record<string, unknown> & {
      node_id: string;
      tier: "economy" | "standard" | "judgment";
    }
  >;
}
interface ContextPolicyResolution {
  mode: ContextMode;
  policy: ContextPolicy | null;
  digest: string | null;
}
interface InitializedRun {
  runId: string;
  workspaceRoot: string;
  initializationOutput: string;
}
interface NewRunData {
  task: string;
  projectRoot: string;
  initialized: InitializedRun;
  options: AutonomousCommandOptions;
  resolvedPolicy: ResolvedPolicy;
  resolvedWorkflow: LoadedWorkflow | null;
  resolvedExecutionProfile: LoadedProfile | null;
  resolvedExecutionRuntime: StoredRuntimeSnapshot | null;
  directExecutionRuntime: RuntimeIdentity | null;
  resolvedContextPolicy: ContextPolicyResolution;
}
interface StoredAgentRequest extends Record<string, unknown> {
  provider?: AgentProvider | "auto";
  command?: string | null;
  command_args?: readonly string[];
  model?: string | null;
  reasoning_effort?: string | null;
  variant?: string | null;
  timeout_seconds?: number;
  runtime?: RuntimeIdentity | null;
}
interface StoredWorkflowRequest extends Record<string, unknown> {
  mode?: "legacy-linear" | "graph-native";
  max_concurrency?: number;
  max_repair_rounds?: number;
  snapshot?: unknown;
  digest?: string;
}
interface StoredContextPolicy extends Record<string, unknown> {
  mode?: ContextMode;
  digest?: string;
  snapshot?: unknown;
}
interface StoredExecutionProfile extends Record<string, unknown> {
  snapshot?: unknown;
  digest?: string;
  runtime?: StoredRuntimeSnapshot | null;
}
interface StoredPolicy extends Record<string, unknown> {
  snapshot?: unknown;
  digest?: string;
}
export interface RunRequest extends Record<string, unknown> {
  task: string;
  provider?: AgentProvider | "auto";
  checkpoint_policy?: string;
  graph_memory?: string;
  agent?: StoredAgentRequest;
  policy?: StoredPolicy;
  workflow?: StoredWorkflowRequest;
  context_policy?: StoredContextPolicy;
  execution_profile?: StoredExecutionProfile | null;
}

export interface AutonomousLifecycleContext extends Record<string, unknown> {
  runId: string;
  workspaceRoot: string;
  projectRoot: string;
  task: string;
  initialGitState: GitStateSnapshot;
  resumed: boolean;
  policy: AutonomousPolicy;
  policyDigest: string;
  workflow: WorkflowContract | null;
  workflowDigest: string | null;
  workflowMode: string;
  executionProfile: ExecutionProfile | null;
  executionProfileDigest: string | null;
  executionRuntime: unknown;
  contextMode: ContextMode;
  contextPolicy: ContextPolicy | null;
  contextPolicyDigest: string | null;
  runDir: string;
  savedAgentOptions?: AutonomousCommandOptions;
}

function assertCleanForInPlace(root: string): void {
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

function parseInitField(output: string, field: string): string {
  const prefix = `${field}:`;
  const line = output.split("\n").find((item) => item.trimStart().startsWith(prefix));
  if (!line) throw new Error(`pipeline initialization did not report ${field}`);
  return line.trimStart().slice(prefix.length).trim();
}

function initializeRun(
  projectRoot: string,
  inPlace: boolean,
): {
  runId: string;
  workspaceRoot: string;
  initializationOutput: string;
} {
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
  const proc = runProcess(process.execPath, args, {
    cwd: engineRuntimeRoot,
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

const TASK_FILE_IO: TaskFileIo = {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
};

function sameTaskIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedTask(descriptor: number, io: TaskFileIo): Buffer {
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

function taskPathSegments(pathValue: string): string[] {
  if (typeof pathValue !== "string" || pathValue.length === 0 || isAbsolute(pathValue)) {
    throw new Error("--task-file must be a relative path under the project root");
  }
  const segments = pathValue.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("--task-file must not contain empty or traversal path segments");
  }
  if (segments.some(protectedTaskSegment)) {
    throw new Error(`refusing to read a protected credential task path: ${pathValue}`);
  }
  return segments;
}

function resolvesBelowRoot(canonicalRoot: string, candidate: string): boolean {
  const withinRoot = relative(canonicalRoot, candidate);
  return withinRoot !== "" && isContainedRelative(withinRoot);
}

function validateTaskCandidate(pathValue: string, candidate: string, io: TaskFileIo): BigIntStats {
  if (![".md", ".txt"].includes(extname(candidate).toLowerCase())) {
    throw new Error("--task-file must name a .md or .txt file");
  }
  const suppliedStat = io.lstatSync(candidate, { bigint: true });
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isFile()) {
    throw new Error("--task-file must be a regular, non-symlink file");
  }
  if (suppliedStat.size > BigInt(MAX_TASK_BYTES)) {
    throw new Error(`task file exceeds ${MAX_TASK_BYTES} bytes: ${pathValue}`);
  }
  return suppliedStat;
}

function safeTaskPath(pathValue: string, projectRoot: string, io: TaskFileIo): TaskPath {
  const segments = taskPathSegments(pathValue);
  const canonicalRoot = io.realpathSync(projectRoot);
  const candidate = resolve(canonicalRoot, ...segments);
  if (!resolvesBelowRoot(canonicalRoot, candidate)) {
    throw new Error("--task-file must resolve below the project root");
  }
  const suppliedStat = validateTaskCandidate(pathValue, candidate, io);
  const resolvedPath = io.realpathSync(candidate);
  if (resolvedPath !== candidate) throw new Error("--task-file path must not traverse a symlink");
  if (protectedTaskSegment(basename(resolvedPath).toLowerCase())) {
    throw new Error(`refusing to read a protected credential task file: ${pathValue}`);
  }
  return { candidate, resolvedPath, suppliedStat };
}

function assertStableTaskPath(
  candidate: string,
  resolvedPath: string,
  expected: BigIntStats,
  io: TaskFileIo,
): void {
  const current = io.lstatSync(candidate, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    io.realpathSync(candidate) !== resolvedPath
  ) {
    throw new Error("--task-file path changed while it was being read");
  }
}

function readStableTask(pathValue: string, taskPath: TaskPath, io: TaskFileIo): Buffer {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = io.openSync(taskPath.resolvedPath, fsConstants.O_RDONLY | noFollow);
    const before = io.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("--task-file must be a regular, non-symlink file");
    if (before.size > BigInt(MAX_TASK_BYTES)) {
      throw new Error(`task file exceeds ${MAX_TASK_BYTES} bytes: ${pathValue}`);
    }
    if (!sameTaskIdentity(taskPath.suppliedStat, before)) {
      throw new Error("--task-file changed before its descriptor was opened");
    }
    io.afterOpen?.({ candidate: taskPath.candidate, descriptor });
    const bytes = readBoundedTask(descriptor, io);
    const after = io.fstatSync(descriptor, { bigint: true });
    if (!sameTaskIdentity(before, after) || after.size !== BigInt(bytes.length)) {
      throw new Error("--task-file changed while it was being read");
    }
    assertStableTaskPath(taskPath.candidate, taskPath.resolvedPath, after, io);
    return bytes;
  } finally {
    if (descriptor !== undefined) io.closeSync(descriptor);
  }
}

/** Accepts a descriptor-bound, bounded repository-local Markdown or text task file. */
export function safeTaskFile(
  pathValue: string,
  projectRoot: string,
  fsSeam: Partial<TaskFileIo> = {},
): string {
  const io = { ...TASK_FILE_IO, ...fsSeam };
  const taskPath = safeTaskPath(pathValue, projectRoot, io);
  const bytes = readStableTask(pathValue, taskPath, io);
  let task: string;
  try {
    task = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("--task-file must contain valid UTF-8 text");
  }
  if (!task) throw new Error("--task-file must not be empty");
  return task;
}

function protectedTaskSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(?:key|pem|p12|pfx)$/.test(name) ||
    [
      "auth.json",
      ".git-credentials",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "id_rsa",
      "id_rsa.pub",
      "id_ed25519",
      "id_ed25519.pub",
    ].includes(name) ||
    [".git", ".ssh", ".aws", ".azure", ".docker", ".gnupg", ".kube"].includes(name)
  );
}

function resolveTask(options: AutonomousCommandOptions, projectRoot: string): string {
  if (options.task && options["task-file"]) {
    throw new Error("use exactly one of --task or --task-file");
  }
  const task =
    options.task ?? (options["task-file"] ? safeTaskFile(options["task-file"], projectRoot) : "");
  if (!task.trim()) throw new Error("run requires --task <text> or --task-file <path>");
  if (Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new Error(`task exceeds ${MAX_TASK_BYTES} bytes`);
  }
  return task.trim();
}

function readRunRequest(workspaceRoot: string): {
  state: Record<string, unknown> & { run_id: string; workspace?: Record<string, unknown> };
  request: RunRequest;
} {
  const state = readJsonStrict(resolve(workspaceRoot, ".pipeline", "pipeline-state.json"));
  if (typeof state.run_id !== "string") throw new Error("pipeline state is missing run_id");
  const requestPath = resolve(getRunDir(state.run_id, workspaceRoot), "request.json");
  const request = readJsonStrict(requestPath) as RunRequest;
  if (typeof request.task !== "string") throw new Error("stored run request is missing task");
  return {
    state: state as Record<string, unknown> & {
      run_id: string;
      workspace?: Record<string, unknown>;
    },
    request,
  };
}

export function savedAgentOptions(request: Partial<RunRequest>): AutonomousCommandOptions {
  const saved = request.agent ?? {};
  const storedProvider = saved.provider ?? request.provider ?? "auto";
  return {
    provider: storedProvider === "command" ? "auto" : storedProvider,
    agentArgs: [],
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.reasoning_effort ? { "reasoning-effort": saved.reasoning_effort } : {}),
    ...(saved.variant ? { variant: saved.variant } : {}),
    ...(request.execution_profile ? { "execution-profile-snapshot": true } : {}),
    ...(saved.timeout_seconds ? { "timeout-seconds": String(saved.timeout_seconds) } : {}),
    "checkpoint-policy": request.checkpoint_policy ?? "none",
    "graph-memory": request.graph_memory ?? "off",
    "context-mode": request.context_policy?.mode ?? "legacy",
    ...(request.workflow?.mode === "legacy-linear" ? { "legacy-linear": true } : {}),
    ...(request.workflow?.max_concurrency
      ? { "max-concurrency": String(request.workflow.max_concurrency) }
      : {}),
    ...(request.workflow?.max_repair_rounds
      ? { "max-repair-rounds": String(request.workflow.max_repair_rounds) }
      : {}),
  };
}

export function mergeResumeOptions(
  saved: AutonomousCommandOptions,
  supplied: AutonomousCommandOptions,
): AutonomousCommandOptions {
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

export function assertResumeCheckpointPolicy(
  saved: AutonomousCommandOptions,
  supplied: AutonomousCommandOptions,
): void {
  if (supplied["checkpoint-policy"] && supplied["checkpoint-policy"] !== saved["checkpoint-policy"])
    throw new Error("checkpoint policy is immutable for an existing autonomous run");
  if (supplied["graph-memory"] && supplied["graph-memory"] !== saved["graph-memory"])
    throw new Error("graph memory mode is immutable for an existing autonomous run");
  if (supplied["context-mode"] && supplied["context-mode"] !== saved["context-mode"])
    throw new Error("context mode is immutable for an existing autonomous run");
}

function resetProviderOptions(saved: AutonomousCommandOptions): AutonomousCommandOptions {
  return {
    ...saved,
    "agent-command": undefined,
    agentArgs: [],
    "allow-unsafe-command-provider": false,
  };
}

/**
 * Acquires an exclusive workflow lock and rejects concurrent runs that target the same workspace.
 */
export function acquireWorkflowLock(workspaceRoot: string, runId: string): () => void {
  const lockPath = resolve(getRunDir(runId, workspaceRoot), "autonomous.lock");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
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
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
}

export function initializeOrResume(
  command: string,
  options: AutonomousCommandOptions,
): AutonomousLifecycleContext {
  const projectRoot = requireDirectory(options["project-root"] ?? process.cwd(), "project root");
  assertGitRepository(projectRoot);
  if (command === "resume") {
    try {
      reconcileRuntimeStateGuard(projectRoot, { recovery: true });
    } catch (error) {
      const failure: Error & { pipelineStateUnsafe?: boolean } =
        error instanceof Error
          ? (error as Error & { pipelineStateUnsafe?: boolean })
          : new Error(String(error));
      failure.pipelineStateUnsafe = true;
      throw failure;
    }
    return resumeContext(projectRoot, options);
  }
  return newRunContext(projectRoot, options);
}

function resumeContext(
  projectRoot: string,
  options: AutonomousCommandOptions,
): AutonomousLifecycleContext {
  if (!options["run-id"]) throw new Error("resume requires --run-id <id>");
  const { state, request } = readRunRequest(projectRoot);
  if (state.run_id !== options["run-id"]) {
    throw new Error(`run-id mismatch: workspace has ${state.run_id}`);
  }
  const initialGitStatePath = resolve(
    getRunDir(state.run_id, projectRoot),
    "initial-git-state.json",
  );
  if (!existsSync(initialGitStatePath)) {
    throw new Error(
      `resume requires the initial Git-state snapshot at ${initialGitStatePath}; start a new run instead`,
    );
  }
  const restored = restoreRunConfiguration(request, options);
  const runDir = getRunDir(state.run_id, projectRoot);
  return {
    runId: state.run_id,
    workspaceRoot: projectRoot,
    projectRoot:
      typeof state.workspace?.primary_repo_root === "string"
        ? state.workspace.primary_repo_root
        : projectRoot,
    task: request.task,
    initialGitState: readJsonStrict(initialGitStatePath) as unknown as GitStateSnapshot,
    resumed: true,
    savedAgentOptions: savedAgentOptions(request),
    ...restored,
    runDir,
  };
}

function restoreRunConfiguration(
  request: RunRequest,
  options: AutonomousCommandOptions,
): Pick<
  AutonomousLifecycleContext,
  | "policy"
  | "policyDigest"
  | "workflow"
  | "workflowDigest"
  | "workflowMode"
  | "executionProfile"
  | "executionProfileDigest"
  | "executionRuntime"
  | "contextMode"
  | "contextPolicy"
  | "contextPolicyDigest"
> {
  assertStoredAgentRuntime(request);
  const policy = storedRunPolicy(request, options);
  const workflow = storedRunWorkflow(request, options);
  const contextPolicy = storedRunContextPolicy(request, options, workflow?.workflow ?? null);
  const executionProfile = storedRunExecutionProfile(request, options);
  if (workflow && executionProfile) {
    assertExecutionProfileCoverage(executionProfile.profile, workflow.workflow);
  }
  const workflowConfiguration = workflowConfigurationFields(workflow);
  return {
    policy,
    policyDigest: policyDigest(policy),
    ...workflowConfiguration,
    executionProfile: executionProfile?.profile ?? null,
    executionProfileDigest: executionProfile?.digest ?? null,
    executionRuntime: request.execution_profile?.runtime ?? null,
    contextMode: contextPolicy.mode,
    contextPolicy: contextPolicy.policy,
    contextPolicyDigest: contextPolicy.digest,
  };
}

function storedRunContextPolicy(
  request: RunRequest,
  options: AutonomousCommandOptions,
  workflow: WorkflowContract | null,
): ContextPolicyResolution {
  const stored = request.context_policy;
  if (
    stored &&
    (typeof stored.mode !== "string" || typeof stored.digest !== "string" || !stored.snapshot)
  ) {
    throw new Error("stored context policy metadata is incomplete");
  }
  const mode = stored?.mode ?? "legacy";
  if (options["context-mode"] && options["context-mode"] !== mode) {
    throw new Error("context mode is immutable for an existing autonomous run");
  }
  if (workflow?.schema_version === "2.2.0") {
    if (options["context-mode"] === "bounded") {
      throw new Error("--context-mode bounded is available only for workflow 2.0 and 2.1");
    }
    return { mode: "legacy", policy: null, digest: null };
  }
  const policy = stored?.snapshot
    ? validateContextPolicy(stored.snapshot)
    : contextPolicySnapshot("legacy");
  const digest = contextPolicyDigest(policy);
  if (stored?.mode && stored.mode !== policy.mode) {
    throw new Error("stored context mode does not match its policy snapshot");
  }
  if (stored?.digest && stored.digest !== digest) {
    throw new Error("stored context policy digest does not match its snapshot");
  }
  return { mode: policy.mode, policy, digest };
}

function assertStoredAgentRuntime(request: RunRequest): void {
  if ((request.agent?.provider ?? request.provider) !== "opencode") return;
  const stored = request.agent?.runtime;
  if (!stored?.version || !stored?.binary_digest) {
    throw new Error("resume requires the stored OpenCode version and executable digest");
  }
  if (JSON.stringify(runtimeIdentity("opencode")) !== JSON.stringify(stored)) {
    throw new Error(
      "resume OpenCode provider version drifted; start a recovery run with the original runtime",
    );
  }
}

function workflowConfigurationFields(resolvedWorkflow: ResolvedWorkflow | null): {
  workflow: WorkflowContract | null;
  workflowDigest: string | null;
  workflowMode: string;
} {
  if (!resolvedWorkflow) {
    return { workflow: null, workflowDigest: null, workflowMode: "legacy-linear" };
  }
  return {
    workflow: resolvedWorkflow.workflow,
    workflowDigest: resolvedWorkflow.digest,
    workflowMode: "graph-native",
  };
}

function storedRunExecutionProfile(
  request: RunRequest,
  options: AutonomousCommandOptions,
): { profile: ExecutionProfile; digest: string } | null {
  if (!request.execution_profile) {
    if (options["execution-profile"])
      throw new Error("cannot add an execution profile when resuming an existing run");
    return null;
  }
  const profile = validateExecutionProfile(request.execution_profile.snapshot);
  const digest = executionProfileDigest(profile);
  if (digest !== request.execution_profile.digest)
    throw new Error("stored execution profile digest does not match its snapshot");
  if (options.model || options["reasoning-effort"])
    throw new Error("model settings are immutable when resuming an execution-profile run");
  if (
    options["execution-profile"] &&
    loadExecutionProfile(options["execution-profile"]).digest !== digest
  ) {
    throw new Error("resume execution profile digest does not match the stored snapshot");
  }
  assertExecutionRuntimeSnapshot(profile, request.execution_profile.runtime);
  return { profile, digest };
}

function runtimeIdentity(executor: AgentProvider): RuntimeIdentity {
  const identity = providerRuntimeIdentity(executor);
  return {
    executor,
    version: identity.version,
    binary_digest: identity.binary_digest ?? null,
  };
}

function executionRuntimeSnapshot(
  profile: ExecutionProfile | null | undefined,
  workflow: WorkflowContract | null | undefined,
): StoredRuntimeSnapshot | null {
  if (profile?.schema_version !== "3.0.0" || !workflow) return null;
  const identities = new Map(
    executionProfileExecutors(profile).map((executor) => [executor, runtimeIdentity(executor)]),
  );
  return {
    routes: resolveWorkflowRoutes(profile, workflow).map((route) => ({
      ...route,
      executor_version: identities.get(route.executor)?.version ?? null,
      executor_binary_digest: identities.get(route.executor)?.binary_digest ?? null,
    })),
  };
}

function assertExecutionRuntimeSnapshot(
  profile: ExecutionProfile,
  stored: StoredRuntimeSnapshot | null | undefined,
): void {
  if (profile.schema_version !== "3.0.0") return;
  if (!stored?.routes) {
    throw new Error("resume requires the stored execution route and provider-version snapshot");
  }
  const workflow = {
    nodes: stored.routes.map((route) => ({ id: route.node_id, kind: "agent", tier: route.tier })),
  } as unknown as WorkflowContract;
  const current = executionRuntimeSnapshot(profile, workflow);
  if (JSON.stringify(current) !== JSON.stringify(stored)) {
    throw new Error(
      "resume execution route, model, variant, or provider version drifted; start a recovery run with the original runtime",
    );
  }
}

function storedRunWorkflow(
  request: RunRequest,
  options: AutonomousCommandOptions,
): ResolvedWorkflow | null {
  if (!request.workflow || request.workflow.mode === "legacy-linear") return null;
  const workflow = validateWorkflow(request.workflow.snapshot);
  const digest = workflowDigest(workflow);
  if (digest !== request.workflow.digest)
    throw new Error("stored workflow digest does not match its snapshot");
  if (options.workflow && loadWorkflow(options.workflow).digest !== digest) {
    throw new Error("resume workflow digest does not match the stored workflow snapshot");
  }
  return { workflow, digest };
}

function storedRunPolicy(request: RunRequest, options: AutonomousCommandOptions): AutonomousPolicy {
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

function newRunContext(
  projectRoot: string,
  options: AutonomousCommandOptions,
): AutonomousLifecycleContext {
  const task = resolveTask(options, projectRoot);
  // Fail before branch/worktree creation when the policy is malformed or points
  // at protected credential material.
  const resolvedPolicy = loadAutonomousPolicy(options.policy);
  const resolvedWorkflow = resolveNewWorkflow(projectRoot, options);
  const resolvedContextPolicy = resolveNewContextPolicy(
    options,
    resolvedWorkflow?.workflow ?? null,
  );
  const resolvedExecutionProfile = options["execution-profile"]
    ? loadExecutionProfile(options["execution-profile"])
    : null;
  if (resolvedWorkflow && resolvedExecutionProfile) {
    assertExecutionProfileCoverage(resolvedExecutionProfile.profile, resolvedWorkflow.workflow);
  }
  if (
    options["in-place"] === true &&
    executionProfileExecutors(resolvedExecutionProfile?.profile).includes("opencode")
  ) {
    throw new Error("OpenCode routes require an isolated RAE worktree and reject --in-place");
  }
  const resolvedExecutionRuntime = executionRuntimeSnapshot(
    resolvedExecutionProfile?.profile,
    resolvedWorkflow?.workflow,
  );
  const directExecutionRuntime =
    options.provider === "opencode" ? runtimeIdentity("opencode") : null;
  const initialized = initializeRun(projectRoot, options["in-place"] === true);
  const runDir = resolve(initialized.workspaceRoot, ".pipeline", "runs", initialized.runId);
  const resolvedRun = {
    task,
    projectRoot,
    initialized,
    options,
    resolvedPolicy,
    resolvedWorkflow,
    resolvedExecutionProfile,
    resolvedExecutionRuntime,
    directExecutionRuntime,
    resolvedContextPolicy,
  };
  writeJson(resolve(runDir, "request.json"), newRunRequest(resolvedRun));
  if (resolvedWorkflow) writeWorkflowSnapshot(runDir, resolvedWorkflow);
  const gitStatePath = resolve(runDir, "initial-git-state.json");
  writeJson(gitStatePath, gitStateSnapshot(initialized.workspaceRoot));
  const workflowConfiguration = workflowConfigurationFields(resolvedWorkflow);
  return {
    ...initialized,
    projectRoot,
    task,
    initialGitState: readJsonStrict(gitStatePath) as unknown as GitStateSnapshot,
    resumed: false,
    policy: resolvedPolicy.policy,
    policyDigest: resolvedPolicy.digest,
    ...workflowConfiguration,
    executionProfile: resolvedExecutionProfile?.profile ?? null,
    executionProfileDigest: resolvedExecutionProfile?.digest ?? null,
    executionRuntime: resolvedExecutionRuntime,
    contextMode: resolvedContextPolicy.mode,
    contextPolicy: resolvedContextPolicy.policy,
    contextPolicyDigest: resolvedContextPolicy.digest,
    runDir,
  };
}

function resolveNewContextPolicy(
  options: AutonomousCommandOptions,
  workflow: WorkflowContract | null,
): ContextPolicyResolution {
  const mode = options["context-mode"] ?? "legacy";
  const boundedSupported = Boolean(
    workflow && ["2.0.0", "2.1.0"].includes(workflow.schema_version),
  );
  if (mode === "bounded" && !boundedSupported) {
    throw new Error("--context-mode bounded is available only for workflow 2.0 and 2.1");
  }
  if (!workflow || workflow.schema_version === "2.2.0") {
    return { mode: "legacy", policy: null, digest: null };
  }
  const policy = contextPolicySnapshot(mode);
  return { mode, policy, digest: contextPolicyDigest(policy) };
}

function writeWorkflowSnapshot(runDir: string, resolvedWorkflow: LoadedWorkflow): void {
  const directory = resolve(runDir, "workflow");
  mkdirSync(resolve(directory, "payload-contracts"), { recursive: true, mode: 0o700 });
  mkdirSync(resolve(directory, "agent-outputs"), { recursive: true, mode: 0o700 });
  writeJson(resolve(directory, "snapshot.json"), {
    schema_version: resolvedWorkflow.workflow.schema_version,
    digest: resolvedWorkflow.digest,
    workflow: resolvedWorkflow.workflow,
  });
  writeJson(
    resolve(directory, "node-guidance.json"),
    Object.fromEntries(resolvedWorkflow.workflow.nodes.map((node) => [node.id, node.guidance])),
  );
  writeJson(
    resolve(directory, "payload-contracts.json"),
    resolvedWorkflow.workflow.payload_contracts ?? {},
  );
}

function resolveNewWorkflow(
  projectRoot: string,
  options: AutonomousCommandOptions,
): LoadedWorkflow | null {
  if (options["legacy-linear"] === true || (options.provider === "command" && !options.workflow))
    return null;
  if (options.workflow)
    return { ...loadWorkflow(options.workflow), source: resolve(options.workflow) };
  const active = resolveActivatedWorkflow(projectRoot);
  if (active) return active;
  return { ...loadWorkflow(DEFAULT_WORKFLOW_PATH), source: DEFAULT_WORKFLOW_PATH };
}

function newRunRequest(context: NewRunData): RunRequest {
  const {
    task,
    projectRoot,
    initialized,
    options,
    resolvedPolicy,
    resolvedWorkflow,
    resolvedExecutionProfile,
    resolvedExecutionRuntime,
    directExecutionRuntime,
    resolvedContextPolicy,
  } = context;
  return {
    schema_version: resolvedWorkflow?.workflow.schema_version ?? "1.0.0",
    task,
    provider: options.provider ?? "auto",
    agent: requestedAgent(options, directExecutionRuntime),
    requested_at: new Date().toISOString(),
    primary_project_root: projectRoot,
    workspace_root: initialized.workspaceRoot,
    workspace_mode: options["in-place"] ? "main-repo" : "git-worktree",
    mutation_policy: "workspace-only-no-commit-no-push",
    checkpoint_policy: checkpointPolicy(options["checkpoint-policy"]),
    graph_memory: options["graph-memory"] ?? "off",
    ...requestedContextPolicy(resolvedContextPolicy),
    policy: requestedPolicy(resolvedPolicy),
    execution_profile: requestedExecutionProfile(
      resolvedExecutionProfile,
      resolvedExecutionRuntime,
    ),
    workflow: requestedWorkflow(resolvedWorkflow, options),
  };
}

function requestedContextPolicy(resolved: ContextPolicyResolution): {
  context_policy?: { mode: ContextMode; digest: string; snapshot: ContextPolicy };
} {
  if (!resolved.policy) return {};
  return {
    context_policy: {
      mode: resolved.mode,
      digest: resolved.digest ?? contextPolicyDigest(resolved.policy),
      snapshot: resolved.policy,
    },
  };
}

function requestedExecutionProfile(
  resolvedExecutionProfile: LoadedProfile | null,
  runtime: StoredRuntimeSnapshot | null,
): StoredExecutionProfile | null {
  if (!resolvedExecutionProfile) return null;
  return {
    profile_id: resolvedExecutionProfile.profile.profile_id,
    digest: resolvedExecutionProfile.digest,
    source: resolvedExecutionProfile.source,
    snapshot: resolvedExecutionProfile.profile,
    runtime,
  };
}

function requestedWorkflow(
  resolvedWorkflow: LoadedWorkflow | null,
  options: AutonomousCommandOptions,
): Record<string, unknown> {
  if (!resolvedWorkflow) return { mode: "legacy-linear" };
  const { workflow, digest, source } = resolvedWorkflow;
  return {
    mode: "graph-native",
    workflow_id: workflow.workflow_id,
    revision: workflow.revision,
    digest,
    source,
    ...requestedWorkflowBounds(workflow, options),
    snapshot: workflow,
  };
}

function requestedWorkflowBounds(
  workflow: WorkflowContract,
  options: AutonomousCommandOptions,
): { max_concurrency: number; max_repair_rounds: number } {
  const requestedBound = (
    name: "max-concurrency" | "max-repair-rounds",
    fallback: number,
  ): number => Number(options[name] ?? fallback);
  return {
    max_concurrency: requestedBound("max-concurrency", workflow.budgets?.max_concurrency ?? 4),
    max_repair_rounds: requestedBound(
      "max-repair-rounds",
      (workflow.budgets && "max_repair_rounds" in workflow.budgets
        ? workflow.budgets.max_repair_rounds
        : undefined) ?? 5,
    ),
  };
}

function requestedAgent(
  options: AutonomousCommandOptions,
  runtime: RuntimeIdentity | null = null,
): StoredAgentRequest {
  return {
    provider: options.provider ?? "auto",
    ...agentCommand(options),
    command_args: options.agentArgs,
    ...agentTuning(options),
    variant: options.variant ?? null,
    runtime,
    allow_unsafe_command_provider: options["allow-unsafe-command-provider"] === true,
  };
}

function agentCommand(options: AutonomousCommandOptions): { command: string | null } {
  return { command: options["agent-command"] ?? null };
}
function agentTuning(options: AutonomousCommandOptions): {
  model: string | null;
  reasoning_effort: string | null;
  timeout_seconds: number;
} {
  return {
    model: options.model ?? null,
    reasoning_effort: options["reasoning-effort"] ?? null,
    timeout_seconds: Number(options["timeout-seconds"] ?? DEFAULT_TIMEOUT_SECONDS),
  };
}

function requestedPolicy(resolvedPolicy: ResolvedPolicy): Record<string, unknown> {
  return {
    policy_id: resolvedPolicy.policy.policy_id,
    digest: resolvedPolicy.digest,
    source: resolvedPolicy.source,
    snapshot: resolvedPolicy.policy,
  };
}
