/** Provides small deterministic path, time, hashing, and atomic-write helpers. */
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { RalphError } from "./errors.js";

export function isoUtc(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isoUtcCompact(date = new Date()): string {
  return isoUtc(date).replaceAll("-", "").replaceAll(":", "").replace("T", "-");
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RalphError(`${name} must be true or false`);
}

export function uintEnv(name: string, fallback: number, minimum = 0): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < minimum || !Number.isSafeInteger(Number(value))) {
    throw new RalphError(`${name} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

export function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || normalize(path) !== path)
    throw new RalphError(`${label} must be an absolute normalized path`);
  const canonical = realpathSync.native(path);
  if (canonical !== path)
    throw new RalphError(`${label} must be canonical and must not use symlinks`);
  if (!statSync(path, { bigint: false }).isDirectory())
    throw new RalphError(`${label} is not a directory`);
  return path;
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function safeRelativePath(value: string, label = "path"): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0"))
    throw new RalphError(`${label} must be a non-empty relative path`);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new RalphError(`${label} escapes its root`);
  return normalized;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function atomicWrite(path: string, content: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(path), `.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

export function atomicJson(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value)}\n`);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function copyFileAtomic(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  copyFileSync(source, temporary, constants.COPYFILE_EXCL);
  renameSync(temporary, target);
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
