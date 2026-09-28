/** Reduces durable v2.2 wait signals with deterministic, idempotent consumption. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const STATE_NAME = "wait-state.json";

function clone(value) {
  return structuredClone(value);
}

function statePath(runDir) {
  return resolve(runDir, "workflow", STATE_NAME);
}

function assertState(state) {
  if (!state || state.schema_version !== "2.2.0" || !Array.isArray(state.signals)) {
    throw new Error("invalid workflow v2.2 wait state");
  }
}

export function initialWorkflowV22State({ runId, workflowDigest }) {
  return {
    schema_version: "2.2.0",
    run_id: runId,
    workflow_digest: workflowDigest,
    waits: {},
    signals: [],
    consumed_signal_ids: [],
    idempotency_keys: [],
  };
}

function sameIdempotency(state, event) {
  return state.idempotency_keys.some(
    (entry) => entry.key === event.idempotency_key && entry.node_id === event.node_id,
  );
}

/** Pure reducer. Replaying an event with the same node/idempotency key is a no-op. */
export function reduceWorkflowV22(state, event) {
  assertState(state);
  const next = clone(state);
  if (event.type === "signal-recorded") {
    if (sameIdempotency(next, event)) return next;
    next.signals.push({
      signal_id: event.signal_id,
      node_id: event.node_id,
      signal: event.signal,
      payload: event.payload ?? null,
      occurred_at: event.occurred_at,
      idempotency_key: event.idempotency_key,
    });
    next.idempotency_keys.push({ key: event.idempotency_key, node_id: event.node_id });
    return next;
  }
  if (event.type === "wait-open") {
    const prior = next.waits[event.node_id];
    if (!prior) {
      next.waits[event.node_id] = {
        deadline_at: event.deadline_at,
        accepted_signals: [...event.accepted_signals].sort(),
        status: "waiting",
      };
    }
    return next;
  }
  if (event.type === "wait-consume") {
    if (!next.consumed_signal_ids.includes(event.signal_id))
      next.consumed_signal_ids.push(event.signal_id);
    if (next.waits[event.node_id]) {
      next.waits[event.node_id].status = "signalled";
      next.waits[event.node_id].last_consumed_signal_id = event.signal_id;
    }
    return next;
  }
  if (event.type === "wait-consume-earliest") {
    const wait = next.waits[event.node_id];
    if (!wait) throw new Error(`wait ${event.node_id} has not opened`);
    if (wait.last_consumed_signal_id) return next;
    const signal = earliestUnconsumedSignal(
      next,
      event.node_id,
      wait.accepted_signals,
      wait.deadline_at,
    );
    if (!signal) return next;
    next.consumed_signal_ids.push(signal.signal_id);
    wait.status = "signalled";
    wait.last_consumed_signal_id = signal.signal_id;
    return next;
  }
  if (event.type === "wait-timeout") {
    if (next.waits[event.node_id]) next.waits[event.node_id].status = "timed-out";
    return next;
  }
  throw new Error(`unknown workflow v2.2 reducer event ${event.type}`);
}

export function earliestUnconsumedSignal(state, nodeId, acceptedSignals, deadlineAt = null) {
  assertState(state);
  const accepted = new Set(acceptedSignals);
  return (
    state.signals
      .filter(
        (signal) =>
          signal.node_id === nodeId &&
          accepted.has(signal.signal) &&
          (!deadlineAt || signal.occurred_at <= deadlineAt) &&
          !state.consumed_signal_ids.includes(signal.signal_id),
      )
      .sort(
        (left, right) =>
          left.occurred_at.localeCompare(right.occurred_at) ||
          left.signal_id.localeCompare(right.signal_id),
      )[0] ?? null
  );
}

export function readWorkflowV22State({ runDir, runId, workflowDigest }) {
  const pathValue = statePath(runDir);
  try {
    const state = JSON.parse(readFileSync(pathValue, "utf8"));
    assertState(state);
    if (state.run_id !== runId || state.workflow_digest !== workflowDigest) {
      throw new Error("workflow v2.2 wait state does not match immutable run snapshot");
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return initialWorkflowV22State({ runId, workflowDigest });
    throw error;
  }
}

function writeState(runDir, state) {
  const directory = resolve(runDir, "workflow");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = statePath(runDir);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function withStateLock(runDir, action) {
  const lock = `${statePath(runDir)}.lock`;
  mkdirSync(resolve(runDir, "workflow"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        return action();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  }
  throw new Error("workflow v2.2 wait state is busy; retry the signal command");
}

export function applyWorkflowV22Event({ runDir, runId, workflowDigest, event }) {
  return withStateLock(runDir, () => {
    const state = readWorkflowV22State({ runDir, runId, workflowDigest });
    const next = reduceWorkflowV22(state, event);
    writeState(runDir, next);
    return next;
  });
}

export function recordWorkflowV22Signal({
  runDir,
  runId,
  workflowDigest,
  nodeId,
  signal,
  idempotencyKey,
  payload = null,
  now = new Date().toISOString(),
}) {
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new Error(
      "signal idempotency key must contain 1-128 letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  const signalId = `${nodeId}:${idempotencyKey}`;
  return applyWorkflowV22Event({
    runDir,
    runId,
    workflowDigest,
    event: {
      type: "signal-recorded",
      signal_id: signalId,
      node_id: nodeId,
      signal,
      payload,
      occurred_at: now,
      idempotency_key: idempotencyKey,
    },
  });
}
