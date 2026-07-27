/**
 * Enforces workspace-relative path containment before development tools read repository files.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { badInput } from "./errors.js";

/**
 * Rejects traversal, absolute paths, and empty references before a tool resolves a repository path.
 */
export function assertRepoRelativePath(ref: string, label: string): void {
  const normalizedInput = requireNonEmptyString(ref, label);
  if (isOutsideRelativePath(normalizedInput)) {
    throw badInput(`${label} must be repository-relative`);
  }
}

export function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badInput(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function isOutsideRelativePath(ref: string): boolean {
  const normalized = path.normalize(ref);
  return (
    path.isAbsolute(ref) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized.endsWith(`${path.sep}..`)
  );
}

/**
 * Resolves a reference under a workspace after realpath checks prevent symlink escapes.
 */
export function resolveWithinWorkspace(
  workspaceRoot: string,
  relativeRef: string,
  label: string,
  opts: { rootLabel?: string } = {},
): string {
  const rootLabel = opts.rootLabel ?? "workspaceRoot";
  const outOfRootMessage = `${label} must resolve within ${rootLabel}`;
  const rootRef = requireNonEmptyString(workspaceRoot, rootLabel);
  const normalizedRef = requireNonEmptyString(relativeRef, label);
  if (isOutsideRelativePath(normalizedRef)) {
    throw badInput(outOfRootMessage);
  }

  const root = resolveExistingRoot(rootRef, rootLabel);
  const resolved = path.resolve(root, path.normalize(normalizedRef));
  const relative = path.relative(root, resolved);

  if (isOutsideResolvedRoot(relative)) {
    throw badInput(outOfRootMessage);
  }

  assertRealPathStaysWithinRoot(root, resolved, outOfRootMessage);
  return resolved;
}

export function resolveExistingRoot(workspaceRoot: string, rootLabel: string): string {
  try {
    return realpathSync(path.resolve(workspaceRoot));
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") throw badInput(`${rootLabel} does not exist`);
    throw err;
  }
}

export function isOutsideResolvedRoot(relative: string): boolean {
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function assertRealPathStaysWithinRoot(root: string, resolved: string, message: string): void {
  try {
    if (isOutsideResolvedRoot(path.relative(root, realpathSync(resolved)))) throw badInput(message);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== "ENOENT") throw err;
  }
}
