/** Purpose: keep provider file paths outside workspace and temporary-directory write grants. */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { openDirectoryAt, openFileAt, openRoot, readDirectory, unlinkAt } from "@rae/fs-bridge";

function contained(candidate: string, root: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}
function canonicalPlannedPath(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Staging path has no existing ancestor");
    ancestor = parent;
  }
  return resolve(fs.realpathSync(ancestor), ...missing);
}
export function assertStagingOutsideWritableRoots(
  candidate: string,
  writableRoots: readonly string[],
): void {
  const path = canonicalPlannedPath(candidate);
  if (writableRoots.some((root) => contained(path, canonicalPlannedPath(root))))
    throw new Error("Hosted staging must be outside every provider-writable root");
}
function assertOwnedDirectory(fd: number, privateMode: boolean): void {
  const stat = fs.fstatSync(fd);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & (privateMode ? 0o077 : 0o022)
  )
    throw new Error("Hosted staging directories must be owned and permission protected");
}

/** The low-level constructor supports disposable fixtures; runtime callers use createHostedStaging. */
export function createPrivateStaging(home: string, writableRoots: readonly string[]) {
  const root = fs.realpathSync(home);
  const segments = [".local", "state", "rae", "hosted-attempts"];
  const base = join(root, ...segments);
  assertStagingOutsideWritableRoots(base, writableRoots);
  const descriptors: number[] = [];
  let baseFd: number;
  let attemptFd: number;
  const name = randomUUID();
  try {
    let fd = openRoot(root);
    descriptors.push(fd);
    assertOwnedDirectory(fd, false);
    for (const [index, segment] of segments.entries()) {
      fd = openDirectoryAt(fd, segment, true);
      descriptors.push(fd);
      assertOwnedDirectory(fd, index >= 2);
    }
    baseFd = fd;
    attemptFd = openDirectoryAt(baseFd, name, true);
    descriptors.push(attemptFd);
    assertOwnedDirectory(attemptFd, true);
  } catch (error) {
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
    throw error;
  }
  const path = join(base, name);
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Hosted staging is closed");
  };
  return {
    root: path,
    schemaPath: join(path, "output.schema.json"),
    outputPath: join(path, "output.json"),
    eventLogPath: join(path, "events.jsonl"),
    writeSchema(bytes: Buffer) {
      assertOpen();
      if (bytes.length > 1024 * 1024) throw new Error("Hosted schema exceeds byte limit");
      const fd = openFileAt(attemptFd, "output.schema.json", "create");
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Provider truncation preserves this private mode regardless of the worker's ambient umask.
      const outputFd = openFileAt(attemptFd, "output.json", "create");
      fs.closeSync(outputFd);
    },
    read(name: "output.json" | "events.jsonl", limit = 20 * 1024 * 1024): Buffer {
      assertOpen();
      if (
        !["output.json", "events.jsonl"].includes(name) ||
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        limit > 20 * 1024 * 1024
      )
        throw new Error("Invalid staged artifact read");
      const fd = openFileAt(attemptFd, name);
      try {
        const stat = fs.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.nlink !== 1 ||
          stat.mode & 0o077 ||
          stat.size > limit
        )
          throw new Error("Unsafe or oversized staged artifact");
        const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
        let count = 0;
        while (count < bytes.length) {
          const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
          if (!read) break;
          count += read;
        }
        const after = fs.fstatSync(fd);
        if (
          count !== stat.size ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error("Staged artifact changed during read");
        return bytes.subarray(0, count);
      } finally {
        fs.closeSync(fd);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        for (const file of readDirectory(attemptFd)) {
          try {
            unlinkAt(attemptFd, file);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
              throw error;
          }
        }
        unlinkAt(baseFd, name, true);
      } finally {
        for (const fd of descriptors.reverse()) fs.closeSync(fd);
      }
    },
  };
}
export function createHostedStaging(projectRoots: readonly string[]) {
  const roots = [
    ...projectRoots,
    tmpdir(),
    "/tmp",
    "/var/tmp",
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
  ].filter((root): root is string => !!root);
  return createPrivateStaging(userInfo().homedir, roots);
}
