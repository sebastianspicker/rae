/** Native filesystem mechanisms; callers own authorization, journals and recovery. */
import { closeSync } from "node:fs";
import { createRequire } from "node:module";

export type PathBytes = string | Buffer;
interface NativeBridge {
  openRoot(path: PathBytes): number;
  openDirectoryAt(fd: number, name: PathBytes, create: boolean): number;
  openFileAt(fd: number, name: PathBytes, mode: number): number;
  mkdirAt(fd: number, name: PathBytes, mode: number): void;
  renameAt(
    sourceFd: number,
    source: PathBytes,
    destinationFd: number,
    destination: PathBytes,
    noReplace: boolean,
  ): void;
  unlinkAt(fd: number, name: PathBytes, directory: boolean): void;
  readDirectory(fd: number): Buffer[];
  duplicateDirectory(fd: number): number;
  readLinkAt(fd: number, name: PathBytes): Buffer;
  symlinkAt(target: PathBytes, fd: number, name: PathBytes): void;
  linkAt(sourceFd: number, source: PathBytes, destinationFd: number, destination: PathBytes): void;
}

const require = createRequire(import.meta.url);
let binding: NativeBridge | undefined;
function native(): NativeBridge {
  if (!binding) {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Native filesystem protections are unavailable on this platform");
    }
    binding = require("../build/Release/rae_fs_bridge.node") as NativeBridge;
  }
  return binding;
}

export function openRoot(path: PathBytes): number {
  return native().openRoot(path);
}
export function openDirectoryAt(fd: number, name: PathBytes, create = false): number {
  return native().openDirectoryAt(fd, name, create);
}
export function openFileAt(
  fd: number,
  name: PathBytes,
  mode: "read" | "create" | "append" = "read",
): number {
  const modes = { read: 0, create: 1, append: 2 } as const;
  if (!Object.hasOwn(modes, mode)) throw new TypeError("Invalid file mode");
  return native().openFileAt(fd, name, modes[mode]);
}
export function mkdirAt(fd: number, name: PathBytes, mode = 0o700): void {
  native().mkdirAt(fd, name, mode);
}
export function renameAt(
  sourceFd: number,
  source: PathBytes,
  destinationFd: number,
  destination: PathBytes,
  noReplace = true,
): void {
  native().renameAt(sourceFd, source, destinationFd, destination, noReplace);
}
export function unlinkAt(fd: number, name: PathBytes, directory = false): void {
  native().unlinkAt(fd, name, directory);
}
export function readDirectory(fd: number): Buffer[] {
  return native().readDirectory(fd);
}
export function readLinkAt(fd: number, name: PathBytes): Buffer {
  return native().readLinkAt(fd, name);
}
export function symlinkAt(target: PathBytes, fd: number, name: PathBytes): void {
  native().symlinkAt(target, fd, name);
}
/** Read a regular file with transaction-owned hardlink aliases. Caller validates ownership. */
export function openLinkedFileAt(fd: number, name: PathBytes): number {
  return native().openFileAt(fd, name, 3);
}
/** Create a no-clobber alias without following a source symlink. */
export function linkAt(
  sourceFd: number,
  source: PathBytes,
  destinationFd: number,
  destination: PathBytes,
): void {
  native().linkAt(sourceFd, source, destinationFd, destination);
}

/** Walk relative byte names without reopening ancestors through path-based APIs. */
export function openParent(
  rootFd: number,
  relative: PathBytes,
  create = false,
): { fd: number; name: Buffer } {
  const bytes = Buffer.isBuffer(relative) ? relative : Buffer.from(relative);
  if (bytes.includes(0)) throw new TypeError("NUL in relative path");
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index !== bytes.length && bytes[index] !== 47) continue;
    const part = bytes.subarray(start, index);
    if (!part.length || part.equals(Buffer.from(".")) || part.equals(Buffer.from(".."))) {
      throw new TypeError("Invalid relative path component");
    }
    parts.push(part);
    start = index + 1;
  }
  const name = parts.pop();
  if (!name) throw new TypeError("Empty relative path");
  // Native duplication keeps the caller's descriptor anchored to its inode.
  let fd = duplicateDirectory(rootFd);
  try {
    for (const part of parts) {
      const next = openDirectoryAt(fd, part, create);
      closeSync(fd);
      fd = next;
    }
    return { fd, name };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function duplicateDirectory(fd: number): number {
  return native().duplicateDirectory(fd);
}
