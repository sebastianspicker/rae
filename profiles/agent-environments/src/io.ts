/** Anchored, no-follow profile I/O; receipts retain authorization and recovery policy. */
import { closeSync, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  openDirectoryAt,
  openFileAt,
  openLinkedFileAt,
  openParent,
  openRoot,
  renameAt,
  unlinkAt,
  type PathBytes,
} from "@rae/fs-bridge";

export interface FileState {
  exists: boolean;
  data: Buffer;
}
export const absent = (): FileState => ({ exists: false, data: Buffer.alloc(0) });
export function code(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
export function same(left: FileState, right: FileState): boolean {
  return left.exists === right.exists && left.data.equals(right.data);
}
export function readNamed(parent: number, name: PathBytes): FileState {
  let fd: number;
  try {
    fd = openLinkedFileAt(parent, name);
  } catch (error) {
    if (code(error) === "ENOENT") return absent();
    throw error;
  }
  try {
    const metadata = fstatSync(fd);
    if (process.getuid && metadata.uid !== process.getuid())
      throw new Error("Managed file is owned by another user");
    const chunks: Buffer[] = [];
    for (;;) {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      chunks.push(chunk.subarray(0, length));
    }
    return { exists: true, data: Buffer.concat(chunks) };
  } finally {
    closeSync(fd);
  }
}
export function fileState(root: number, relative: string): FileState {
  let parent: { fd: number; name: Buffer };
  try {
    parent = openParent(root, relative);
  } catch (error) {
    if (code(error) === "ENOENT") return absent();
    throw error;
  }
  try {
    return readNamed(parent.fd, parent.name);
  } finally {
    closeSync(parent.fd);
  }
}
export function writeNoClobber(parent: number, name: PathBytes, payload: Buffer): void {
  const temporary = `.profile-${randomUUID()}.new`;
  let present = false;
  try {
    const fd = openFileAt(parent, temporary, "create");
    present = true;
    try {
      let offset = 0;
      while (offset < payload.length) {
        const written = writeSync(fd, payload, offset, payload.length - offset);
        if (!written) throw new Error("Short profile write");
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameAt(parent, temporary, parent, name);
    present = false;
    fsyncSync(parent);
  } finally {
    if (present) unlinkAt(parent, temporary);
  }
}
export function writeRecovery(root: number, relative: string, payload: Buffer): void {
  const parent = openParent(root, relative, true);
  try {
    writeNoClobber(parent.fd, parent.name, payload);
  } finally {
    closeSync(parent.fd);
  }
}
export function attached(root: number, relative: string, held: number): boolean {
  try {
    const current = openParent(root, relative);
    try {
      const a = fstatSync(current.fd),
        b = fstatSync(held);
      return a.dev === b.dev && a.ino === b.ino;
    } finally {
      closeSync(current.fd);
    }
  } catch {
    return false;
  }
}
export function openTarget(path: string): number {
  const root = openRoot(path);
  try {
    if (process.getuid && fstatSync(root).uid !== process.getuid())
      throw new Error("Target is owned by another user");
    if (
      !fileState(root, "scripts/verify.sh").exists &&
      !fileState(root, "scripts/src/verify.ts").exists &&
      !fileState(root, "scripts/dist/verify.js").exists
    )
      throw new Error("Target must contain an RAE verifier");
    for (const name of [".codex", ".claude", "docs", ".rae-profile-backups"]) {
      try {
        const fd = openDirectoryAt(root, name);
        closeSync(fd);
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
    }
    return root;
  } catch (error) {
    closeSync(root);
    throw error;
  }
}

/** New installs require the Node verifier; legacy receipt recovery remains accepted by openTarget. */
export function assertNodeTarget(root: number): void {
  const source = fileState(root, "scripts/src/verify.ts");
  const compiled = fileState(root, "scripts/dist/verify.js");
  const manifest = fileState(root, "package.json");
  if ((!source.exists && !compiled.exists) || !manifest.exists)
    throw new Error("New profile installs require a Node RAE verifier and package.json");
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(manifest.data),
  );
  if (
    !value ||
    typeof value !== "object" ||
    !("scripts" in value) ||
    !value.scripts ||
    typeof value.scripts !== "object" ||
    !("verify" in value.scripts) ||
    typeof value.scripts.verify !== "string" ||
    !value.scripts.verify.trim()
  )
    throw new Error("Target package.json must define the verify command");
}
