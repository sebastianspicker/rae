/** Owns the one active local run and exposes only bounded operator mutations. */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  appendTraceEvent,
  autonomousEntrypoint,
  ensureRuntimeStateReadable,
  executionRuntimeCwd,
  minimalChildEnvironment,
  pipelineInitEntrypoint,
  readOperatorControl,
  requestStop,
  resolveCheckpointById,
  setRunStatus,
} from "@rae/engine";
import { discoverRuns, locateRun } from "./runs.js";
import type { InternalRun } from "./runs.js";
import type { LoadedExecutionProfile } from "./profiles.js";
import type { OperatorProject } from "./security.js";

type JsonRecord = Record<string, unknown>;
type HttpError = Error & { status: number };
interface ChildStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  resume(): unknown;
}
interface ChildProcessLike {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stderr?: ChildStream | null;
  stdout?: ChildStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => ChildProcessLike;
type DiscoverRunsFunction = (
  project: OperatorProject,
  options?: { view?: "summary" | "detail" },
) => InternalRun[];
type LocateRunFunction = (project: OperatorProject, runId: string) => InternalRun;
interface OwnedRun {
  child: ChildProcessLike;
  projectId: string;
  project: OperatorProject;
  runId: string | null;
  baselineIds: Set<string>;
  startedAt: number;
  stderr: string;
  processGroup: boolean;
  spawnFailed?: boolean;
  timers?: NodeJS.Timeout[];
  interruptRun?: InternalRun;
}

const executionRoot = executionRuntimeCwd() as string;
const AUTONOMOUS = autonomousEntrypoint() as string;
const PIPELINE_INIT = pipelineInitEntrypoint() as string;
const TASK_MAX_BYTES = 32 * 1024;
const CHECKPOINT_POLICIES = new Set(["none", "before-mutation", "before-mutation-and-ship"]);

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

function assertAllowedStartFields(body: JsonRecord): void {
  const allowed = new Set(["task", "checkpoint_policy", "execution_profile_id"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw httpError(400, `unsupported start field: ${key}`);
  }
}

function normalizedStartTask(task: unknown): string {
  if (typeof task !== "string" || task.trim().length === 0) {
    throw httpError(400, "task is required");
  }
  if (Buffer.byteLength(task, "utf8") > TASK_MAX_BYTES) {
    throw httpError(413, `task exceeds ${TASK_MAX_BYTES} bytes`);
  }
  return task.trim();
}

function startCheckpointPolicy(value: unknown): string {
  const policy = typeof value === "string" ? value : "before-mutation-and-ship";
  if (!CHECKPOINT_POLICIES.has(policy)) throw httpError(400, "invalid checkpoint policy");
  return policy;
}

export function validateStartInput(
  body: JsonRecord,
  executionProfile: LoadedExecutionProfile | null = null,
): { task: string; checkpointPolicy: string; executionProfile?: LoadedExecutionProfile } {
  assertAllowedStartFields(body);
  if (body.execution_profile_id !== undefined && !executionProfile?.source) {
    throw httpError(400, "execution_profile_id must name a preloaded execution profile");
  }
  return {
    task: normalizedStartTask(body.task),
    checkpointPolicy: startCheckpointPolicy(body.checkpoint_policy),
    ...(executionProfile ? { executionProfile } : {}),
  };
}

export function requireTypedConfirmation(body: JsonRecord, runId: string): void {
  if (body.confirm_run_id !== runId) {
    throw httpError(400, "typed run-id confirmation does not match");
  }
}

function validateResumeRequest(run: InternalRun): void {
  ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
  const request = JSON.parse(
    readFileSync(resolve(run.workspaceRoot, ".pipeline", "runs", run.id, "request.json"), "utf8"),
  ) as JsonRecord;
  const agent =
    request.agent && typeof request.agent === "object" ? (request.agent as JsonRecord) : {};
  ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
  if (
    request.provider === "command" ||
    agent.provider === "command" ||
    agent.command ||
    agent.allow_unsafe_command_provider === true
  ) {
    throw httpError(409, "command-provider runs cannot be resumed from the operator console");
  }
}

function computeCheckpoint(
  run: InternalRun,
  body: JsonRecord,
  outcomes: Record<string, "approved" | "rejected" | "escalated">,
): unknown {
  const decision = String(body.decision ?? "");
  const checkpointId = String(body.checkpoint_id ?? "");
  const wasPending = (run.checkpoints ?? []).some(
    (item) => item.checkpoint_id === body.checkpoint_id && item.status === "pending",
  );
  const checkpoint = resolveCheckpointById(
    run.id,
    checkpointId,
    {
      status: outcomes[decision],
      decisionId: typeof body.decision_id === "string" ? body.decision_id : randomUUID(),
      actor: "rae-loopback-operator",
      rationale: String(body.rationale ?? ""),
    },
    run.workspaceRoot,
  );
  const resolved = checkpoint as JsonRecord;
  if (wasPending) {
    appendTraceEvent(
      run.id,
      {
        event: "checkpoint_resolved",
        phase: resolved.phase,
        status: resolved.status === "approved" ? "ok" : "blocked",
      },
      run.workspaceRoot,
    );
    if (resolved.status !== "approved") {
      appendTraceEvent(
        run.id,
        { event: "run_blocked", phase: resolved.phase, status: "blocked" },
        run.workspaceRoot,
      );
    }
  }
  ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
  return checkpoint;
}

export class RunController {
  private readonly spawnFn: SpawnFunction;
  private readonly discoverRunsFn: DiscoverRunsFunction;
  private readonly locateRunFn: LocateRunFunction;
  private readonly usesNativeSpawn: boolean;
  private owned: OwnedRun | null;

  constructor({
    spawnFn = spawn as unknown as SpawnFunction,
    discoverRunsFn = discoverRuns,
    locateRunFn = locateRun,
  }: {
    spawnFn?: SpawnFunction;
    discoverRunsFn?: DiscoverRunsFunction;
    locateRunFn?: LocateRunFunction;
  } = {}) {
    this.spawnFn = spawnFn;
    this.discoverRunsFn = discoverRunsFn;
    this.locateRunFn = locateRunFn;
    this.usesNativeSpawn = spawnFn === spawn;
    this.owned = null;
  }

  get ownedRunId(): string | null {
    const owned = this.owned;
    return this.#ownedActive() && owned ? owned.runId : null;
  }

  #ownedActive(): boolean {
    return Boolean(
      this.owned &&
        !this.owned.spawnFailed &&
        this.owned.child &&
        this.owned.child.exitCode === null &&
        this.owned.child.signalCode === null,
    );
  }

  #assertIdle(): void {
    if (this.#ownedActive()) {
      throw httpError(409, "one server-owned run is already active");
    }
  }

  #spawn(
    project: OperatorProject,
    argv: string[],
    baselineIds: Set<string> = new Set(),
    knownRunId: string | null = null,
  ): OwnedRun {
    this.#assertIdle();
    const child = this.spawnFn(process.execPath, [AUTONOMOUS, ...argv], {
      cwd: executionRoot,
      env: minimalChildEnvironment(process.env, executionRoot) as unknown,
      detached: this.usesNativeSpawn && process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const owned: OwnedRun = {
      child,
      projectId: project.id,
      project,
      runId: knownRunId,
      baselineIds,
      startedAt: Date.now(),
      stderr: "",
      processGroup: this.usesNativeSpawn && process.platform !== "win32",
    };
    this.owned = owned;
    child.stderr?.on("data", (chunk) => {
      owned.stderr = `${owned.stderr}${Buffer.from(chunk).toString()}`.slice(-4096);
    });
    child.stdout?.resume();
    child.on("error", (error) => {
      owned.spawnFailed = true;
      owned.stderr = error.message;
    });
    child.on("exit", () => {
      for (const timer of owned.timers ?? []) clearTimeout(timer);
      owned.timers = [];
      if (owned.interruptRun) this.#finalizeInterrupt(owned);
    });
    return owned;
  }

  #finalizeInterrupt(owned: OwnedRun): void {
    const run = owned.interruptRun;
    if (!run) return;
    try {
      ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
    } catch (error) {
      owned.stderr = `${owned.stderr}\n${error instanceof Error ? error.message : String(error)}`
        .trim()
        .slice(-4096);
      return;
    }
    const lockPath = resolve(run.workspaceRoot, ".pipeline", "runs", run.id, "autonomous.lock");
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        if (lock.pid === owned.child.pid) unlinkSync(lockPath);
      } catch {
        // Never remove a lock whose ownership cannot be proven.
      }
    }
    const current = readOperatorControl(run.id, run.workspaceRoot);
    if (current.status !== "interrupted") {
      setRunStatus(run.id, "interrupted", run.workspaceRoot, {
        stop_requested: false,
        interrupted_at: new Date().toISOString(),
      });
      appendTraceEvent(
        run.id,
        {
          event: "run_interrupted",
          phase: run.current_phase ?? "arm",
          status: "interrupted",
        },
        run.workspaceRoot,
      );
    }
  }

  #signalOwned(signal: NodeJS.Signals): boolean {
    if (!this.owned) return false;
    if (this.owned.processGroup && Number.isInteger(this.owned.child.pid)) {
      try {
        process.kill(-(this.owned.child.pid ?? 0), signal);
        return true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    return this.owned.child.kill(signal);
  }

  refreshOwnership(): string | null {
    const owned = this.owned;
    if (!this.#ownedActive() || !owned || owned.runId) return this.ownedRunId;
    const candidates = this.discoverRunsFn(owned.project, { view: "summary" }).filter(
      (run) => !owned.baselineIds.has(run.id),
    );
    if (candidates.length === 1 && candidates[0]) owned.runId = candidates[0].id;
    return this.ownedRunId;
  }

  start(
    project: OperatorProject,
    body: JsonRecord,
    executionProfile: LoadedExecutionProfile | null = null,
  ): JsonRecord {
    const { task, checkpointPolicy } = validateStartInput(body, executionProfile);
    const baselineIds = new Set(
      this.discoverRunsFn(project, { view: "summary" }).map((run) => run.id),
    );
    this.#spawn(
      project,
      [
        "run",
        "--project-root",
        project.root,
        "--task",
        task,
        "--provider",
        "codex",
        "--checkpoint-policy",
        checkpointPolicy,
        ...(executionProfile ? ["--execution-profile", executionProfile.source] : []),
        "--json",
      ],
      baselineIds,
    );
    return { accepted: true, run_id: this.refreshOwnership() };
  }

  stop(project: OperatorProject, runId: string): unknown {
    const run = this.locateRunFn(project, runId);
    if (!["running", "waiting", "stop-requested"].includes(run.status ?? "")) {
      throw httpError(409, `cannot request stop for run status: ${run.status}`);
    }
    try {
      ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
      const previous = readOperatorControl(run.id, run.workspaceRoot);
      const control = requestStop(run.id, run.workspaceRoot);
      if (!["stop-requested", "stopped"].includes(String(previous.status ?? ""))) {
        appendTraceEvent(
          run.id,
          { event: "run_stop_requested", phase: run.current_phase ?? "arm", status: "ok" },
          run.workspaceRoot,
        );
      }
      ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
      return control;
    } catch (error) {
      if (error instanceof Error) (error as Error & { status?: number }).status = 409;
      throw error;
    }
  }

  resume(project: OperatorProject, runId: string): JsonRecord {
    const run = this.locateRunFn(project, runId);
    if (run.runtime_active) throw httpError(409, "run already has an active autonomous lock");
    if ((run.checkpoints ?? []).some((item) => item.status === "pending")) {
      throw httpError(409, "resolve the pending checkpoint before resume");
    }
    if (
      (run.checkpoints ?? []).some((item) => ["rejected", "escalated"].includes(item.status ?? ""))
    ) {
      throw httpError(409, "a rejected or escalated checkpoint cannot be resumed");
    }
    const partiallyCompleted =
      run.status === "completed" &&
      (run.phase_order ?? []).some(
        (phase) => !(run.completed_gates ?? []).includes(`${phase}-gate`),
      );
    if (
      !partiallyCompleted &&
      !["running", "waiting", "stopped", "blocked", "interrupted"].includes(run.status ?? "")
    ) {
      throw httpError(409, `cannot resume run status: ${run.status}`);
    }
    validateResumeRequest(run);
    this.#spawn(
      project,
      [
        "resume",
        "--project-root",
        run.workspaceRoot,
        "--run-id",
        run.id,
        "--provider",
        "codex",
        "--json",
      ],
      new Set(),
      run.id,
    );
    return { accepted: true, run_id: run.id };
  }

  interrupt(project: OperatorProject, runId: string, body: JsonRecord): JsonRecord {
    requireTypedConfirmation(body, runId);
    const run = this.locateRunFn(project, runId);
    this.refreshOwnership();
    if (
      !this.owned ||
      this.owned.projectId !== project.id ||
      this.owned.runId !== runId ||
      !this.#ownedActive()
    ) {
      throw httpError(409, "interrupt is allowed only for the active server-owned process");
    }
    this.owned.interruptRun = run;
    this.#signalOwned("SIGINT");
    const term = setTimeout(() => {
      if (this.#ownedActive()) this.#signalOwned("SIGTERM");
    }, 10_000);
    const hard = setTimeout(() => {
      if (this.#ownedActive()) this.#signalOwned("SIGKILL");
    }, 20_000);
    term.unref?.();
    hard.unref?.();
    this.owned.timers = [term, hard];
    return {
      accepted: true,
      run_id: runId,
      signal: "SIGINT",
      containment_uncertain: true,
    };
  }

  decideCheckpoint(project: OperatorProject, runId: string, body: JsonRecord): unknown {
    const run = this.locateRunFn(project, runId);
    ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
    const allowed = new Set(["checkpoint_id", "decision", "decision_id", "rationale"]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw httpError(400, `unsupported checkpoint field: ${key}`);
    }
    if (
      typeof body.decision !== "string" ||
      !new Set(["approve", "reject", "escalate"]).has(body.decision)
    ) {
      throw httpError(400, "decision must be approve, reject, or escalate");
    }
    if (
      typeof body.checkpoint_id !== "string" ||
      !/^checkpoint-[a-f0-9]{24}$/.test(body.checkpoint_id)
    ) {
      throw httpError(400, "invalid checkpoint_id");
    }
    if (!(run.checkpoints ?? []).some((item) => item.checkpoint_id === body.checkpoint_id)) {
      throw httpError(404, "checkpoint not found");
    }
    if (
      body.decision_id !== undefined &&
      (typeof body.decision_id !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.decision_id))
    ) {
      throw httpError(400, "decision_id must be an opaque identifier from 8 to 128 characters");
    }
    if (
      typeof body.rationale !== "string" ||
      body.rationale.trim().length === 0 ||
      body.rationale.length > 4096
    ) {
      throw httpError(400, "rationale is required and must be at most 4096 characters");
    }
    const outcomes = { approve: "approved", reject: "rejected", escalate: "escalated" } as const;
    try {
      return computeCheckpoint(run, body, outcomes);
    } catch (error) {
      if (
        error instanceof Error &&
        /conflicting terminal decision|being resolved/.test(error.message)
      )
        (error as Error & { status?: number }).status = 409;
      throw error;
    }
  }

  cleanup(project: OperatorProject, runId: string, body: JsonRecord): JsonRecord {
    requireTypedConfirmation(body, runId);
    const run = this.locateRunFn(project, runId);
    if (run.workspace_mode !== "git-worktree") {
      throw httpError(409, "only pipeline-owned worktree runs can be cleaned up");
    }
    if (!["stopped", "blocked", "interrupted", "completed"].includes(run.status ?? "")) {
      throw httpError(409, `cannot clean up run status: ${run.status}`);
    }
    if (this.owned?.runId === runId && this.#ownedActive()) {
      throw httpError(409, "cannot clean up an active server-owned run");
    }
    ensureRuntimeStateReadable(run.workspaceRoot, { expectedRunId: run.id });
    const child = this.spawnFn("bash", [PIPELINE_INIT, "--cleanup-worktree", run.workspaceRoot], {
      cwd: executionRoot,
      env: minimalChildEnvironment(process.env, executionRoot),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", () => {});
    return { accepted: true, run_id: runId, pid: child.pid ?? null };
  }
}
