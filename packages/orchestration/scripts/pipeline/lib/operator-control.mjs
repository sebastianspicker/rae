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
import { getRunDir, readJson, writeJson } from "./state.mjs";
import { badInput } from "./errors.mjs";

export const CHECKPOINT_POLICIES = new Set(["none", "before-mutation", "before-mutation-and-ship"]);
const CHECKPOINT_STATUSES = new Set(["pending", "approved", "rejected", "escalated"]);
const RUN_STATUSES = new Set([
  "running",
  "waiting",
  "stop-requested",
  "stopped",
  "interrupted",
  "blocked",
  "completed",
]);

export function checkpointPolicy(value) {
  const policy = value ?? "none";
  if (!CHECKPOINT_POLICIES.has(policy)) {
    throw badInput(`checkpoint_policy must be one of: ${[...CHECKPOINT_POLICIES].join(", ")}`);
  }
  return policy;
}

export function getOperatorControlPath(runId, root) {
  return resolve(getRunDir(runId, root), "operator-control.json");
}

export function getCheckpointDir(runId, root) {
  return resolve(getRunDir(runId, root), "checkpoints");
}

function checkpointIdentity(runId, phase, purpose) {
  if (!/^[a-z][a-z0-9-]*$/.test(phase) || !/^[a-z][a-z0-9-]*$/.test(purpose)) {
    throw badInput("checkpoint phase and purpose must be lowercase identifiers");
  }
  const requestKey = createHash("sha256").update(`${runId}\0${phase}\0${purpose}`).digest("hex");
  return { requestKey, checkpointId: `checkpoint-${requestKey.slice(0, 24)}` };
}

export function getCheckpointPath(runId, phase, purpose, root) {
  const { checkpointId } = checkpointIdentity(runId, phase, purpose);
  return resolve(getCheckpointDir(runId, root), `${checkpointId}.json`);
}

export function listCheckpoints(runId, root) {
  const directory = getCheckpointDir(runId, root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^checkpoint-[a-f0-9]{24}\.json$/.test(name))
    .sort()
    .map((name) => readJson(resolve(directory, name), null))
    .filter(Boolean);
}

export function readOperatorControl(runId, root) {
  return readJson(getOperatorControlPath(runId, root), {
    schema_version: "1.0.0",
    run_id: runId,
    status: "running",
    stop_requested: false,
    updated_at: null,
  });
}

function withControlLock(runId, root, callback) {
  const controlPath = getOperatorControlPath(runId, root);
  const lockPath = `${controlPath}.lock`;
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
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

function writeRunStatus(runId, status, root, extras, current) {
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
  return next;
}

export function setRunStatus(runId, status, root, extras = {}) {
  return withControlLock(runId, root, () =>
    writeRunStatus(runId, status, root, extras, readOperatorControl(runId, root)),
  );
}

export function requestStop(runId, root) {
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

export function createCheckpoint(runId, { phase, purpose, message }, root) {
  const path = getCheckpointPath(runId, phase, purpose, root);
  const identity = checkpointIdentity(runId, phase, purpose);
  const existing = readJson(path, null);
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
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = null;
    return checkpoint;
  } catch (error) {
    if (fd !== undefined && fd !== null) closeSync(fd);
    if (error.code === "EEXIST") return readJson(path, null);
    throw error;
  }
}

export function resolveCheckpoint(
  runId,
  { phase, purpose, status, decisionId, actor, rationale },
  root,
) {
  validateCheckpointDecision({ status, decisionId, actor, rationale });
  const path = getCheckpointPath(runId, phase, purpose, root);
  const lockPath = `${path}.lock`;
  const identity = checkpointIdentity(runId, phase, purpose);
  return withControlLock(runId, root, () => {
    let fd;
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw badInput(`checkpoint is being resolved: ${identity.checkpointId}`);
      }
      throw error;
    }
    try {
      const checkpoint = readJson(path, null);
      if (!checkpoint) throw badInput(`checkpoint not found: ${identity.checkpointId}`);
      let resolved = checkpoint;
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
          ...checkpoint,
          status,
          decision: {
            decision_id: decisionId,
            outcome: status,
            actor,
            at: resolvedAt,
            rationale: rationale.trim(),
          },
          resolved_at: resolvedAt,
        };
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

function validateCheckpointDecision({ status, decisionId, actor, rationale }) {
  assertCheckpointStatus(status);
  assertDecisionId(decisionId);
  assertDecisionActor(actor);
  assertDecisionRationale(rationale);
}

function assertCheckpointStatus(status) {
  if (!CHECKPOINT_STATUSES.has(status) || status === "pending")
    throw badInput("checkpoint status must be approved, rejected, or escalated");
}
function assertDecisionId(value) {
  if (typeof value !== "string" || value.length === 0) throw badInput("decision_id is required");
}
function assertDecisionActor(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw badInput("checkpoint actor is required and must be at most 128 characters");
}
function assertDecisionRationale(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096)
    throw badInput("checkpoint rationale is required and must be at most 4096 characters");
}

export function resolveCheckpointById(runId, checkpointIdValue, decision, root) {
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
