import { realpathSync } from "node:fs";
import path from "node:path";
import { badInput } from "./errors.js";

export function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw badInput(`${label} must be a non-empty string`);
}

export function assertSafeRelative(ref: string, normalized: string, message: string): void {
  if (
    path.isAbsolute(ref) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized.endsWith(`${path.sep}..`)
  )
    throw badInput(message);
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
  let parent = path.dirname(ancestor);
  while (ancestor !== parent) {
    try {
      // Canonicalizing the root-confined candidate is required to detect symlink escapes.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return realpathSync(ancestor);
    } catch (err: unknown) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
      ancestor = parent;
      parent = path.dirname(ancestor);
    }
  }
  // The filesystem root is the final existing ancestor for a root-confined candidate.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return realpathSync(ancestor);
}
