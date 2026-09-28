/** Implements journaled fixing promotion with descriptor-relative filesystem access. */
import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  openLinkedFileAt,
  openParent,
  openRoot,
  readDirectory,
  readLinkAt,
  renameAt,
  symlinkAt,
  unlinkAt,
} from "@rae/fs-bridge";
import { EXIT, RalphError, errorMessage } from "./errors.js";
import { atomicJson, canonicalDirectory, isWithin, sha256 } from "./util.js";
import type {
  Identity,
  ManifestEntry,
  RuntimePaths,
  TransactionJournal,
  TransactionOperation,
} from "./types.js";

const FORMAT = 4 as const;
const FILE_MODE = 0o7777;

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
function encoded(path: Buffer): string {
  return path.toString("base64url");
}
function decoded(value: string): Buffer {
  const path = Buffer.from(value, "base64url");
  if (
    !path.length ||
    path.includes(0) ||
    path[0] === 47 ||
    path.some((byte, index) => byte === 47 && (index === 0 || index === path.length - 1))
  )
    throw new RalphError("manifest path is invalid", EXIT.scope);
  for (const part of path.toString("binary").split("/"))
    if (part === "." || part === ".." || part === "")
      throw new RalphError("manifest path escapes the transaction root", EXIT.scope);
  return path;
}
function depth(value: string): number {
  return decoded(value).filter((byte) => byte === 47).length;
}
function under(path: Buffer, parent: Buffer): boolean {
  return (
    path.equals(parent) ||
    (path.length > parent.length &&
      path.subarray(0, parent.length).equals(parent) &&
      path[parent.length] === 47)
  );
}
function identity(fd: number): Identity {
  const stat = fstatSync(fd);
  return { device: stat.dev, inode: stat.ino };
}
function identityPath(path: string): Identity {
  const fd = openRoot(path);
  try {
    return identity(fd);
  } finally {
    closeSync(fd);
  }
}
function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readPrivateJson<T>(path: string, label: string): T {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.geteuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new RalphError(`${label} must be a private, owned, non-linked regular file`, EXIT.scope);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new RalphError(`${label} is not valid JSON: ${errorMessage(error)}`, EXIT.scope);
  }
}

function manifestPath(candidate: unknown, label: string): Buffer {
  if (!candidate || typeof candidate !== "object")
    throw new RalphError(`${label} manifest entry must be an object`, EXIT.scope);
  const entry = candidate as Partial<ManifestEntry>;
  if (typeof entry.path !== "string")
    throw new RalphError(`${label} manifest path is invalid`, EXIT.scope);
  return decoded(entry.path);
}
function validateFileEntry(entry: Partial<ManifestEntry>, label: string): void {
  if (
    !Number.isSafeInteger(entry.size) ||
    (entry.size ?? -1) < 0 ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.sha256)
  )
    throw new RalphError(`${label} file manifest entry is invalid`, EXIT.scope);
}
function validateSymlinkEntry(entry: Partial<ManifestEntry>, label: string): void {
  if (typeof entry.target !== "string")
    throw new RalphError(`${label} symlink manifest entry is invalid`, EXIT.scope);
  const target = Buffer.from(entry.target, "base64url");
  if (!target.length || target.includes(0) || target.toString("base64url") !== entry.target)
    throw new RalphError(`${label} symlink target is invalid`, EXIT.scope);
}
function validateEntryMetadata(entry: Partial<ManifestEntry>, label: string): void {
  if (
    !["dir", "file", "symlink"].includes(entry.kind ?? "") ||
    !Number.isInteger(entry.mode) ||
    (entry.mode ?? -1) < 0 ||
    (entry.mode ?? 0) > FILE_MODE
  )
    throw new RalphError(`${label} manifest entry is invalid`, EXIT.scope);
  if (entry.kind === "file") validateFileEntry(entry, label);
  if (entry.kind === "symlink") validateSymlinkEntry(entry, label);
}
function validateManifest(entries: unknown, label: string): asserts entries is ManifestEntry[] {
  if (!Array.isArray(entries))
    throw new RalphError(`${label} manifest must be an array`, EXIT.scope);
  let previous: Buffer | undefined;
  for (const candidate of entries) {
    const path = manifestPath(candidate, label);
    if (previous && Buffer.compare(previous, path) >= 0)
      throw new RalphError(`${label} manifest paths must be unique and sorted`, EXIT.scope);
    previous = path;
    validateEntryMetadata(candidate as Partial<ManifestEntry>, label);
  }
}
function validateOperationPlacement(operation: TransactionOperation): void {
  if (
    operation.placement !== undefined &&
    operation.placement !== "external" &&
    operation.placement !== "sibling"
  )
    throw new RalphError("transaction operation placement is invalid", EXIT.scope);
  if (
    operation.parent_identity !== undefined &&
    (!Number.isSafeInteger(operation.parent_identity.device) ||
      !Number.isSafeInteger(operation.parent_identity.inode))
  )
    throw new RalphError("transaction operation parent identity is invalid", EXIT.scope);
}
function validateOperationNames(operation: TransactionOperation): void {
  for (const name of [operation.quarantine, operation.staging, operation.recovery]) {
    if (name !== undefined && (!/^\.?[0-9A-Za-z-]+$/u.test(name) || name === "." || name === ".."))
      throw new RalphError("transaction operation name is invalid", EXIT.scope);
  }
}
function validateOperation(operation: TransactionOperation): void {
  if (
    !operation ||
    typeof operation.path !== "string" ||
    !["pending", "quarantining", "quarantined", "installed", "recovered", "conflict"].includes(
      operation.state,
    )
  )
    throw new RalphError("transaction operation is invalid", EXIT.scope);
  decoded(operation.path);
  validateManifest(operation.before, "operation before");
  validateManifest(operation.after, "operation after");
  validateOperationPlacement(operation);
  validateOperationNames(operation);
}
function validateJournalOperations(journal: TransactionJournal): void {
  const states = [
    "mirrored",
    "prepared",
    "applying",
    "recovering",
    "conflicted",
    "committed",
    "recovered",
  ];
  if (
    !states.includes(journal.state) ||
    !Array.isArray(journal.changed) ||
    !Array.isArray(journal.promoted) ||
    !Array.isArray(journal.evidence)
  )
    throw new RalphError("transaction journal state is invalid", EXIT.scope);
  for (const key of [...journal.changed, ...journal.promoted]) {
    if (typeof key !== "string")
      throw new RalphError("transaction changed path is invalid", EXIT.scope);
    decoded(key);
  }
  if (journal.active !== null) decoded(journal.active);
  for (const operation of journal.evidence) validateOperation(operation);
}

type EntryKind = { kind: ManifestEntry["kind"]; fd?: number; target?: Buffer };
function openKind(parentFd: number, name: Buffer): EntryKind {
  try {
    return { kind: "dir", fd: openDirectoryAt(parentFd, name) };
  } catch (error) {
    if (!["ENOTDIR", "ELOOP", "EINVAL"].includes(code(error) ?? "")) {
      if (code(error) === "ENOENT") throw error;
    }
  }
  try {
    const fd = openFileAt(parentFd, name, "read");
    if (fstatSync(fd).nlink !== 1) {
      closeSync(fd);
      throw new RalphError(`hard-linked file is not supported: ${name.toString()}`, EXIT.scope);
    }
    return { kind: "file", fd };
  } catch (error) {
    if (error instanceof RalphError) throw error;
    if (!["ELOOP", "EINVAL", "ENXIO", "EACCES", "EPERM"].includes(code(error) ?? "")) throw error;
    try {
      const linked = openLinkedFileAt(parentFd, name);
      const links = fstatSync(linked).nlink;
      closeSync(linked);
      if (links !== 1)
        throw new RalphError(`hard-linked file is not supported: ${name.toString()}`, EXIT.scope);
    } catch (linkedError) {
      if (linkedError instanceof RalphError) throw linkedError;
    }
  }
  try {
    return { kind: "symlink", target: readLinkAt(parentFd, name) };
  } catch {
    throw new RalphError(`special file is not supported: ${name.toString()}`, EXIT.scope);
  }
}

function hashFd(fd: number): { sha256: string; size: number } {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  for (;;) {
    const count = readSync(fd, buffer, 0, buffer.length, null);
    if (!count) break;
    digest.update(buffer.subarray(0, count));
    size += count;
  }
  return { sha256: digest.digest("hex"), size };
}

function manifestFromFd(rootFd: number, exclusions: Buffer[] = []): ManifestEntry[] {
  const result: ManifestEntry[] = [];
  const walk = (directoryFd: number, prefix: Buffer): void => {
    const names = readDirectory(directoryFd).sort(Buffer.compare);
    for (const name of names) {
      const path = prefix.length ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
      if (exclusions.some((excluded) => under(path, excluded))) continue;
      if (name.equals(Buffer.from(".git")))
        throw new RalphError(`nested repository is not supported: ${path.toString()}`, EXIT.scope);
      const opened = openKind(directoryFd, name);
      if (opened.kind === "dir" && opened.fd !== undefined) {
        try {
          const stat = fstatSync(opened.fd);
          result.push({ path: encoded(path), kind: "dir", mode: stat.mode & FILE_MODE });
          walk(opened.fd, path);
        } finally {
          closeSync(opened.fd);
        }
      } else if (opened.kind === "file" && opened.fd !== undefined) {
        try {
          const stat = fstatSync(opened.fd);
          const hashed = hashFd(opened.fd);
          result.push({
            path: encoded(path),
            kind: "file",
            mode: stat.mode & FILE_MODE,
            ...hashed,
          });
        } finally {
          closeSync(opened.fd);
        }
      } else {
        result.push({
          path: encoded(path),
          kind: "symlink",
          mode: 0o777,
          target: encoded(opened.target ?? Buffer.alloc(0)),
        });
      }
    }
  };
  walk(rootFd, Buffer.alloc(0));
  return result.sort((left, right) => Buffer.compare(decoded(left.path), decoded(right.path)));
}

export function makeManifest(root: string, runtime?: string): ManifestEntry[] {
  const fd = openRoot(root);
  try {
    if (runtime) {
      try {
        const candidate = openKind(fd, Buffer.from(".gitmodules"));
        if (candidate.fd !== undefined) closeSync(candidate.fd);
        throw new RalphError("Git submodules are not supported", EXIT.scope);
      } catch (error) {
        if (error instanceof RalphError) throw error;
        if (code(error) !== "ENOENT") throw error;
      }
    }
    const exclusions = runtime
      ? [Buffer.from(".git"), Buffer.from(relative(root, runtime).split(sep).join("/"))]
      : [];
    return manifestFromFd(fd, exclusions);
  } finally {
    closeSync(fd);
  }
}

function copyBytes(sourceFd: number, targetFd: number): void {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  for (;;) {
    const size = readSync(sourceFd, buffer, 0, buffer.length, null);
    if (!size) break;
    let offset = 0;
    while (offset < size) offset += writeSync(targetFd, buffer, offset, size - offset);
  }
  fsyncSync(targetFd);
}

function copyEntriesFromFds(sourceFd: number, targetFd: number, entries: ManifestEntry[]): void {
  const directories: Array<{ fd: number; mode: number }> = [];
  try {
    for (const entry of entries) {
      const path = decoded(entry.path);
      const target = openParent(targetFd, path, true);
      try {
        if (entry.kind === "dir") {
          try {
            mkdirAt(target.fd, target.name, 0o700);
          } catch (error) {
            if (code(error) !== "EEXIST") throw error;
          }
          const fd = openDirectoryAt(target.fd, target.name);
          directories.push({ fd, mode: entry.mode });
        } else if (entry.kind === "symlink") {
          symlinkAt(Buffer.from(entry.target ?? "", "base64url"), target.fd, target.name);
        } else {
          const source = openParent(sourceFd, path);
          try {
            const input = openFileAt(source.fd, source.name, "read");
            const output = openFileAt(target.fd, target.name, "create");
            try {
              copyBytes(input, output);
              fchmodSync(output, entry.mode);
            } finally {
              closeSync(input);
              closeSync(output);
            }
          } finally {
            closeSync(source.fd);
          }
        }
      } finally {
        closeSync(target.fd);
      }
    }
    for (const item of directories.reverse()) {
      try {
        fchmodSync(item.fd, item.mode);
      } finally {
        closeSync(item.fd);
      }
    }
  } catch (error) {
    for (const item of directories) {
      try {
        closeSync(item.fd);
      } catch {
        /* already closed */
      }
    }
    throw error;
  }
}

function copyEntries(sourceRoot: string, targetRoot: string, entries: ManifestEntry[]): void {
  const sourceFd = openRoot(sourceRoot);
  const targetFd = openRoot(targetRoot);
  try {
    copyEntriesFromFds(sourceFd, targetFd, entries);
  } finally {
    closeSync(sourceFd);
    closeSync(targetFd);
  }
}

function metadataRoot(): string {
  const configured =
    process.env.RALPH_TRANSACTION_METADATA_ROOT ??
    join(homedir(), ".local/state/ralph-fs-transactions");
  if (!isAbsolute(configured) || resolve(configured) !== configured)
    throw new RalphError(
      "RALPH_TRANSACTION_METADATA_ROOT must be absolute and normalized",
      EXIT.scope,
    );
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  const root = canonicalDirectory(realpathSync.native(configured), "transaction metadata root");
  const stat = statSync(root);
  if (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)
    throw new RalphError(
      "transaction metadata root must be private and owned by the current user",
      EXIT.scope,
    );
  const temporary = realpathSync.native(tmpdir());
  if (isWithin(temporary, root) || isWithin(root, temporary))
    throw new RalphError(
      "transaction metadata root overlaps a provider-writable temp root",
      EXIT.scope,
    );
  return root;
}

export function pointerPath(paths: RuntimePaths): string {
  const root = metadataRoot();
  return join(
    root,
    "pointers",
    `${sha256(`${paths.repoRoot}\0${realpathSync.native(paths.stateDir)}`)}.json`,
  );
}

function assertBound(paths: RuntimePaths, journalPath: string): TransactionJournal {
  const meta = metadataRoot();
  const expectedTransactions = join(meta, "transactions");
  if (
    !isWithin(expectedTransactions, journalPath) ||
    dirname(journalPath) === expectedTransactions ||
    basename(journalPath) !== "journal.json"
  )
    throw new RalphError("transaction journal is outside metadata root", EXIT.scope);
  const journal = readPrivateJson<TransactionJournal>(journalPath, "transaction journal");
  if (
    journal.format !== FORMAT ||
    journal.root !== paths.repoRoot ||
    journal.runtime !== realpathSync.native(paths.stateDir) ||
    journal.metadata_root !== meta
  )
    throw new RalphError("transaction journal is bound to a different repository", EXIT.scope);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(journal.id))
    throw new RalphError("transaction journal id is invalid", EXIT.scope);
  if (journal.baseline_store !== join(dirname(journalPath), "baseline"))
    throw new RalphError("transaction baseline store has an unexpected location", EXIT.scope);
  const provider = dirname(journal.mirror);
  const temporary = realpathSync.native(tmpdir());
  if (
    basename(journal.mirror) !== "workspace" ||
    !basename(provider).startsWith("ralph-fs-provider-") ||
    !isWithin(temporary, provider)
  )
    throw new RalphError("transaction mirror has an unexpected location", EXIT.scope);
  if (journal.quarantine_root !== join(journal.runtime, ".fixing-quarantine", journal.id))
    throw new RalphError("transaction quarantine has an unexpected location", EXIT.scope);
  validateManifest(journal.baseline, "baseline");
  if (journal.prepared !== null) validateManifest(journal.prepared, "prepared");
  validateJournalOperations(journal);
  for (const [actual, expected, label] of [
    [identityPath(journal.root), journal.root_identity, "repository"],
    [identityPath(journal.runtime), journal.runtime_identity, "runtime"],
    [identityPath(journal.metadata_root), journal.metadata_root_identity, "metadata root"],
    [identityPath(journal.mirror), journal.mirror_identity, "mirror"],
    [identityPath(journal.baseline_store), journal.baseline_store_identity, "baseline store"],
  ] as const) {
    if (!equal(actual, expected)) throw new RalphError(`${label} identity changed`, EXIT.scope);
  }
  if (!equal(makeManifest(journal.baseline_store), journal.baseline))
    throw new RalphError("transaction baseline store does not match its manifest", EXIT.scope);
  return journal;
}

function writeJournal(path: string, journal: TransactionJournal): void {
  atomicJson(path, journal);
}

export function beginTransaction(paths: RuntimePaths): { journalPath: string; workspace: string } {
  const meta = metadataRoot();
  const pointer = pointerPath(paths);
  if (statOptional(pointer)) throw new RalphError("transaction pointer already exists", EXIT.scope);
  const txnParent = join(meta, "transactions");
  const pointerParent = join(meta, "pointers");
  mkdirSync(txnParent, { recursive: true, mode: 0o700 });
  mkdirSync(pointerParent, { recursive: true, mode: 0o700 });
  const transactionDir = realpathSync.native(mkdtempSync(join(txnParent, "txn-")));
  const providerDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-fs-provider-")));
  const mirror = join(providerDir, "workspace");
  const baselineStore = join(transactionDir, "baseline");
  mkdirSync(mirror, { mode: 0o700 });
  mkdirSync(baselineStore, { mode: 0o700 });
  const runtime = realpathSync.native(paths.stateDir);
  try {
    const baseline = makeManifest(paths.repoRoot, runtime);
    copyEntries(paths.repoRoot, baselineStore, baseline);
    copyEntries(paths.repoRoot, mirror, baseline);
    const id = randomUUID();
    const journal: TransactionJournal = {
      format: FORMAT,
      id,
      state: "mirrored",
      root: paths.repoRoot,
      runtime,
      metadata_root: meta,
      mirror,
      baseline_store: baselineStore,
      quarantine_root: join(runtime, ".fixing-quarantine", id),
      root_identity: identityPath(paths.repoRoot),
      runtime_identity: identityPath(runtime),
      metadata_root_identity: identityPath(meta),
      mirror_identity: identityPath(mirror),
      baseline_store_identity: identityPath(baselineStore),
      baseline,
      prepared: null,
      changed: [],
      promoted: [],
      active: null,
      active_started: false,
      evidence: [],
    };
    const journalPath = join(transactionDir, "journal.json");
    writeJournal(journalPath, journal);
    atomicJson(pointer, {
      format: FORMAT,
      id,
      root: paths.repoRoot,
      runtime,
      metadata_root: meta,
      journal: journalPath,
    });
    return { journalPath, workspace: mirror };
  } catch (error) {
    rmSync(transactionDir, { recursive: true, force: true });
    rmSync(providerDir, { recursive: true, force: true });
    throw error;
  }
}

function statOptional(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}
function maps(entries: ManifestEntry[]): Map<string, ManifestEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}
function changed(before: ManifestEntry[], after: ManifestEntry[]): string[] {
  const left = maps(before);
  const right = maps(after);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => !equal(left.get(key), right.get(key)))
    .sort((a, b) => Buffer.compare(decoded(a), decoded(b)));
}
function subtree(entries: ManifestEntry[], root: string): ManifestEntry[] {
  const rel = decoded(root);
  return entries.filter((entry) => under(decoded(entry.path), rel));
}
function parentKey(key: string): string | undefined {
  const path = decoded(key);
  const slash = path.lastIndexOf(47);
  return slash < 0 ? undefined : encoded(path.subarray(0, slash));
}
function collapseRoots(keys: string[]): string[] {
  return keys.filter(
    (key) => !keys.some((parent) => parent !== key && under(decoded(key), decoded(parent))),
  );
}
function entryRoots(journal: TransactionJournal): string[] {
  const baseline = maps(journal.baseline);
  const prepared = maps(journal.prepared ?? []);
  const structural = journal.changed.filter((key) => {
    const before = baseline.get(key);
    const after = prepared.get(key);
    return before?.kind === "dir" || after?.kind === "dir";
  });
  const initial = collapseRoots(
    journal.changed.filter(
      (key) => !structural.some((parent) => parent !== key && under(decoded(key), decoded(parent))),
    ),
  );
  const widened = initial.map((key) => {
    let root = key;
    for (;;) {
      const parent = parentKey(root);
      if (!parent) break;
      const before = baseline.get(parent);
      const after = prepared.get(parent);
      const readonlyParent = [before, after].some(
        (entry) => entry?.kind === "dir" && (entry.mode & 0o200) === 0,
      );
      if (!readonlyParent) break;
      root = parent;
    }
    return root;
  });
  return collapseRoots([...new Set(widened)]);
}

export function transactionDiff(paths: RuntimePaths, journalPath: string): string[] {
  const journal = assertBound(paths, journalPath);
  const current = makeManifest(journal.mirror);
  return changed(journal.baseline, current)
    .filter((key) => {
      const item = maps(journal.baseline).get(key) ?? maps(current).get(key);
      if (item?.kind !== "dir") return true;
      return !changed(journal.baseline, current).some(
        (other) => other !== key && under(decoded(other), decoded(key)),
      );
    })
    .map((key) => decoded(key).toString());
}

export function prepareTransaction(paths: RuntimePaths, journalPath: string): void {
  const journal = assertBound(paths, journalPath);
  if (journal.state !== "mirrored")
    throw new RalphError("transaction is not ready for preparation", EXIT.scope);
  journal.prepared = makeManifest(journal.mirror);
  journal.changed = changed(journal.baseline, journal.prepared);
  journal.state = "prepared";
  writeJournal(journalPath, journal);
}

function manifestAt(root: string, path: string): ManifestEntry[] {
  const full = decoded(path);
  const fd = openRoot(root);
  try {
    const parent = openParent(fd, full);
    try {
      let opened: EntryKind;
      try {
        opened = openKind(parent.fd, parent.name);
      } catch (error) {
        if (code(error) === "ENOENT") return [];
        throw error;
      }
      if (opened.kind === "dir" && opened.fd !== undefined) {
        try {
          const stat = fstatSync(opened.fd);
          const base: ManifestEntry = { path, kind: "dir", mode: stat.mode & FILE_MODE };
          return [
            base,
            ...manifestFromFd(opened.fd).map((item) => ({
              ...item,
              path: encoded(Buffer.concat([full, Buffer.from("/"), decoded(item.path)])),
            })),
          ];
        } finally {
          closeSync(opened.fd);
        }
      }
      if (opened.kind === "file" && opened.fd !== undefined) {
        try {
          const stat = fstatSync(opened.fd);
          return [{ path, kind: "file", mode: stat.mode & FILE_MODE, ...hashFd(opened.fd) }];
        } finally {
          closeSync(opened.fd);
        }
      }
      return [
        { path, kind: "symlink", mode: 0o777, target: encoded(opened.target ?? Buffer.alloc(0)) },
      ];
    } finally {
      closeSync(parent.fd);
    }
  } finally {
    closeSync(fd);
  }
}

export function verifyTransaction(paths: RuntimePaths, journalPath: string): string[] {
  const journal = assertBound(paths, journalPath);
  if (journal.state !== "prepared" || !journal.prepared)
    throw new RalphError("transaction has not been prepared", EXIT.scope);
  if (!equal(makeManifest(journal.mirror), journal.prepared))
    throw new RalphError("transaction workspace changed after preparation", EXIT.scope);
  return entryRoots(journal)
    .filter((key) => !equal(manifestAt(journal.root, key), subtree(journal.baseline, key)))
    .map((key) => decoded(key).toString());
}

function copySubtreeToFd(
  journal: TransactionJournal,
  key: string,
  targetFd: number,
  stagingName: string,
): void {
  const entries = subtree(journal.prepared ?? [], key);
  if (!entries.length) return;
  const keyBytes = decoded(key);
  const rootEntry = entries[0];
  if (!rootEntry) return;
  const mirrorFd = openRoot(journal.mirror);
  try {
    if (rootEntry.kind === "dir") {
      mkdirAt(targetFd, Buffer.from(stagingName), 0o700);
      const stageFd = openDirectoryAt(targetFd, Buffer.from(stagingName));
      try {
        const descendants = entries.slice(1).map((entry) => ({
          ...entry,
          path: encoded(decoded(entry.path).subarray(keyBytes.length + 1)),
        }));
        const mirrorParent = openParent(mirrorFd, keyBytes);
        try {
          const sourceDirFd = openDirectoryAt(mirrorParent.fd, mirrorParent.name);
          try {
            copyEntriesFromFds(sourceDirFd, stageFd, descendants);
          } finally {
            closeSync(sourceDirFd);
          }
        } finally {
          closeSync(mirrorParent.fd);
        }
      } finally {
        closeSync(stageFd);
      }
    } else if (rootEntry.kind === "symlink")
      symlinkAt(
        Buffer.from(rootEntry.target ?? "", "base64url"),
        targetFd,
        Buffer.from(stagingName),
      );
    else {
      const source = openParent(mirrorFd, keyBytes);
      try {
        const input = openFileAt(source.fd, source.name, "read");
        const output = openFileAt(targetFd, Buffer.from(stagingName), "create");
        try {
          copyBytes(input, output);
          fchmodSync(output, rootEntry.mode);
        } finally {
          closeSync(input);
          closeSync(output);
        }
      } finally {
        closeSync(source.fd);
      }
    }
  } finally {
    closeSync(mirrorFd);
  }
}

function siblingKey(key: string, name: string): string {
  const path = decoded(key);
  const slash = path.lastIndexOf(47);
  const parent = slash < 0 ? Buffer.alloc(0) : path.subarray(0, slash);
  return encoded(
    parent.length
      ? Buffer.concat([parent, Buffer.from("/"), Buffer.from(name)])
      : Buffer.from(name),
  );
}

function remapSubtree(entries: ManifestEntry[], from: string, to: string): ManifestEntry[] {
  const source = decoded(from);
  const target = decoded(to);
  return entries.map((entry) => ({
    ...entry,
    path:
      entry.path === from
        ? to
        : encoded(Buffer.concat([target, decoded(entry.path).subarray(source.length)])),
  }));
}

function entryExistsAt(parentFd: number, name: string): boolean {
  try {
    const opened = openKind(parentFd, Buffer.from(name));
    if (opened.fd !== undefined) closeSync(opened.fd);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

function removeEntryAt(parentFd: number, name: Buffer): void {
  let directory: number;
  try {
    directory = openDirectoryAt(parentFd, name);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    if (["ENOTDIR", "ELOOP", "EINVAL"].includes(code(error) ?? "")) {
      unlinkAt(parentFd, name, false);
      return;
    }
    throw error;
  }
  try {
    fchmodSync(directory, 0o700);
    for (const child of readDirectory(directory)) removeEntryAt(directory, child);
  } finally {
    closeSync(directory);
  }
  unlinkAt(parentFd, name, true);
}

function persistOperation(
  journalPath: string,
  journal: TransactionJournal,
  operation: TransactionOperation,
): void {
  journal.active = operation.path;
  journal.active_started = operation.state !== "pending";
  writeJournal(journalPath, journal);
}

function promoteOne(journalPath: string, journal: TransactionJournal, key: string): void {
  const before = subtree(journal.baseline, key);
  const after = subtree(journal.prepared ?? [], key);
  const token = randomUUID();
  const operation: TransactionOperation = { path: key, before, after, state: "pending" };
  journal.evidence.push(operation);
  persistOperation(journalPath, journal, operation);
  mkdirSync(journal.quarantine_root, { recursive: true, mode: 0o700 });
  const rootFd = openRoot(journal.root);
  const quarantineFd = openRoot(journal.quarantine_root);
  try {
    const live = openParent(rootFd, decoded(key), after.length > 0);
    try {
      const directoryRoot = before[0]?.kind === "dir" || after[0]?.kind === "dir";
      operation.placement = directoryRoot ? "sibling" : "external";
      operation.parent_identity = identity(live.fd);
      const storageFd = directoryRoot ? live.fd : quarantineFd;
      if (after.length) {
        operation.staging = directoryRoot ? `.ralph-${token}-staging` : `${token}-staging`;
        persistOperation(journalPath, journal, operation);
        copySubtreeToFd(journal, key, storageFd, operation.staging);
        if (after[0]?.kind === "dir") {
          const staged = openDirectoryAt(storageFd, Buffer.from(operation.staging));
          try {
            fchmodSync(staged, after[0].mode);
          } finally {
            closeSync(staged);
          }
        }
        fsyncSync(storageFd);
      }
      persistOperation(journalPath, journal, operation);
      if (before.length) {
        operation.quarantine = directoryRoot ? `.ralph-${token}-baseline` : `${token}-baseline`;
        operation.state = "quarantining";
        persistOperation(journalPath, journal, operation);
        try {
          renameAt(live.fd, live.name, storageFd, Buffer.from(operation.quarantine), true);
          fsyncSync(live.fd);
          if (storageFd !== live.fd) fsyncSync(storageFd);
        } catch (error) {
          operation.state = "conflict";
          persistOperation(journalPath, journal, operation);
          throw new RalphError(
            `live checkout changed during promotion: ${decoded(key).toString()}: ${errorMessage(error)}`,
            EXIT.scope,
          );
        }
        operation.state = "quarantined";
        persistOperation(journalPath, journal, operation);
        const backupRoot = directoryRoot ? journal.root : journal.quarantine_root;
        const backupKey = directoryRoot
          ? siblingKey(key, operation.quarantine)
          : encoded(Buffer.from(operation.quarantine));
        if (!equal(manifestAt(backupRoot, backupKey), remapSubtree(before, key, backupKey))) {
          try {
            renameAt(storageFd, Buffer.from(operation.quarantine), live.fd, live.name, true);
            fsyncSync(live.fd);
            operation.state = "conflict";
            persistOperation(journalPath, journal, operation);
          } catch {
            operation.state = "conflict";
            persistOperation(journalPath, journal, operation);
          }
          throw new RalphError(
            `live checkout changed during promotion: ${decoded(key).toString()}`,
            EXIT.scope,
          );
        }
      }
      if (after.length && operation.staging) {
        try {
          renameAt(storageFd, Buffer.from(operation.staging), live.fd, live.name, true);
          fsyncSync(live.fd);
        } catch (error) {
          operation.state = "conflict";
          persistOperation(journalPath, journal, operation);
          throw new RalphError(
            `live checkout changed during promotion install: ${decoded(key).toString()}: ${errorMessage(error)}`,
            EXIT.scope,
          );
        }
        const rootEntry = after[0];
        if (rootEntry?.kind === "dir") {
          const installed = openDirectoryAt(live.fd, live.name);
          try {
            fchmodSync(installed, rootEntry.mode);
          } finally {
            closeSync(installed);
          }
        }
      }
      operation.state = "installed";
      journal.promoted.push(key);
      journal.active = null;
      journal.active_started = false;
      writeJournal(journalPath, journal);
    } finally {
      closeSync(live.fd);
    }
  } finally {
    closeSync(rootFd);
    closeSync(quarantineFd);
  }
}

function cleanup(paths: RuntimePaths, journalPath: string, journal: TransactionJournal): void {
  const pointer = pointerPath(paths);
  const rootFd = openRoot(journal.root);
  try {
    for (const operation of journal.evidence) {
      if (operation.placement !== "sibling") continue;
      const parent = openParent(rootFd, decoded(operation.path), false);
      try {
        if (operation.parent_identity && !equal(identity(parent.fd), operation.parent_identity))
          throw new RalphError("transaction operation parent identity changed", EXIT.scope);
        for (const name of [operation.staging, operation.quarantine, operation.recovery])
          if (name) removeEntryAt(parent.fd, Buffer.from(name));
        fsyncSync(parent.fd);
      } finally {
        closeSync(parent.fd);
      }
    }
  } finally {
    closeSync(rootFd);
  }
  const pointerParent = openRoot(dirname(pointer));
  try {
    unlinkAt(pointerParent, Buffer.from(basename(pointer)), false);
    fsyncSync(pointerParent);
  } finally {
    closeSync(pointerParent);
  }
  makeDirectoriesWritable(journal.mirror);
  makeDirectoriesWritable(journal.quarantine_root);
  makeDirectoriesWritable(journal.baseline_store);
  rmSync(dirname(journal.mirror), { recursive: true, force: true });
  rmSync(journal.quarantine_root, { recursive: true, force: true });
  rmSync(dirname(journalPath), { recursive: true, force: true });
}

function makeDirectoriesWritable(root: string): void {
  let rootFd: number;
  try {
    rootFd = openRoot(root);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
  const walk = (fd: number): void => {
    for (const name of readDirectory(fd)) {
      let child: number;
      try {
        child = openDirectoryAt(fd, name);
      } catch {
        continue;
      }
      try {
        fchmodSync(child, 0o700);
        walk(child);
      } finally {
        closeSync(child);
      }
    }
  };
  try {
    fchmodSync(rootFd, 0o700);
    walk(rootFd);
  } finally {
    closeSync(rootFd);
  }
}

export function promoteTransaction(paths: RuntimePaths, journalPath: string): void {
  const journal = assertBound(paths, journalPath);
  const drift = verifyTransaction(paths, journalPath);
  if (drift.length)
    throw new RalphError(`live checkout drifted at: ${drift.join(", ")}`, EXIT.scope);
  journal.state = "applying";
  writeJournal(journalPath, journal);
  for (const key of entryRoots(journal).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)))
    promoteOne(journalPath, journal, key);
  journal.state = "committed";
  journal.active = null;
  journal.active_started = false;
  writeJournal(journalPath, journal);
  cleanup(paths, journalPath, journal);
}

function restoreOperation(
  journalPath: string,
  journal: TransactionJournal,
  operation: TransactionOperation,
): boolean {
  const current = manifestAt(journal.root, operation.path);
  const rootFd = openRoot(journal.root);
  const quarantineFd = openRoot(journal.quarantine_root);
  try {
    const live = openParent(rootFd, decoded(operation.path), true);
    try {
      if (operation.parent_identity && !equal(identity(live.fd), operation.parent_identity)) {
        operation.state = "conflict";
        persistOperation(journalPath, journal, operation);
        return false;
      }
      const sibling = operation.placement === "sibling";
      const storageFd = sibling ? live.fd : quarantineFd;
      const backupExists = operation.quarantine
        ? entryExistsAt(storageFd, operation.quarantine)
        : false;
      if (equal(current, operation.before) && !backupExists && operation.recovery) {
        operation.state = "recovered";
        journal.active = null;
        journal.active_started = false;
        writeJournal(journalPath, journal);
        return true;
      }
      if (
        operation.state === "quarantining" &&
        equal(current, operation.before) &&
        (!operation.quarantine || !entryExistsAt(storageFd, operation.quarantine))
      ) {
        operation.state = "recovered";
        journal.active = null;
        journal.active_started = false;
        writeJournal(journalPath, journal);
        return true;
      }
      if (current.length && !equal(current, operation.after)) {
        operation.state = "conflict";
        persistOperation(journalPath, journal, operation);
        return false;
      }
      if (current.length) {
        operation.recovery = sibling
          ? `.ralph-${randomUUID()}-recovery`
          : `${randomUUID()}-recovery`;
        persistOperation(journalPath, journal, operation);
        const removed = Buffer.from(operation.recovery);
        try {
          renameAt(live.fd, live.name, storageFd, removed, true);
          fsyncSync(live.fd);
        } catch {
          operation.state = "conflict";
          persistOperation(journalPath, journal, operation);
          return false;
        }
      }
      if (operation.before.length && operation.quarantine) {
        try {
          renameAt(storageFd, Buffer.from(operation.quarantine), live.fd, live.name, true);
          fsyncSync(live.fd);
        } catch {
          operation.state = "conflict";
          persistOperation(journalPath, journal, operation);
          return false;
        }
      }
      operation.state = "recovered";
      journal.active = null;
      journal.active_started = false;
      writeJournal(journalPath, journal);
      return true;
    } finally {
      closeSync(live.fd);
    }
  } finally {
    closeSync(rootFd);
    closeSync(quarantineFd);
  }
}

export function recoverTransaction(paths: RuntimePaths): void {
  const pointer = pointerPath(paths);
  if (!statOptional(pointer)) return;
  const data = readPrivateJson<{ format: number; journal: string; root: string; runtime: string }>(
    pointer,
    "transaction pointer",
  );
  if (
    data.format !== FORMAT ||
    data.root !== paths.repoRoot ||
    data.runtime !== realpathSync.native(paths.stateDir)
  )
    throw new RalphError("transaction pointer is bound to a different repository", EXIT.scope);
  if (!statOptional(data.journal)) {
    rmSync(pointer, { force: true });
    return;
  }
  const journal = assertBound(paths, data.journal);
  if (["applying", "recovering", "conflicted"].includes(journal.state)) {
    journal.state = "recovering";
    writeJournal(data.journal, journal);
    let okay = true;
    for (const operation of [...journal.evidence].reverse())
      if (["quarantining", "quarantined", "installed", "conflict"].includes(operation.state))
        okay = restoreOperation(data.journal, journal, operation) && okay;
    if (!okay) {
      journal.state = "conflicted";
      writeJournal(data.journal, journal);
      throw new RalphError(
        "Could not recover interrupted fixing transaction due concurrent live changes",
        EXIT.scope,
      );
    }
    journal.state = "recovered";
    writeJournal(data.journal, journal);
  }
  cleanup(paths, data.journal, journal);
}

export function discardTransaction(paths: RuntimePaths, journalPath: string): void {
  const journal = assertBound(paths, journalPath);
  if (["applying", "recovering", "conflicted"].includes(journal.state)) {
    recoverTransaction(paths);
    return;
  }
  cleanup(paths, journalPath, journal);
}

export function transactionForTests(paths: RuntimePaths): {
  begin: () => { journalPath: string; workspace: string };
  prepare: (path: string) => void;
  verify: (path: string) => string[];
  promote: (path: string) => void;
  recover: () => void;
  discard: (path: string) => void;
} {
  return {
    begin: () => beginTransaction(paths),
    prepare: (path) => prepareTransaction(paths, path),
    verify: (path) => verifyTransaction(paths, path),
    promote: (path) => promoteTransaction(paths, path),
    recover: () => recoverTransaction(paths),
    discard: (path) => discardTransaction(paths, path),
  };
}
