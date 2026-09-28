/** Performs confined descriptor-relative reads and atomic file replacement. */
import { closeSync, fchmodSync, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openFileAt, openParent, openRoot, renameAt, unlinkAt } from "@rae/fs-bridge";
import { safeRelativePath } from "./util.js";

export function atomicWriteRelative(
  root: string,
  relative: string,
  content: string | Buffer,
  mode = 0o600,
): void {
  const safe = safeRelativePath(relative);
  const rootFd = openRoot(root);
  let parentFd: number | undefined;
  let temporary: Buffer | undefined;
  try {
    const parent = openParent(rootFd, Buffer.from(safe), true);
    parentFd = parent.fd;
    temporary = Buffer.from(`.${process.pid}.${randomUUID()}.tmp`);
    const fd = openFileAt(parentFd, temporary, "create");
    try {
      fchmodSync(fd, mode);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameAt(parentFd, temporary, parentFd, parent.name, false);
    temporary = undefined;
    fsyncSync(parentFd);
  } finally {
    if (temporary && parentFd !== undefined) {
      try {
        unlinkAt(parentFd, temporary);
      } catch {
        /* best effort */
      }
    }
    if (parentFd !== undefined) closeSync(parentFd);
    closeSync(rootFd);
  }
}

export function readRelative(
  root: string,
  relative: string,
  limit = Number.MAX_SAFE_INTEGER,
): Buffer {
  const rootFd = openRoot(root);
  let parentFd: number | undefined;
  try {
    const parent = openParent(rootFd, Buffer.from(safeRelativePath(relative)), false);
    parentFd = parent.fd;
    const fd = openFileAt(parentFd, parent.name, "read");
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("file must be a regular non-linked file");
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, limit - total + 1));
        const size = readSync(fd, chunk, 0, chunk.length, null);
        if (size === 0) break;
        total += size;
        if (total > limit) throw new Error(`file exceeds ${limit} bytes`);
        chunks.push(chunk.subarray(0, size));
      }
      return Buffer.concat(chunks);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (parentFd !== undefined) closeSync(parentFd);
    closeSync(rootFd);
  }
}

export function appendRelative(
  root: string,
  relative: string,
  content: string | Buffer,
  mode = 0o600,
): void {
  const rootFd = openRoot(root);
  let parentFd: number | undefined;
  try {
    const parent = openParent(rootFd, Buffer.from(safeRelativePath(relative)), true);
    parentFd = parent.fd;
    let fd: number;
    try {
      fd = openFileAt(parentFd, parent.name, "append");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        fd = openFileAt(parentFd, parent.name, "create");
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
        fd = openFileAt(parentFd, parent.name, "append");
      }
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("append target must be a regular non-linked file");
      fchmodSync(fd, mode);
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncSync(parentFd);
  } finally {
    if (parentFd !== undefined) closeSync(parentFd);
    closeSync(rootFd);
  }
}
