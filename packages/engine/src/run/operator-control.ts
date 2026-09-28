/** Durable, run-scoped control and approval records for local operator surfaces. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { getRunDir, readJson, writeJson } from "./state.js";
import { badInput } from "../primitives/errors.js";
import type { ArtifactsOperatorCheckpoint, ArtifactsOperatorControl } from "@rae/contracts";

export type CheckpointPolicy = "none" | "before-mutation" | "before-mutation-and-ship";
export type CheckpointStatus = "pending" | "approved" | "rejected" | "escalated";
export type RunStatus = ArtifactsOperatorControl["status"];
export interface OperatorControl extends ArtifactsOperatorControl {
  waiting_node_id?: string | null;
  waiting_deadline_at?: string | null;
}
type CheckpointPurpose = ArtifactsOperatorCheckpoint["purpose"];
interface CheckpointRequest {
  phase: string;
  purpose: CheckpointPurpose;
  message: string;
}
interface CheckpointDecision {
  status: Exclude<CheckpointStatus, "pending">;
  decisionId: string;
  actor: string;
  rationale: string;
}

export const CHECKPOINT_POLICIES: ReadonlySet<string> = new Set([
  "none",
  "before-mutation",
  "before-mutation-and-ship",
]);
const CHECKPOINT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "approved",
  "rejected",
  "escalated",
]);
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "stop-requested",
  "stopped",
  "interrupted",
  "blocked",
  "completed",
]);

export function checkpointPolicy(value: unknown): CheckpointPolicy {
  const policy = value ?? "none";
  if (typeof policy !== "string" || !CHECKPOINT_POLICIES.has(policy)) {
    throw badInput(`checkpoint_policy must be one of: ${[...CHECKPOINT_POLICIES].join(", ")}`);
  }
  return policy as CheckpointPolicy;
}

export function getOperatorControlPath(runId: string, root: string): string {
  return resolve(getRunDir(runId, root), "operator-control.json");
}

export function getCheckpointDir(runId: string, root: string): string {
  return resolve(getRunDir(runId, root), "checkpoints");
}

function checkpointIdentity(
  runId: string,
  phase: string,
  purpose: string,
): {
  requestKey: string;
  checkpointId: string;
} {
  if (!/^[a-z][a-z0-9-]*$/.test(phase) || !/^[a-z][a-z0-9-]*$/.test(purpose)) {
    throw badInput("checkpoint phase and purpose must be lowercase identifiers");
  }
  const requestKey = createHash("sha256").update(`${runId}\0${phase}\0${purpose}`).digest("hex");
  return { requestKey, checkpointId: `checkpoint-${requestKey.slice(0, 24)}` };
}

export function getCheckpointPath(
  runId: string,
  phase: string,
  purpose: string,
  root: string,
): string {
  const { checkpointId } = checkpointIdentity(runId, phase, purpose);
  return resolve(getCheckpointDir(runId, root), `${checkpointId}.json`);
}

export function listCheckpoints(runId: string, root: string): ArtifactsOperatorCheckpoint[] {
  const directory = getCheckpointDir(runId, root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^checkpoint-[a-f0-9]{24}\.json$/.test(name))
    .sort()
    .map((name) => readJson(resolve(directory, name), null) as ArtifactsOperatorCheckpoint | null)
    .filter((entry): entry is ArtifactsOperatorCheckpoint => Boolean(entry));
}

export function readOperatorControl(runId: string, root: string): OperatorControl {
  return readJson(getOperatorControlPath(runId, root), {
    schema_version: "1.0.0",
    run_id: runId,
    status: "running",
    stop_requested: false,
    updated_at: null,
  }) as OperatorControl;
}

function withControlLock<T>(runId: string, root: string, callback: () => T): T {
  const controlPath = getOperatorControlPath(runId, root);
  const lockPath = `${controlPath}.lock`;
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
  let fd: number | null | undefined;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw badInput(`operator control is being updated for run: ${runId}`);
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

function writeRunStatus(
  runId: string,
  status: RunStatus,
  root: string,
  extras: Partial<OperatorControl>,
  current: OperatorControl,
): OperatorControl {
  if (!RUN_STATUSES.has(status)) throw badInput(`invalid operator run status: ${status}`);
  const preserveStop =
    current.stop_requested === true && ["running", "waiting", "completed"].includes(status);
  const next = {
    ...current,
    ...extras,
    schema_version: "1.0.0",
    run_id: runId,
    status: preserveStop ? "stop-requested" : status,
    ...(preserveStop ? { stop_requested: true } : {}),
    updated_at: new Date().toISOString(),
  };
  writeJson(getOperatorControlPath(runId, root), next);
  return next as OperatorControl;
}

export function setRunStatus(
  runId: string,
  status: RunStatus,
  root: string,
  extras: Partial<OperatorControl> = {},
): OperatorControl {
  return withControlLock(runId, root, () =>
    writeRunStatus(runId, status, root, extras, readOperatorControl(runId, root)),
  );
}

export function requestStop(runId: string, root: string): OperatorControl {
  return withControlLock(runId, root, () => {
    const current = readOperatorControl(runId, root);
    if (["stop-requested", "stopped"].includes(current.status)) return current;
    if (["completed", "blocked", "interrupted"].includes(current.status)) {
      throw badInput(`cannot request stop for terminal run status: ${current.status}`);
    }
    return writeRunStatus(
      runId,
      "stop-requested",
      root,
      {
        stop_requested: true,
        stop_requested_at: current.stop_requested_at ?? new Date().toISOString(),
      },
      current,
    );
  });
}

export function createCheckpoint(
  runId: string,
  { phase, purpose, message }: CheckpointRequest,
  root: string,
): ArtifactsOperatorCheckpoint {
  const path = getCheckpointPath(runId, phase, purpose, root);
  const identity = checkpointIdentity(runId, phase, purpose);
  const existing = readJson(path, null) as ArtifactsOperatorCheckpoint | null;
  if (existing) return existing;
  mkdirSync(getCheckpointDir(runId, root), { recursive: true, mode: 0o700 });
  const checkpoint = {
    schema_version: "1.0.0",
    checkpoint_id: identity.checkpointId,
    request_key: identity.requestKey,
    run_id: runId,
    phase,
    purpose,
    status: "pending",
    message,
    requested_by: "rae-autonomous-runtime",
    requested_at: new Date().toISOString(),
  };
  // Creation is exclusive: a concurrent caller obtains the already-created
  // record instead of inventing a competing checkpoint identity.
  let fd: number | null | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = null;
    return checkpoint as ArtifactsOperatorCheckpoint;
  } catch (error) {
    if (fd !== undefined && fd !== null) closeSync(fd);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const raced = readJson(path, null) as ArtifactsOperatorCheckpoint | null;
      if (raced) return raced;
    }
    throw error;
  }
}

export function resolveCheckpoint(
  runId: string,
  {
    phase,
    purpose,
    status,
    decisionId,
    actor,
    rationale,
  }: CheckpointDecision & {
    phase: string;
    purpose: CheckpointPurpose;
  },
  root: string,
): ArtifactsOperatorCheckpoint {
  if (!CHECKPOINT_STATUSES.has(status)) {
    throw badInput("checkpoint status must be approved, rejected, or escalated");
  }
  if (typeof decisionId !== "string" || decisionId.length === 0) {
    throw badInput("decision_id is required");
  }
  if (typeof actor !== "string" || actor.length === 0 || actor.length > 128) {
    throw badInput("checkpoint actor is required and must be at most 128 characters");
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0 || rationale.length > 4096) {
    throw badInput("checkpoint rationale is required and must be at most 4096 characters");
  }
  const path = getCheckpointPath(runId, phase, purpose, root);
  const lockPath = `${path}.lock`;
  const identity = checkpointIdentity(runId, phase, purpose);
  return withControlLock(runId, root, () => {
    let fd: number | null | undefined;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw badInput(`checkpoint is being resolved: ${identity.checkpointId}`);
      }
      throw error;
    }
    try {
      const checkpoint = readJson(path, null) as ArtifactsOperatorCheckpoint | null;
      if (!checkpoint) throw badInput(`checkpoint not found: ${identity.checkpointId}`);
      let resolved: ArtifactsOperatorCheckpoint = checkpoint;
      if (checkpoint.status !== "pending") {
        if (
          checkpoint.decision?.decision_id !== decisionId ||
          checkpoint.decision?.outcome !== status ||
          checkpoint.decision?.actor !== actor ||
          checkpoint.decision?.rationale !== rationale.trim()
        ) {
          throw badInput(
            `checkpoint ${checkpoint.checkpoint_id} already has a conflicting terminal decision`,
          );
        }
      } else {
        const resolvedAt = new Date().toISOString();
        resolved = {
          ...(checkpoint as unknown as Record<string, unknown>),
          status,
          decision: {
            decision_id: decisionId,
            outcome: status,
            actor,
            at: resolvedAt,
            rationale: rationale.trim(),
          },
          resolved_at: resolvedAt,
        } as ArtifactsOperatorCheckpoint;
        writeJson(path, resolved);
      }
      writeRunStatus(
        runId,
        status === "approved" ? "running" : "blocked",
        root,
        { waiting_checkpoint_id: null, stop_requested: false },
        readOperatorControl(runId, root),
      );
      return resolved;
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  });
}

export function resolveCheckpointById(
  runId: string,
  checkpointIdValue: string,
  decision: CheckpointDecision,
  root: string,
): ArtifactsOperatorCheckpoint {
  if (!/^checkpoint-[a-f0-9]{24}$/.test(checkpointIdValue ?? "")) {
    throw badInput("invalid checkpoint_id");
  }
  const checkpoint = listCheckpoints(runId, root).find(
    (entry) => entry.checkpoint_id === checkpointIdValue,
  );
  if (!checkpoint) throw badInput(`checkpoint not found: ${checkpointIdValue}`);
  return resolveCheckpoint(
    runId,
    { phase: checkpoint.phase, purpose: checkpoint.purpose, ...decision },
    root,
  );
}
