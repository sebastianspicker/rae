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
import type { Stats } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { isWithinRoot } from "../primitives/paths.js";
import { gitOutput, sha256, validateConcurrentOperatorChanges } from "./autonomous-git.js";

const GUARD_SCHEMA = "1.0.0";

interface RepositoryIdentity extends Record<string, string> {
  workspace: string;
  workspace_dev: string;
  workspace_ino: string;
  top_level: string;
  git_directory: string;
  git_common_directory: string;
}
interface GuardPaths {
  identity: RepositoryIdentity;
  base: string;
  key: string;
  active: string;
}
interface GuardEntry {
  ref: string;
  kind: "directory" | "file" | "symlink" | "special";
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
}
interface GuardManifest {
  schema_version: string;
  run_id: string;
  phase: string | null;
  owner_pid: number;
  created_at: string;
  identity: RepositoryIdentity;
  control_ref: string;
  trace_ref: string;
  entries: GuardEntry[];
}
interface GuardEvidence {
  kind: "active" | "claim";
  path: string;
  pid: number | null;
}
type GuardClaim = { found: true; path: string } | { found: false; path: null };
interface RuntimeFile {
  bytes: Buffer;
  mode: number;
}
interface RuntimeTransition {
  control: RuntimeFile | null;
  trace: RuntimeFile | null;
  changed: boolean;
}
interface GuardedRuntimeState {
  changed: string[];
  currentError: unknown;
  transition: RuntimeTransition | null;
  transitionError: unknown;
}
export interface RuntimeGuardReconciliation extends Record<string, unknown> {
  found: boolean;
  restored: boolean;
  tampered: boolean;
  changed?: string[];
  detail?: string;
  concurrentStop?: boolean;
}
interface ReconcileOptions {
  allowedRefs?: string[];
  recovery?: boolean;
  expectedRunId?: string | null;
  afterClaim?: ((context: { claimPath: string }) => void) | null;
  afterPipelineRemoval?: (() => void) | null;
}
interface GuardFailure extends Error {
  guardClaimReleaseError?: string;
}
interface GuardInspection {
  found: boolean;
  ownerActive: boolean;
  runId?: string;
  phase?: string | null;
  createdAt?: string;
}

function modeOf(stat: Stats): number {
  return stat.mode & 0o7777;
}

function privateDirectory(pathValue: string): void {
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

function repositoryIdentity(workspaceRoot: string): RepositoryIdentity {
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

function canonicalPlannedPath(pathValue: string): string {
  let existing = resolve(pathValue);
  const missing: string[] = [];
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

function writableRoots(identity: RepositoryIdentity): string[] {
  const candidates = [
    identity.workspace,
    tmpdir(),
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    process.platform === "win32" ? null : "/tmp",
    process.platform === "win32" ? null : "/var/tmp",
  ].filter((candidate): candidate is string => typeof candidate === "string");
  return [...new Set(candidates.map((item) => canonicalPlannedPath(item)))];
}

function assertGuardOutsideWritableRoots(pathValue: string, identity: RepositoryIdentity): void {
  const writable = writableRoots(identity);
  const containing = writable.find((root) => isWithinRoot(root, pathValue));
  if (containing) {
    throw new Error(
      `pipeline state guard has no runner-only location outside provider-writable root: ${containing}`,
    );
  }
}

function guardPaths(workspaceRoot: string): GuardPaths {
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

function guardClaimEntries({
  base,
  key,
}: Pick<GuardPaths, "base" | "key">): Array<{ path: string; pid: number }> {
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

function guardEvidence(paths: GuardPaths): GuardEvidence | null {
  const claims = guardClaimEntries(paths);
  const active = existsSync(paths.active);
  if (claims.length > 1 || (active && claims.length > 0)) {
    throw new Error("pipeline state guard has ambiguous active or claimant evidence");
  }
  if (active) return { kind: "active", path: paths.active, pid: null };
  if (claims.length === 1) return { kind: "claim", ...claims[0] };
  return null;
}

function guardClaimError(): Error & { code: string; status: number } {
  return Object.assign(new Error("pipeline state guard is already claimed by a recovery process"), {
    code: "E_PIPELINE_GUARD_CLAIMED",
    status: 409,
  });
}

function claimantPath(paths: GuardPaths): string {
  return resolve(paths.base, `${paths.key}.claim-${process.pid}-${randomUUID()}`);
}

function renameClaim(source: string, target: string): void {
  try {
    renameSync(source, target);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(error.code))
    )
      throw guardClaimError();
    throw error;
  }
}

function claimActiveGuard(paths: GuardPaths, target: string): boolean {
  try {
    renameSync(paths.active, target);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    if (
      error instanceof Error &&
      "code" in error &&
      ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
    )
      throw guardClaimError();
    throw error;
  }
}

function acquireGuardClaim(paths: GuardPaths): GuardClaim {
  const target = claimantPath(paths);
  if (claimActiveGuard(paths, target)) return { found: true, path: target };

  const evidence = guardEvidence(paths);
  if (!evidence) return { found: false, path: null };
  if (evidence.kind === "claim" && processAlive(evidence.pid)) throw guardClaimError();
  renameClaim(evidence.path, target);
  return { found: true, path: target };
}

function releaseClaimForRetry(paths: GuardPaths, claimPath: string): void {
  if (!existsSync(claimPath) || existsSync(paths.active)) return;
  renameSync(claimPath, paths.active);
}

function entrySignature(entry: GuardEntry): string {
  if (entry.kind === "file") return `file:${entry.mode}:${entry.sha256}`;
  if (entry.kind === "symlink") return `symlink:${entry.mode}:${entry.target}`;
  return `${entry.kind}:${entry.mode}`;
}

function snapshotEntries(pipelineRoot: string, payloadRoot: string): GuardEntry[] {
  const entries: GuardEntry[] = [];
  const visit = (pathValue: string, ref: string): void => {
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

function readManifest(activePath: string): GuardManifest {
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
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

function safeGuardSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function safeGuardRef(ref: unknown, allowRoot = false): ref is string {
  if (allowRoot && ref === "") return true;
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (ref.includes("\\") || ref.startsWith("/")) return false;
  return ref.split("/").every(safeGuardSegment);
}

function validFileEntry(entry: GuardEntry): boolean {
  return (
    Number.isSafeInteger(entry.size) &&
    Number(entry.size) >= 0 &&
    /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
  );
}

function validEntryKind(entry: GuardEntry): boolean {
  if (entry.kind === "directory") return true;
  if (entry.kind === "symlink") return typeof entry.target === "string";
  return entry.kind === "file" && validFileEntry(entry);
}

function validEntry(entry: unknown): entry is GuardEntry {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      safeGuardRef((entry as Partial<GuardEntry>).ref, true) &&
      Number.isInteger((entry as Partial<GuardEntry>).mode) &&
      Number((entry as Partial<GuardEntry>).mode) >= 0 &&
      Number((entry as Partial<GuardEntry>).mode) <= 0o7777 &&
      validEntryKind(entry as GuardEntry),
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

function validManifestHeader(manifest: Partial<GuardManifest>): boolean {
  return (
    validManifestOwner(manifest) &&
    validManifestTimestamp(manifest.created_at) &&
    validManifestIdentity(manifest.identity) &&
    validManifestPhase(manifest.phase) &&
    validManifestRefs(manifest)
  );
}

function validManifestOwner(manifest: Partial<GuardManifest>): boolean {
  return (
    manifest?.schema_version === GUARD_SCHEMA &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.run_id ?? "") &&
    Number.isSafeInteger(manifest.owner_pid)
  );
}

function validManifestPhase(phase: unknown): phase is string | null {
  return phase === null || (typeof phase === "string" && ["build", "post-build"].includes(phase));
}

function validManifestRefs(manifest: Partial<GuardManifest>): boolean {
  return safeGuardRef(manifest.control_ref) && safeGuardRef(manifest.trace_ref);
}

function validManifestTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validManifestIdentity(identity: unknown): identity is RepositoryIdentity {
  return (
    Boolean(identity) &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    MANIFEST_IDENTITY_KEYS.every(
      (key) => typeof (identity as Record<string, unknown>)[key] === "string",
    )
  );
}

function manifestEntryMap(manifest: Partial<GuardManifest>): Map<string, GuardEntry> | null {
  if (!Array.isArray(manifest.entries) || manifest.entries.some((entry) => !validEntry(entry))) {
    return null;
  }
  const byRef = new Map(manifest.entries.map((entry) => [entry.ref, entry]));
  return byRef.size === manifest.entries.length ? byRef : null;
}

function validManifestStructure(
  manifest: GuardManifest,
  byRef: ReadonlyMap<string, GuardEntry>,
): boolean {
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

function validateManifest(manifest: unknown): asserts manifest is GuardManifest {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("pipeline state guard manifest is invalid");
  }
  const candidate = manifest as Partial<GuardManifest>;
  if (!validManifestHeader(candidate)) {
    throw new Error("pipeline state guard manifest is invalid");
  }
  const byRef = manifestEntryMap(candidate);
  if (!byRef) {
    throw new Error("pipeline state guard manifest is invalid");
  }
  if (!validManifestStructure(candidate as GuardManifest, byRef)) {
    throw new Error("pipeline state guard manifest structure is invalid");
  }
}

function assertRepositoryIdentity(expected: RepositoryIdentity, current: RepositoryIdentity): void {
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

function currentEntries(pipelineRoot: string): GuardEntry[] {
  const entries: GuardEntry[] = [];
  const visit = (pathValue: string, ref: string): void => {
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

function entryMap(entries: readonly GuardEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.ref, entrySignature(entry)]));
}

function changedEntries(
  beforeEntries: readonly GuardEntry[],
  afterEntries: readonly GuardEntry[],
  ignored: ReadonlySet<string> = new Set(),
): string[] {
  const before = entryMap(beforeEntries);
  const after = entryMap(afterEntries);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => !ignored.has(ref) && before.get(ref) !== after.get(ref))
    .sort();
}

function safePathStat(pathValue: string): Stats | null {
  try {
    return lstatSync(pathValue);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isExpectedRuntimeEntry(stat: Stats, index: number, lastIndex: number): boolean {
  if (stat.isSymbolicLink()) return false;
  return index === lastIndex ? stat.isFile() : stat.isDirectory();
}

function safeRuntimeFile(pipelineRoot: string, ref: string): RuntimeFile | null {
  const normalized = ref.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) return null;
  let current = pipelineRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stat = safePathStat(current);
    if (!stat || !isExpectedRuntimeEntry(stat, index, segments.length - 1)) return null;
  }
  const stat = lstatSync(current);
  return { bytes: readFileSync(current), mode: modeOf(stat) };
}

function assertSnapshotPathEntry(stat: Stats, index: number, lastIndex: number, ref: string): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`pipeline state guard payload contains a symlink: ${ref}`);
  }
  if (index < lastIndex && !stat.isDirectory()) {
    throw new Error(`pipeline state guard payload parent is not a directory: ${ref}`);
  }
  if (index === lastIndex && !stat.isFile()) {
    throw new Error(`pipeline state guard payload is not a file: ${ref}`);
  }
}

function snapshotFile(
  activePath: string,
  manifest: GuardManifest,
  ref: string,
): RuntimeFile | null {
  const entry = manifest.entries.find((item) => item.ref === ref);
  if (entry?.kind !== "file") return null;
  const pathValue = resolve(activePath, "payload", ref);
  const payloadRoot = resolve(activePath, "payload");
  const segments = ref.split("/");
  let current = payloadRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    assertSnapshotPathEntry(stat, index, segments.length - 1, ref);
  }
  const bytes = readFileSync(pathValue);
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.size) {
    throw new Error(`pipeline state guard payload failed verification: ${ref}`);
  }
  return { bytes, mode: entry.mode };
}

function parseJsonFile(file: RuntimeFile | null, label: string): Record<string, unknown> {
  if (!file) throw new Error(`${label} is missing or unsafe`);
  try {
    const parsed: unknown = JSON.parse(file.bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function concurrentTransition(
  activePath: string,
  manifest: GuardManifest,
  pipelineRoot: string,
): RuntimeTransition {
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

function restoreSnapshot(
  activePath: string,
  manifest: GuardManifest,
  pipelineRoot: string,
  afterPipelineRemoval: (() => void) | null = null,
): void {
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
    if (!source) throw new Error(`pipeline state guard payload is missing: ${entry.ref}`);
    const target = resolve(pipelineRoot, entry.ref);
    writeFileSync(target, source.bytes, { mode: entry.mode });
    chmodSync(target, entry.mode);
  }
  for (const entry of manifest.entries.filter((item) => item.kind === "symlink")) {
    if (typeof entry.target !== "string") {
      throw new Error(`pipeline state guard symlink target is missing: ${entry.ref}`);
    }
    symlinkSync(entry.target, resolve(pipelineRoot, entry.ref));
  }
  for (const entry of [...directories].reverse()) {
    chmodSync(resolve(pipelineRoot, entry.ref), entry.mode);
  }
  const rootEntry = manifest.entries.find((entry) => entry.ref === "");
  if (!rootEntry) throw new Error("pipeline state guard root entry is missing");
  chmodSync(pipelineRoot, rootEntry.mode);
}

function replaceRuntimeFile(pipelineRoot: string, ref: string, file: RuntimeFile | null): void {
  if (!file) return;
  const pathValue = resolve(pipelineRoot, ref);
  writeFileSync(pathValue, file.bytes, { mode: file.mode });
  chmodSync(pathValue, file.mode);
}

function processAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function activeGuardError(
  manifest: Pick<GuardManifest, "phase">,
): Error & { code: string; status: number } {
  const phase = manifest.phase ?? "unknown";
  return Object.assign(
    new Error(
      `pipeline phase ${phase} is guarded and may still be active; runtime state access is refused`,
    ),
    { code: "E_PIPELINE_PHASE_ACTIVE", status: 409 },
  );
}

function staleLockRef(manifest: GuardManifest): string {
  return `runs/${manifest.run_id}/autonomous.lock`;
}

/** Creates an atomic byte snapshot in runner state outside all known provider-writable roots. */
export function createRuntimeStateGuard(
  workspaceRoot: string,
  runId: string,
  phase: string | null = null,
): { active: string; runId: string } {
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
export function inspectRuntimeStateGuard(
  workspaceRoot: string,
  { expectedRunId = null }: { expectedRunId?: string | null } = {},
): GuardInspection {
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
export function ensureRuntimeStateReadable(
  workspaceRoot: string,
  { expectedRunId = null }: { expectedRunId?: string | null } = {},
): Record<string, unknown> {
  const guard = inspectRuntimeStateGuard(workspaceRoot, { expectedRunId });
  if (!guard.found) return { found: false, restored: false };
  if (guard.ownerActive) {
    throw activeGuardError({ phase: guard.phase ?? null });
  }
  return reconcileRuntimeStateGuard(workspaceRoot, {
    recovery: true,
    expectedRunId: expectedRunId ?? guard.runId ?? null,
  });
}

/** Restores tampered state, preserves only validated stop transitions, and verifies the result. */
function assertReconcileSeams({
  afterClaim,
  afterPipelineRemoval,
}: Pick<Required<ReconcileOptions>, "afterClaim" | "afterPipelineRemoval">): void {
  if (afterClaim !== null && typeof afterClaim !== "function") {
    throw new Error("pipeline state guard afterClaim seam must be a function");
  }
  if (afterPipelineRemoval !== null && typeof afterPipelineRemoval !== "function") {
    throw new Error("pipeline state guard afterPipelineRemoval seam must be a function");
  }
}

function claimedManifest(
  paths: GuardPaths,
  claim: Extract<GuardClaim, { found: true }>,
  expectedRunId: string | null,
  recovery: boolean,
  afterClaim: ReconcileOptions["afterClaim"],
): GuardManifest {
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

function guardedRuntimeState(
  claimPath: string,
  manifest: GuardManifest,
  pipelineRoot: string,
  allowedRefs: readonly string[],
): GuardedRuntimeState {
  let transition: RuntimeTransition | null = null;
  let transitionError: unknown = null;
  try {
    transition = concurrentTransition(claimPath, manifest, pipelineRoot);
  } catch (error) {
    transitionError = error;
  }
  const ignored = new Set([...allowedRefs, manifest.control_ref, manifest.trace_ref]);
  let changed: string[] = [];
  let currentError: unknown = null;
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

function restoreRuntimeTransition(
  pipelineRoot: string,
  manifest: GuardManifest,
  transition: RuntimeTransition | null,
): Set<string> {
  if (!transition?.changed) return new Set<string>();
  replaceRuntimeFile(pipelineRoot, manifest.control_ref, transition.control);
  replaceRuntimeFile(pipelineRoot, manifest.trace_ref, transition.trace);
  return new Set([manifest.control_ref, manifest.trace_ref]);
}

function removeRecoveryLock(
  pipelineRoot: string,
  manifest: GuardManifest,
  verificationIgnored: Set<string>,
  recovery: boolean,
): void {
  if (!recovery) return;
  const lockRef = staleLockRef(manifest);
  const lockPath = resolve(pipelineRoot, lockRef);
  if (existsSync(lockPath)) unlinkSync(lockPath);
  verificationIgnored.add(lockRef);
}

function restoredGuardResult(
  manifest: GuardManifest,
  recovery: boolean,
  state: GuardedRuntimeState,
): Record<string, unknown> {
  if (recovery) return { found: true, restored: true, tampered: false, runId: manifest.run_id };
  return {
    found: true,
    restored: true,
    tampered: true,
    changed: [...new Set(state.changed)].sort(),
    detail:
      (state.transitionError instanceof Error ? state.transitionError.message : null) ??
      (state.currentError instanceof Error ? state.currentError.message : null),
  };
}

function runtimeStateWasTampered(runtimeState: GuardedRuntimeState, recovery: boolean): boolean {
  return (
    recovery ||
    Boolean(runtimeState.transitionError) ||
    Boolean(runtimeState.currentError) ||
    runtimeState.changed.length > 0
  );
}

function releaseFailedClaim(paths: GuardPaths, claimPath: string, error: unknown): void {
  try {
    releaseClaimForRetry(paths, claimPath);
  } catch (releaseError) {
    if (error instanceof Error) {
      (error as GuardFailure).guardClaimReleaseError =
        releaseError instanceof Error ? releaseError.message : String(releaseError);
    }
  }
}

function restoreGuardedRuntime(
  claim: Extract<GuardClaim, { found: true }>,
  manifest: GuardManifest,
  pipelineRoot: string,
  state: GuardedRuntimeState,
  options: Required<Pick<ReconcileOptions, "afterPipelineRemoval" | "recovery">>,
): Record<string, unknown> {
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

export function reconcileRuntimeStateGuard(
  workspaceRoot: string,
  options: ReconcileOptions = {},
): RuntimeGuardReconciliation {
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
    const tampered = runtimeStateWasTampered(runtimeState, recovery);
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
    }) as RuntimeGuardReconciliation;
  } catch (error) {
    releaseFailedClaim(paths, claim.path, error);
    throw error;
  }
}

export function runtimeStateGuardPath(workspaceRoot: string): string {
  return guardPaths(workspaceRoot).active;
}
