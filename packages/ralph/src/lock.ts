/** Owns authenticated single-run locking and conservative stale-lock recovery. */
import { closeSync, fchmodSync, fstatSync, fsyncSync, readSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  mkdirAt,
  openDirectoryAt,
  openFileAt,
  openRoot,
  readDirectory,
  unlinkAt,
} from "@rae/fs-bridge";
import { EXIT, RalphError } from "./errors.js";
import type { RuntimePaths } from "./types.js";

const LOCK_NAME = Buffer.from(".run.lock");

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function readFileAt(directoryFd: number, name: Buffer): string {
  const fd = openFileAt(directoryFd, name, "read");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(128);
    let total = 0;
    for (;;) {
      const size = readSync(fd, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size;
      if (total > 4096) throw new RalphError("Ralph lock metadata is too large", EXIT.lock);
      chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function writeFileAt(directoryFd: number, name: Buffer, value: string): void {
  const fd = openFileAt(directoryFd, name, "create");
  try {
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(value);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sameIdentity(leftFd: number, rightFd: number): boolean {
  const left = fstatSync(leftFd);
  const right = fstatSync(rightFd);
  return left.dev === right.dev && left.ino === right.ino;
}

function removeLock(stateFd: number, expectedFd: number): void {
  const current = openDirectoryAt(stateFd, LOCK_NAME);
  try {
    if (!sameIdentity(current, expectedFd))
      throw new RalphError("Ralph lock changed while being reclaimed", EXIT.lock);
    for (const name of readDirectory(current)) unlinkAt(current, name, false);
    fsyncSync(current);
  } finally {
    closeSync(current);
  }
  unlinkAt(stateFd, LOCK_NAME, true);
  fsyncSync(stateFd);
}

export class RunLock {
  private readonly stateDirectory: string;
  private readonly token = randomUUID();
  private owned = false;

  public constructor(
    paths: RuntimePaths,
    private readonly staleNoPidSeconds: number,
  ) {
    this.stateDirectory = paths.stateDir;
  }

  public acquire(): void {
    const stateFd = openRoot(this.stateDirectory);
    try {
      try {
        mkdirAt(stateFd, LOCK_NAME, 0o700);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        let existing: number;
        try {
          existing = openDirectoryAt(stateFd, LOCK_NAME);
        } catch {
          throw new RalphError(
            `Ralph run lock is not a safe directory: ${this.stateDirectory}/.run.lock`,
            EXIT.lock,
          );
        }
        try {
          if (!this.reclaimable(existing))
            throw new RalphError(
              `Another Ralph run is active (lock: ${this.stateDirectory}/.run.lock)`,
              EXIT.lock,
            );
          removeLock(stateFd, existing);
        } finally {
          closeSync(existing);
        }
        try {
          mkdirAt(stateFd, LOCK_NAME, 0o700);
        } catch {
          throw new RalphError(
            `Could not acquire Ralph run lock: ${this.stateDirectory}/.run.lock`,
            EXIT.lock,
          );
        }
      }
      const lockFd = openDirectoryAt(stateFd, LOCK_NAME);
      try {
        writeFileAt(lockFd, Buffer.from("pid"), `${process.pid}\n`);
        writeFileAt(lockFd, Buffer.from("token"), `${this.token}\n`);
        fsyncSync(lockFd);
      } catch (error) {
        try {
          removeLock(stateFd, lockFd);
        } catch {
          /* retain failed lock evidence */
        }
        throw error;
      } finally {
        closeSync(lockFd);
      }
      fsyncSync(stateFd);
      this.owned = true;
    } finally {
      closeSync(stateFd);
    }
  }

  private reclaimable(lockFd: number): boolean {
    let pid: number | undefined;
    try {
      const text = readFileAt(lockFd, Buffer.from("pid")).trim();
      if (/^\d+$/u.test(text) && Number.isSafeInteger(Number(text))) pid = Number(text);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (errorCode(error) === "EPERM") return false;
      }
      return true;
    }
    const age = (Date.now() - fstatSync(lockFd).mtimeMs) / 1000;
    return age >= this.staleNoPidSeconds;
  }

  public release(): void {
    if (!this.owned) return;
    let stateFd: number | undefined;
    let lockFd: number | undefined;
    try {
      stateFd = openRoot(this.stateDirectory);
      lockFd = openDirectoryAt(stateFd, LOCK_NAME);
      if (readFileAt(lockFd, Buffer.from("token")).trim() === this.token)
        removeLock(stateFd, lockFd);
    } catch {
      /* keep a lock we cannot authenticate */
    } finally {
      if (lockFd !== undefined) closeSync(lockFd);
      if (stateFd !== undefined) closeSync(stateFd);
      this.owned = false;
    }
  }
}

export function lockState(paths: RuntimePaths): {
  held: boolean;
  status: string;
  pid: number | null;
} {
  let stateFd: number | undefined;
  let lockFd: number | undefined;
  try {
    stateFd = openRoot(paths.stateDir);
    lockFd = openDirectoryAt(stateFd, LOCK_NAME);
    let pid: number | null = null;
    try {
      const text = readFileAt(lockFd, Buffer.from("pid")).trim();
      if (/^\d+$/u.test(text) && Number.isSafeInteger(Number(text))) pid = Number(text);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return { held: true, status: `held (pid=${pid ?? "?"})`, pid };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { held: false, status: "not held", pid: null };
    return { held: true, status: "held (unreadable)", pid: null };
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (stateFd !== undefined) closeSync(stateFd);
  }
}
