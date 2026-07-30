/** Stores append-only workflow revisions and activation decisions beside Git metadata. */
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { loadWorkflow, validateWorkflow, workflowDigest } from "./workflow-contract.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
export const DEFAULT_WORKFLOW_PATH = resolve(
  PACKAGE_ROOT,
  "workflows/graph-native-default.workflow.json",
);
const SAFE_ID = /^[a-z][a-z0-9-]{2,63}$/;
const MAX_REGISTRY_FILE_BYTES = 512 * 1024;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function gitCommonDirectory(projectRoot) {
  const result = spawnSync(
    "git",
    ["-C", realpathSync(projectRoot), "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) throw new Error(`cannot resolve Git common directory: ${result.stderr}`);
  return realpathSync(result.stdout.trim());
}

function registeredWorktrees(projectRoot) {
  const result = spawnSync(
    "git",
    ["-C", realpathSync(projectRoot), "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) return [realpathSync(projectRoot)];
  return result.stdout
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length));
}

function assertNoActiveRun(projectRoot) {
  for (const worktree of registeredWorktrees(projectRoot)) {
    const statePath = resolve(worktree, ".pipeline", "pipeline-state.json");
    if (!existsSync(statePath)) continue;
    let runId;
    try {
      runId = JSON.parse(readFileSync(statePath, "utf8")).run_id;
    } catch {
      throw httpError("workflow revisions are immutable while run state is unreadable", 409);
    }
    if (
      typeof runId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) &&
      existsSync(resolve(worktree, ".pipeline", "runs", runId, "autonomous.lock"))
    ) {
      throw httpError("workflow revisions are immutable while a run is active", 409);
    }
  }
}

function ensureOwnerDirectory(pathValue) {
  mkdirSync(pathValue, { recursive: true, mode: 0o700 });
  const stat = lstatSync(pathValue);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw httpError("registry path is unsafe", 409);
  chmodSync(pathValue, 0o700);
}

function assertSafeFile(pathValue) {
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink()) throw httpError("registry file is unsafe", 409);
  if (stat.size > MAX_REGISTRY_FILE_BYTES) throw httpError("registry file exceeds size limit", 413);
}

function readJson(pathValue) {
  assertSafeFile(pathValue);
  return JSON.parse(readFileSync(pathValue, "utf8"));
}

function atomicJson(pathValue, value) {
  const temporary = resolve(
    resolve(pathValue, ".."),
    `.${basename(pathValue)}.${process.pid}.${Date.now()}.tmp`,
  );
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_REGISTRY_FILE_BYTES)
    throw httpError("registry file exceeds size limit", 413);
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, pathValue);
  chmodSync(pathValue, 0o600);
}

function withLock(root, action) {
  const lockPath = resolve(root, ".registry.lock");
  let descriptor;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw httpError("workflow registry is busy", 409);
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    unlinkSync(lockPath);
  }
}

function workflowDirectory(root, workflowId) {
  if (!SAFE_ID.test(workflowId ?? "")) throw httpError("invalid workflow id");
  return resolve(root, "workflows", workflowId);
}

function revisionName(revision) {
  const number = Number(revision);
  if (!Number.isSafeInteger(number) || number < 1) throw httpError("invalid workflow revision");
  return `${String(number).padStart(6, "0")}.json`;
}

function revisionRecords(root, workflowId) {
  const revisions = resolve(workflowDirectory(root, workflowId), "revisions");
  if (!existsSync(revisions)) return [];
  const stat = lstatSync(revisions);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw httpError("revision directory is unsafe", 409);
  return readdirSync(revisions)
    .filter((name) => /^\d{6}\.json$/.test(name))
    .sort()
    .map((name) => readJson(resolve(revisions, name)));
}

function activationRecords(root) {
  const pathValue = resolve(root, "activations.jsonl");
  if (!existsSync(pathValue)) return [];
  assertSafeFile(pathValue);
  return readFileSync(pathValue, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendActivation(root, record) {
  const records = activationRecords(root);
  atomicJsonLines(resolve(root, "activations.jsonl"), [...records, record]);
}

function atomicJsonLines(pathValue, records) {
  const temporary = resolve(resolve(pathValue, ".."), `.${basename(pathValue)}.${process.pid}.tmp`);
  const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (Buffer.byteLength(body) > MAX_REGISTRY_FILE_BYTES)
    throw httpError("activation history exceeds size limit", 413);
  writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, pathValue);
  chmodSync(pathValue, 0o600);
}

function requireAttribution(body) {
  for (const key of ["actor", "rationale"]) {
    if (typeof body?.[key] !== "string" || !body[key].trim() || body[key].length > 4096) {
      throw httpError(`${key} is required and must not exceed 4096 characters`);
    }
  }
}

function diffValues(left, right, path = "") {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return [{ path: path || "/", before: left, after: right }];
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].sort().flatMap((key) => diffValues(left[key], right[key], `${path}/${key}`));
}

export function createWorkflowRegistry(projectRoot) {
  const root = resolve(gitCommonDirectory(projectRoot), "rae-workflows", "v2");
  ensureOwnerDirectory(root);
  ensureOwnerDirectory(resolve(root, "workflows"));
  const defaultSnapshot = loadWorkflow(DEFAULT_WORKFLOW_PATH);
  const defaultDirectory = workflowDirectory(root, defaultSnapshot.workflow.workflow_id);
  const defaultRevisionDirectory = resolve(defaultDirectory, "revisions");
  ensureOwnerDirectory(defaultDirectory);
  ensureOwnerDirectory(defaultRevisionDirectory);
  const defaultRevisionPath = resolve(
    defaultRevisionDirectory,
    revisionName(defaultSnapshot.workflow.revision),
  );
  if (!existsSync(defaultRevisionPath)) {
    atomicJson(defaultRevisionPath, {
      schema_version: defaultSnapshot.workflow.schema_version,
      workflow_id: defaultSnapshot.workflow.workflow_id,
      revision: defaultSnapshot.workflow.revision,
      digest: defaultSnapshot.digest,
      actor: "repository",
      rationale: "Committed graph-native default workflow",
      created_at: new Date(0).toISOString(),
      workflow: defaultSnapshot.workflow,
    });
  }

  function list() {
    const ids = new Set([defaultSnapshot.workflow.workflow_id]);
    for (const name of readdirSync(resolve(root, "workflows")))
      if (SAFE_ID.test(name)) ids.add(name);
    const activations = activationRecords(root);
    const active = activations.at(-1) ?? null;
    return [...ids].sort().map((workflowId) => {
      const revisions = revisionRecords(root, workflowId);
      const latest = revisions.at(-1);
      return {
        workflow_id: workflowId,
        latest_revision:
          latest?.revision ?? (workflowId === defaultSnapshot.workflow.workflow_id ? 1 : null),
        latest_digest:
          latest?.digest ??
          (workflowId === defaultSnapshot.workflow.workflow_id ? defaultSnapshot.digest : null),
        active: active?.workflow_id === workflowId,
      };
    });
  }

  function show(workflowId) {
    const revisions = revisionRecords(root, workflowId);
    const fallback = workflowId === defaultSnapshot.workflow.workflow_id ? defaultSnapshot : null;
    if (!fallback && revisions.length === 0) throw httpError("workflow not found", 404);
    return {
      workflow_id: workflowId,
      active: activationRecords(root).at(-1) ?? null,
      revisions,
      workflow: revisions.at(-1)?.workflow ?? fallback.workflow,
      digest: revisions.at(-1)?.digest ?? fallback.digest,
      activation_history: activationRecords(root).filter(
        (entry) => entry.workflow_id === workflowId,
      ),
    };
  }

  function draft(workflowId, body) {
    requireAttribution(body);
    if (!body.workflow || typeof body.workflow !== "object")
      throw httpError("workflow is required");
    const workflow = validateWorkflow(body.workflow);
    if (workflow.workflow_id !== workflowId)
      throw httpError("workflow id does not match request path");
    assertNoActiveRun(projectRoot);
    return withLock(root, () => {
      const revisions = revisionRecords(root, workflowId);
      const currentRevision = revisions.at(-1)?.revision ?? 0;
      if (Number(body.expected_revision ?? currentRevision) !== currentRevision) {
        throw httpError("workflow revision conflict", 409);
      }
      if (workflow.revision !== currentRevision + 1) {
        throw httpError(`workflow revision must be ${currentRevision + 1}`, 409);
      }
      const directory = workflowDirectory(root, workflowId);
      const revisionDir = resolve(directory, "revisions");
      ensureOwnerDirectory(directory);
      ensureOwnerDirectory(revisionDir);
      const record = {
        schema_version: workflow.schema_version,
        workflow_id: workflowId,
        revision: workflow.revision,
        digest: workflowDigest(workflow),
        actor: body.actor.trim(),
        rationale: body.rationale.trim(),
        created_at: new Date().toISOString(),
        workflow,
      };
      atomicJson(resolve(revisionDir, revisionName(workflow.revision)), record);
      return record;
    });
  }

  function validateRevision(workflowId, revision) {
    const record = revisionRecords(root, workflowId).find(
      (entry) => entry.revision === Number(revision),
    );
    if (!record) throw httpError("workflow revision not found", 404);
    const workflow = validateWorkflow(record.workflow);
    const digest = workflowDigest(workflow);
    if (digest !== record.digest) throw httpError("workflow revision digest mismatch", 409);
    return {
      valid: true,
      workflow_id: workflowId,
      revision: record.revision,
      digest,
      workflow_schema_version: workflow.schema_version,
    };
  }

  function diff(workflowId, query = {}) {
    const records = revisionRecords(root, workflowId);
    const left = records.find(
      (entry) => entry.revision === Number(query.from ?? records.at(-2)?.revision),
    );
    const right = records.find(
      (entry) => entry.revision === Number(query.to ?? records.at(-1)?.revision),
    );
    if (!left || !right) throw httpError("both diff revisions must exist", 404);
    return {
      from: left.revision,
      to: right.revision,
      changes: diffValues(left.workflow, right.workflow),
    };
  }

  function activate(workflowId, revision, body) {
    requireAttribution(body);
    assertNoActiveRun(projectRoot);
    return withLock(root, () => {
      const validation = validateRevision(workflowId, revision);
      if (body.digest !== validation.digest)
        throw httpError("typed digest confirmation does not match", 409);
      const record = {
        schema_version: validation.workflow_schema_version,
        decision: "activated",
        workflow_id: workflowId,
        revision: validation.revision,
        digest: validation.digest,
        actor: body.actor.trim(),
        rationale: body.rationale.trim(),
        activated_at: new Date().toISOString(),
      };
      appendActivation(root, record);
      atomicJson(resolve(root, "active.json"), record);
      return record;
    });
  }

  return Object.freeze({ list, show, draft, validate: validateRevision, diff, activate, root });
}

export function resolveActivatedWorkflow(projectRoot) {
  const registry = createWorkflowRegistry(projectRoot);
  const activePath = resolve(registry.root, "active.json");
  if (!existsSync(activePath)) return null;
  const active = readJson(activePath);
  const shown = registry.show(active.workflow_id);
  const revision = shown.revisions.find((entry) => entry.revision === active.revision);
  if (!revision || revision.digest !== active.digest)
    throw new Error("active workflow registry record is inconsistent");
  return {
    workflow: validateWorkflow(revision.workflow),
    digest: revision.digest,
    source: activePath,
  };
}
