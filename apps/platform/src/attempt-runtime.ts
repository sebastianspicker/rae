/** Purpose: anchor hosted attempt bootstrap writes to private no-follow directory descriptors. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDirectoryAt, openFileAt, openRoot, renameAt, unlinkAt } from "@rae/fs-bridge";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
interface Identity {
  dev: number;
  ino: number;
}
interface DirectorySnapshot extends Identity {
  directory: string;
  requirePrivate: boolean;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function inspectDescriptor(
  fd: number,
  directory: string,
  requirePrivate: boolean,
): DirectorySnapshot {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory())
    throw new Error(`hosted runtime path must be a non-symlink directory: ${directory}`);
  if (requirePrivate && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    throw new Error(`hosted runtime directory must be owner-only: ${directory}`);
  }
  return { directory, dev: stat.dev, ino: stat.ino, requirePrivate };
}
function inspectSchema(fd: number): Identity {
  const stat = fs.fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("hosted runtime schema must be an owner-only non-symlink file");
  }
  return stat;
}

/** Bootstrap uses anchored descriptors; the assertion rejects replacement before worker handoff. */
export function prepareHostedAttempt(
  projectRoot: string,
  runId: string,
  attemptId: string,
  outputSchema: Record<string, unknown>,
) {
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(attemptId))
    throw new Error("hosted runtime run and attempt identifiers are invalid");
  const root = fs.realpathSync(projectRoot);
  const schemaBytes = Buffer.from(`${JSON.stringify(outputSchema)}\n`);
  if (schemaBytes.length > MAX_SCHEMA_BYTES)
    throw new Error("hosted output schema exceeds byte limit");
  const schemaDigest = createHash("sha256").update(schemaBytes).digest("hex");
  const descriptors: number[] = [];
  const directories: DirectorySnapshot[] = [];
  const segments = [".pipeline", "hosted-worker", runId, attemptId];
  let schema: Identity;
  let current = root;
  try {
    let fd = openRoot(root);
    descriptors.push(fd);
    directories.push(inspectDescriptor(fd, root, false));
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        fd = openDirectoryAt(fd, segment, true);
      } catch (error) {
        throw new Error(`hosted runtime path must be a non-symlink directory: ${current}`, {
          cause: error,
        });
      }
      descriptors.push(fd);
      directories.push(inspectDescriptor(fd, current, true));
    }
    let schemaFd: number;
    try {
      schemaFd = openFileAt(fd, "output.schema.json", "create");
    } catch (error) {
      throw new Error("hosted runtime schema already exists or is unsafe", { cause: error });
    }
    try {
      fs.writeFileSync(schemaFd, schemaBytes);
      fs.fsyncSync(schemaFd);
      schema = inspectSchema(schemaFd);
    } finally {
      fs.closeSync(schemaFd);
    }
  } finally {
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
  const schemaPath = path.join(current, "output.schema.json");
  const withIntactAttempt = (action: (fd: number) => void) => {
    const opened: number[] = [];
    try {
      let fd = openRoot(root);
      opened.push(fd);
      const first = directories[0];
      if (!first || !sameIdentity(first, inspectDescriptor(fd, root, false)))
        throw new Error("hosted runtime root changed during claim setup");
      for (const [index, segment] of segments.entries()) {
        try {
          fd = openDirectoryAt(fd, segment);
        } catch (error) {
          throw new Error("hosted runtime directory changed or is a non-symlink violation", {
            cause: error,
          });
        }
        opened.push(fd);
        const snapshot = directories[index + 1];
        if (!snapshot || !sameIdentity(snapshot, inspectDescriptor(fd, snapshot.directory, true)))
          throw new Error("hosted runtime directory changed during claim setup");
      }
      const schemaFd = openFileAt(fd, "output.schema.json");
      opened.push(schemaFd);
      if (!sameIdentity(schema, inspectSchema(schemaFd)))
        throw new Error("hosted runtime schema changed during claim setup");
      const bytes = Buffer.alloc(schemaBytes.length + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(schemaFd, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      if (
        count !== schemaBytes.length ||
        createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== schemaDigest ||
        fs.fstatSync(schemaFd).size !== schemaBytes.length
      )
        throw new Error("hosted runtime schema content changed during claim setup");
      action(fd);
    } finally {
      for (const fd of opened.reverse()) fs.closeSync(fd);
    }
  };
  const assertIntact = () => withIntactAttempt(() => {});
  const publishArtifact = (name: "output.json" | "events.jsonl", bytes: Buffer) => {
    if (!["output.json", "events.jsonl"].includes(name) || bytes.length > MAX_ARTIFACT_BYTES)
      throw new Error("invalid hosted artifact name or byte limit");
    withIntactAttempt((directoryFd) => {
      const temporary = `.${name}-${randomUUID()}.tmp`;
      const fileFd = openFileAt(directoryFd, temporary, "create");
      let staged = true;
      try {
        try {
          fs.writeFileSync(fileFd, bytes);
          fs.fsyncSync(fileFd);
        } finally {
          fs.closeSync(fileFd);
        }
        renameAt(directoryFd, temporary, directoryFd, name, true);
        staged = false;
        fs.fsyncSync(directoryFd);
      } finally {
        if (staged) unlinkAt(directoryFd, temporary);
      }
    });
    assertIntact();
  };
  assertIntact();
  return Object.freeze({ attemptRoot: current, schemaPath, assertIntact, publishArtifact });
}
