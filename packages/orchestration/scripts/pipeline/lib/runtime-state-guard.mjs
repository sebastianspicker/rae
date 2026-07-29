/** Restores authoritative pipeline state after provider tampering or an interrupted phase. */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { gitOutput, sha256, validateConcurrentOperatorChanges } from "./autonomous-git.mjs";

const GUARD_SCHEMA = "1.0.0";

function modeOf(stat) {
  return stat.mode & 0o7777;
}

function privateDirectory(pathValue) {
  if (existsSync(pathValue)) {
    const stat = lstatSync(pathValue);
    const wrongOwner = typeof process.getuid === "function" && stat.uid !== process.getuid();
    if (!stat.isDirectory() || stat.isSymbolicLink() || wrongOwner) {
      throw new Error(`pipeline guard path is not a trusted directory: ${pathValue}`);
    }
    chmodSync(pathValue, 0o700);
    return;
  }
  mkdirSync(pathValue, { recursive: true, mode: 0o700 });
  chmodSync(pathValue, 0o700);
}

function repositoryIdentity(workspaceRoot) {
  const workspace = realpathSync(workspaceRoot);
  const workspaceStat = statSync(workspace);
  const topLevel = realpathSync(gitOutput(workspace, ["rev-parse", "--show-toplevel"]).trim());
  const gitDirectory = realpathSync(
    gitOutput(workspace, ["rev-parse", "--absolute-git-dir"]).trim(),
  );
  const gitCommonDirectory = realpathSync(
    gitOutput(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  return {
    workspace,
    workspace_dev: String(workspaceStat.dev),
    workspace_ino: String(workspaceStat.ino),
    top_level: topLevel,
    git_directory: gitDirectory,
    git_common_directory: gitCommonDirectory,
  };
}

function isWithin(pathValue, root) {
  const relation = relative(root, pathValue);
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

function canonicalPlannedPath(pathValue) {
  let existing = resolve(pathValue);
  const missing = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error(`pipeline guard path has no existing ancestor: ${pathValue}`);
    }
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

function writableRoots(identity) {
  const candidates = [
    identity.workspace,
    tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    process.platform === "win32" ? null : "/tmp",
    process.platform === "win32" ? null : "/var/tmp",
  ].filter(Boolean);
  return [...new Set(candidates.map((item) => canonicalPlannedPath(item)))];
}

function assertGuardOutsideWritableRoots(pathValue, identity) {
  const writable = writableRoots(identity);
  const containing = writable.find((root) => isWithin(pathValue, root));
  if (containing) {
    throw new Error(
      `pipeline state guard has no runner-only location outside provider-writable root: ${containing}`,
    );
  }
}

function guardPaths(workspaceRoot) {
  const identity = repositoryIdentity(workspaceRoot);
  const intendedBase = resolve(
    realpathSync(userInfo().homedir),
    ".local",
    "state",
    "rae",
    "pipeline-guards",
  );
  const plannedBase = canonicalPlannedPath(intendedBase);
  assertGuardOutsideWritableRoots(plannedBase, identity);
  privateDirectory(plannedBase);
  const base = realpathSync(plannedBase);
  if (base !== plannedBase) {
    throw new Error("pipeline state guard location changed while it was being prepared");
  }
  assertGuardOutsideWritableRoots(base, identity);
  const key = createHash("sha256").update(identity.workspace).digest("hex");
  return { identity, base, key, active: resolve(base, key) };
}

function guardClaimEntries({ base, key }) {
  const prefix = `${key}.claim-`;
  return readdirSync(base)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const match = name.slice(prefix.length).match(/^([1-9][0-9]*)-([a-f0-9-]{36})$/);
      if (!match) {
        throw new Error(`pipeline state guard has an invalid claimant entry: ${name}`);
      }
      return { path: resolve(base, name), pid: Number(match[1]) };
    });
}

function guardEvidence(paths) {
  const claims = guardClaimEntries(paths);
  const active = existsSync(paths.active);
  if (claims.length > 1 || (active && claims.length > 0)) {
    throw new Error("pipeline state guard has ambiguous active or claimant evidence");
  }
  if (active) return { kind: "active", path: paths.active, pid: null };
  if (claims.length === 1) return { kind: "claim", ...claims[0] };
  return null;
}

function guardClaimError() {
  return Object.assign(new Error("pipeline state guard is already claimed by a recovery process"), {
    code: "E_PIPELINE_GUARD_CLAIMED",
    status: 409,
  });
}

function claimantPath(paths) {
  return resolve(paths.base, `${paths.key}.claim-${process.pid}-${randomUUID()}`);
}

function renameClaim(source, target) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw guardClaimError();
    throw error;
  }
}

function acquireGuardClaim(paths) {
  const target = claimantPath(paths);
  try {
    renameSync(paths.active, target);
    return { found: true, path: target };
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (["EEXIST", "ENOTEMPTY"].includes(error.code)) throw guardClaimError();
      throw error;
    }
  }

  const evidence = guardEvidence(paths);
  if (!evidence) return { found: false, path: null };
  if (evidence.kind === "active") {
    renameClaim(evidence.path, target);
    return { found: true, path: target };
  }
  if (processAlive(evidence.pid)) throw guardClaimError();
  renameClaim(evidence.path, target);
  return { found: true, path: target };
}

function releaseClaimForRetry(paths, claimPath) {
  if (!existsSync(claimPath) || existsSync(paths.active)) return;
  renameSync(claimPath, paths.active);
}

function entrySignature(entry) {
  if (entry.kind === "file") return `file:${entry.mode}:${entry.sha256}`;
  if (entry.kind === "symlink") return `symlink:${entry.mode}:${entry.target}`;
  return `${entry.kind}:${entry.mode}`;
}

function snapshotEntries(pipelineRoot, payloadRoot) {
  const entries = [];
  const visit = (pathValue, ref) => {
    const stat = lstatSync(pathValue);
    const mode = modeOf(stat);
    if (stat.isDirectory()) {
      entries.push({ ref, kind: "directory", mode });
      if (ref) mkdirSync(resolve(payloadRoot, ref), { recursive: true, mode: 0o700 });
      for (const child of readdirSync(pathValue).sort()) {
        visit(resolve(pathValue, child), ref ? `${ref}/${child}` : child);
      }
      return;
    }
    if (stat.isFile()) {
      const bytes = readFileSync(pathValue);
      entries.push({ ref, kind: "file", mode, size: bytes.length, sha256: sha256(bytes) });
      const payloadPath = resolve(payloadRoot, ref);
      mkdirSync(dirname(payloadPath), { recursive: true, mode: 0o700 });
      writeFileSync(payloadPath, bytes, { mode: 0o600 });
      chmodSync(payloadPath, 0o600);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push({ ref, kind: "symlink", mode, target: readlinkSync(pathValue) });
      return;
    }
    throw new Error(`cannot guard special .pipeline entry: ${ref || ".pipeline"}`);
  };
  visit(pipelineRoot, "");
  return entries;
}

function readManifest(activePath) {
  const activeStat = lstatSync(activePath);
  if (
    !activeStat.isDirectory() ||
    activeStat.isSymbolicLink() ||
    (modeOf(activeStat) & 0o077) !== 0
  ) {
    throw new Error("pipeline state guard is not a trusted directory");
  }
  const manifestPath = resolve(activePath, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    (modeOf(manifestStat) & 0o077) !== 0
  ) {
    throw new Error("pipeline state guard manifest is missing or unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

function safeGuardRef(ref, allowRoot = false) {
  if (allowRoot && ref === "") return true;
  if (typeof ref !== "string" || !ref || ref.includes("\\") || ref.startsWith("/")) return false;
  return !ref.split("/").some((part) => !part || part === "." || part === "..");
}

function validFileEntry(entry) {
  return (
    Number.isSafeInteger(entry.size) && entry.size >= 0 && /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
  );
}

function validEntryKind(entry) {
  if (entry.kind === "directory") return true;
  if (entry.kind === "symlink") return typeof entry.target === "string";
  return entry.kind === "file" && validFileEntry(entry);
}

function validEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    safeGuardRef(entry.ref, true) &&
    Number.isInteger(entry.mode) &&
    entry.mode >= 0 &&
    entry.mode <= 0o7777 &&
    validEntryKind(entry)
  );
}

const MANIFEST_IDENTITY_KEYS = [
  "workspace",
  "workspace_dev",
  "workspace_ino",
  "top_level",
  "git_directory",
  "git_common_directory",
];

function validManifestHeader(manifest) {
  return (
    validManifestOwner(manifest) &&
    validManifestTimestamp(manifest.created_at) &&
    validManifestIdentity(manifest.identity) &&
    validManifestPhase(manifest.phase) &&
    validManifestRefs(manifest)
  );
}

function validManifestOwner(manifest) {
  return (
    manifest?.schema_version === GUARD_SCHEMA &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.run_id ?? "") &&
    Number.isSafeInteger(manifest.owner_pid)
  );
}

function validManifestPhase(phase) {
  return phase === null || ["build", "post-build"].includes(phase);
}

function validManifestRefs(manifest) {
  return safeGuardRef(manifest.control_ref) && safeGuardRef(manifest.trace_ref);
}

function validManifestTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validManifestIdentity(identity) {
  return (
    Boolean(identity) && MANIFEST_IDENTITY_KEYS.every((key) => typeof identity[key] === "string")
  );
}

function manifestEntryMap(manifest) {
  if (!Array.isArray(manifest.entries) || manifest.entries.some((entry) => !validEntry(entry))) {
    return null;
  }
  const byRef = new Map(manifest.entries.map((entry) => [entry.ref, entry]));
  return byRef.size === manifest.entries.length ? byRef : null;
}

function validManifestStructure(manifest, byRef) {
  if (
    byRef.get("")?.kind !== "directory" ||
    byRef.get(manifest.control_ref)?.kind !== "file" ||
    byRef.get(manifest.trace_ref)?.kind !== "file"
  ) {
    return false;
  }
  return manifest.entries
    .filter((entry) => entry.ref)
    .every((entry) => {
      const parent = entry.ref.includes("/") ? entry.ref.slice(0, entry.ref.lastIndexOf("/")) : "";
      return byRef.get(parent)?.kind === "directory";
    });
}

function validateManifest(manifest) {
  if (!validManifestHeader(manifest)) {
    throw new Error("pipeline state guard manifest is invalid");
  }
  const byRef = manifestEntryMap(manifest);
  if (!byRef) {
    throw new Error("pipeline state guard manifest is invalid");
  }
  if (!validManifestStructure(manifest, byRef)) {
    throw new Error("pipeline state guard manifest structure is invalid");
  }
}

function assertRepositoryIdentity(expected, current) {
  for (const key of [
    "workspace",
    "workspace_dev",
    "workspace_ino",
    "top_level",
    "git_directory",
    "git_common_directory",
  ]) {
    if (expected[key] !== current[key]) {
      throw new Error(`pipeline state guard cannot prove repository identity: ${key} changed`);
    }
  }
}

function currentEntries(pipelineRoot) {
  const entries = [];
  const visit = (pathValue, ref) => {
    const stat = lstatSync(pathValue);
    const mode = modeOf(stat);
    if (stat.isDirectory()) {
      entries.push({ ref, kind: "directory", mode });
      for (const child of readdirSync(pathValue).sort()) {
        visit(resolve(pathValue, child), ref ? `${ref}/${child}` : child);
      }
    } else if (stat.isFile()) {
      const bytes = readFileSync(pathValue);
      entries.push({ ref, kind: "file", mode, size: bytes.length, sha256: sha256(bytes) });
    } else if (stat.isSymbolicLink()) {
      entries.push({ ref, kind: "symlink", mode, target: readlinkSync(pathValue) });
    } else {
      entries.push({ ref, kind: "special", mode });
    }
  };
  visit(pipelineRoot, "");
  return entries;
}

function entryMap(entries) {
  return new Map(entries.map((entry) => [entry.ref, entrySignature(entry)]));
}

function changedEntries(beforeEntries, afterEntries, ignored = new Set()) {
  const before = entryMap(beforeEntries);
  const after = entryMap(afterEntries);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => !ignored.has(ref) && before.get(ref) !== after.get(ref))
    .sort();
}

function safeRuntimeFile(pipelineRoot, ref) {
  const normalized = ref.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return null;
  let current = pipelineRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) return null;
    if (index < segments.length - 1 && !stat.isDirectory()) return null;
    if (index === segments.length - 1 && !stat.isFile()) return null;
  }
  const stat = lstatSync(current);
  return { bytes: readFileSync(current), mode: modeOf(stat) };
}

function snapshotFile(activePath, manifest, ref) {
  const entry = manifest.entries.find((item) => item.ref === ref);
  if (entry?.kind !== "file") return null;
  const pathValue = resolve(activePath, "payload", ref);
  const payloadRoot = resolve(activePath, "payload");
  let current = payloadRoot;
  for (const [index, segment] of ref.split("/").entries()) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`pipeline state guard payload contains a symlink: ${ref}`);
    }
    if (index < ref.split("/").length - 1 && !stat.isDirectory()) {
      throw new Error(`pipeline state guard payload parent is not a directory: ${ref}`);
    }
    if (index === ref.split("/").length - 1 && !stat.isFile()) {
      throw new Error(`pipeline state guard payload is not a file: ${ref}`);
    }
  }
  const bytes = readFileSync(pathValue);
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size) {
    throw new Error(`pipeline state guard payload failed verification: ${ref}`);
  }
  return { bytes, mode: entry.mode };
}

function parseJsonFile(file, label) {
  if (!file) throw new Error(`${label} is missing or unsafe`);
  try {
    return JSON.parse(file.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function concurrentTransition(activePath, manifest, pipelineRoot) {
  const beforeControlFile = snapshotFile(activePath, manifest, manifest.control_ref);
  const beforeTraceFile = snapshotFile(activePath, manifest, manifest.trace_ref);
  const afterControlFile = safeRuntimeFile(pipelineRoot, manifest.control_ref);
  const afterTraceFile = safeRuntimeFile(pipelineRoot, manifest.trace_ref);
  const beforeControl = parseJsonFile(beforeControlFile, "guarded operator control");
  const afterControl = parseJsonFile(afterControlFile, "current operator control");
  const beforeTrace = beforeTraceFile?.bytes.toString("utf8") ?? "";
  const afterTrace = afterTraceFile?.bytes.toString("utf8") ?? "";
  validateConcurrentOperatorChanges({
    beforeControl,
    afterControl,
    beforeTrace,
    afterTrace,
    runId: manifest.run_id,
    expectedPhase: manifest.phase,
  });
  return {
    control: afterControlFile,
    trace: afterTraceFile,
    changed:
      JSON.stringify(beforeControl) !== JSON.stringify(afterControl) || beforeTrace !== afterTrace,
  };
}

function restoreSnapshot(activePath, manifest, pipelineRoot, afterPipelineRemoval = null) {
  rmSync(pipelineRoot, { recursive: true, force: true });
  afterPipelineRemoval?.();
  mkdirSync(pipelineRoot, { mode: 0o700 });
  const directories = manifest.entries
    .filter((entry) => entry.kind === "directory" && entry.ref)
    .sort((left, right) => left.ref.split("/").length - right.ref.split("/").length);
  for (const entry of directories) {
    mkdirSync(resolve(pipelineRoot, entry.ref), { recursive: true, mode: 0o700 });
  }
  for (const entry of manifest.entries.filter((item) => item.kind === "file")) {
    const source = snapshotFile(activePath, manifest, entry.ref);
    const target = resolve(pipelineRoot, entry.ref);
    writeFileSync(target, source.bytes, { mode: entry.mode });
    chmodSync(target, entry.mode);
  }
  for (const entry of manifest.entries.filter((item) => item.kind === "symlink")) {
    symlinkSync(entry.target, resolve(pipelineRoot, entry.ref));
  }
  for (const entry of [...directories].reverse()) {
    chmodSync(resolve(pipelineRoot, entry.ref), entry.mode);
  }
  chmodSync(pipelineRoot, manifest.entries.find((entry) => entry.ref === "").mode);
}

function replaceRuntimeFile(pipelineRoot, ref, file) {
  if (!file) return;
  const pathValue = resolve(pipelineRoot, ref);
  writeFileSync(pathValue, file.bytes, { mode: file.mode });
  chmodSync(pathValue, file.mode);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function activeGuardError(manifest) {
  const phase = manifest.phase ?? "unknown";
  return Object.assign(
    new Error(
      `pipeline phase ${phase} is guarded and may still be active; runtime state access is refused`,
    ),
    { code: "E_PIPELINE_PHASE_ACTIVE", status: 409 },
  );
}

function staleLockRef(manifest) {
  return `runs/${manifest.run_id}/autonomous.lock`;
}

/** Creates an atomic byte snapshot in runner state outside all known provider-writable roots. */
export function createRuntimeStateGuard(workspaceRoot, runId, phase = null) {
  const paths = guardPaths(workspaceRoot);
  const { identity, base, active } = paths;
  if (guardEvidence(paths)) {
    throw new Error("an unreconciled pipeline state guard already exists for this workspace");
  }
  const pipelineRoot = resolve(identity.workspace, ".pipeline");
  const pipelineStat = lstatSync(pipelineRoot);
  if (!pipelineStat.isDirectory() || pipelineStat.isSymbolicLink()) {
    throw new Error(".pipeline must be a real directory before provider execution");
  }
  const staging = mkdtempSync(resolve(base, ".staging-"));
  chmodSync(staging, 0o700);
  try {
    const payloadRoot = resolve(staging, "payload");
    mkdirSync(payloadRoot, { mode: 0o700 });
    const controlRef = `runs/${runId}/operator-control.json`;
    const traceRef = `runs/${runId}/trace.jsonl`;
    const manifest = {
      schema_version: GUARD_SCHEMA,
      run_id: runId,
      phase,
      owner_pid: process.pid,
      created_at: new Date().toISOString(),
      identity,
      control_ref: controlRef,
      trace_ref: traceRef,
      entries: snapshotEntries(pipelineRoot, payloadRoot),
    };
    const manifestPath = resolve(staging, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    renameSync(staging, active);
    return { active, runId };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Reads only the external guard and never consumes provider-writable pipeline state. */
export function inspectRuntimeStateGuard(workspaceRoot, { expectedRunId = null } = {}) {
  const paths = guardPaths(workspaceRoot);
  const { identity } = paths;
  const evidence = guardEvidence(paths);
  if (!evidence) return { found: false, ownerActive: false };
  const manifest = readManifest(evidence.path);
  assertRepositoryIdentity(manifest.identity, identity);
  if (expectedRunId && manifest.run_id !== expectedRunId) {
    throw new Error("pipeline state guard run identity does not match the requested run");
  }
  return {
    found: true,
    ownerActive: processAlive(evidence.kind === "claim" ? evidence.pid : manifest.owner_pid),
    runId: manifest.run_id,
    phase: manifest.phase,
    createdAt: manifest.created_at,
  };
}

/** Refuses active guarded state and restores stale guarded state before any caller reads it. */
export function ensureRuntimeStateReadable(workspaceRoot, { expectedRunId = null } = {}) {
  const guard = inspectRuntimeStateGuard(workspaceRoot, { expectedRunId });
  if (!guard.found) return { found: false, restored: false };
  if (guard.ownerActive) {
    throw activeGuardError({ phase: guard.phase });
  }
  return reconcileRuntimeStateGuard(workspaceRoot, {
    recovery: true,
    expectedRunId: expectedRunId ?? guard.runId,
  });
}

/** Restores tampered state, preserves only validated stop transitions, and verifies the result. */
function assertReconcileSeams({ afterClaim, afterPipelineRemoval }) {
  if (afterClaim !== null && typeof afterClaim !== "function") {
    throw new Error("pipeline state guard afterClaim seam must be a function");
  }
  if (afterPipelineRemoval !== null && typeof afterPipelineRemoval !== "function") {
    throw new Error("pipeline state guard afterPipelineRemoval seam must be a function");
  }
}

function claimedManifest(paths, claim, expectedRunId, recovery, afterClaim) {
  afterClaim?.({ claimPath: claim.path });
  const manifest = readManifest(claim.path);
  assertRepositoryIdentity(manifest.identity, paths.identity);
  if (expectedRunId && manifest.run_id !== expectedRunId) {
    throw new Error("pipeline state guard run identity does not match the active run");
  }
  if (recovery && processAlive(manifest.owner_pid)) {
    releaseClaimForRetry(paths, claim.path);
    throw new Error("pipeline state guard belongs to a process that may still be active");
  }
  return manifest;
}

function guardedRuntimeState(claimPath, manifest, pipelineRoot, allowedRefs) {
  let transition = null;
  let transitionError = null;
  try {
    transition = concurrentTransition(claimPath, manifest, pipelineRoot);
  } catch (error) {
    transitionError = error;
  }
  const ignored = new Set([...allowedRefs, manifest.control_ref, manifest.trace_ref]);
  let changed = [];
  let currentError = null;
  try {
    const entries = currentEntries(pipelineRoot);
    changed = changedEntries(manifest.entries, entries, ignored);
    const current = entryMap(entries);
    for (const ref of allowedRefs) {
      const entry = current.get(ref);
      if (entry && !entry.startsWith("file:")) changed.push(ref);
    }
  } catch (error) {
    currentError = error;
  }
  return { changed, currentError, transition, transitionError };
}

function restoreRuntimeTransition(pipelineRoot, manifest, transition) {
  if (!transition?.changed) return new Set();
  replaceRuntimeFile(pipelineRoot, manifest.control_ref, transition.control);
  replaceRuntimeFile(pipelineRoot, manifest.trace_ref, transition.trace);
  return new Set([manifest.control_ref, manifest.trace_ref]);
}

function removeRecoveryLock(pipelineRoot, manifest, verificationIgnored, recovery) {
  if (!recovery) return;
  const lockRef = staleLockRef(manifest);
  const lockPath = resolve(pipelineRoot, lockRef);
  if (existsSync(lockPath)) unlinkSync(lockPath);
  verificationIgnored.add(lockRef);
}

function restoredGuardResult(manifest, recovery, state) {
  if (recovery) return { found: true, restored: true, tampered: false, runId: manifest.run_id };
  return {
    found: true,
    restored: true,
    tampered: true,
    changed: [...new Set(state.changed)].sort(),
    detail: state.transitionError?.message ?? state.currentError?.message ?? null,
  };
}

function restoreGuardedRuntime(claim, manifest, pipelineRoot, state, options) {
  restoreSnapshot(claim.path, manifest, pipelineRoot, options.afterPipelineRemoval);
  const verificationIgnored = restoreRuntimeTransition(pipelineRoot, manifest, state.transition);
  removeRecoveryLock(pipelineRoot, manifest, verificationIgnored, options.recovery);
  const residual = changedEntries(
    manifest.entries,
    currentEntries(pipelineRoot),
    verificationIgnored,
  );
  if (residual.length > 0) {
    throw new Error(
      `pipeline state restoration could not be verified: ${residual.slice(0, 8).join(", ")}`,
    );
  }
  rmSync(claim.path, { recursive: true, force: true });
  return restoredGuardResult(manifest, options.recovery, state);
}

export function reconcileRuntimeStateGuard(workspaceRoot, options = {}) {
  const {
    allowedRefs = [],
    recovery = false,
    expectedRunId = null,
    afterClaim = null,
    afterPipelineRemoval = null,
  } = options;
  assertReconcileSeams({ afterClaim, afterPipelineRemoval });
  const paths = guardPaths(workspaceRoot);
  const claim = acquireGuardClaim(paths);
  if (!claim.found) return { found: false, restored: false, tampered: false };
  try {
    const manifest = claimedManifest(paths, claim, expectedRunId, recovery, afterClaim);
    const pipelineRoot = resolve(paths.identity.workspace, ".pipeline");
    const runtimeState = guardedRuntimeState(claim.path, manifest, pipelineRoot, allowedRefs);
    const tampered =
      recovery ||
      Boolean(runtimeState.transitionError) ||
      Boolean(runtimeState.currentError) ||
      runtimeState.changed.length > 0;
    if (!tampered) {
      rmSync(claim.path, { recursive: true, force: true });
      return {
        found: true,
        restored: false,
        tampered: false,
        concurrentStop: runtimeState.transition?.changed,
      };
    }
    return restoreGuardedRuntime(claim, manifest, pipelineRoot, runtimeState, {
      afterPipelineRemoval,
      recovery,
    });
  } catch (error) {
    try {
      releaseClaimForRetry(paths, claim.path);
    } catch (releaseError) {
      error.guardClaimReleaseError = releaseError.message;
    }
    throw error;
  }
}

export function runtimeStateGuardPath(workspaceRoot) {
  return guardPaths(workspaceRoot).active;
}
