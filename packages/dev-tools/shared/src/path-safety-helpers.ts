/** Provides shared canonical-path validation helpers for development tools. */
import { realpathSync } from "node:fs";
import path from "node:path";
import { badInput } from "./errors.js";

export function validateNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw badInput(`${label} must be a non-empty string`);
  return value.trim();
}

/** Keeps the raw-reference policy separate from normalization-sensitive traversal checks. */
export function isUnsafeRelativePath(ref: string, normalized: string): boolean {
  if (path.isAbsolute(ref)) return true;
  if (normalized === ".") return true;
  if (normalized === "..") return true;
  if (normalized.startsWith(`..${path.sep}`)) return true;
  if (normalized.includes(`${path.sep}..${path.sep}`)) return true;
  return normalized.endsWith(`${path.sep}..`);
}

export function assertSafeRelative(ref: string, normalized: string, message: string): void {
  if (isUnsafeRelativePath(ref, normalized)) throw badInput(message);
}

export function resolveRoot(root: string, label: string): string {
  try {
    // The operator-supplied workspace root must be canonicalized before confinement checks.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return realpathSync(path.resolve(root));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") throw badInput(`${label} does not exist`);
    throw err;
  }
}

export function resolveExistingAncestor(resolved: string): string {
  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    const existingPath = tryResolveExistingPath(ancestor);
    if (existingPath) return existingPath;
    ancestor = path.dirname(ancestor);
  }
  // The filesystem root is the final existing ancestor for a root-confined candidate.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return realpathSync(ancestor);
}

function tryResolveExistingPath(candidate: string): string | undefined {
  try {
    // Canonicalizing the root-confined candidate is required to detect symlink escapes.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return realpathSync(candidate);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}
