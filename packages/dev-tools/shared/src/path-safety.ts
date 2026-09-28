/**
 * Enforces workspace-relative path containment before development tools read repository files.
 */
import path from "node:path";
import { badInput } from "./errors.js";
import {
  assertSafeRelative,
  isUnsafeRelativePath,
  resolveExistingAncestor,
  resolveRoot,
  validateNonEmpty,
} from "./path-safety-helpers.js";

/**
 * Rejects traversal, absolute paths, and empty references before a tool resolves a repository path.
 */
export function assertRepoRelativePath(ref: string, label: string): void {
  const normalizedInput = validateNonEmpty(ref, label);
  assertSafeRelative(ref, path.normalize(normalizedInput), `${label} must be repository-relative`);
}

export function requireNonEmptyString(value: string, label: string): string {
  return validateNonEmpty(value, label);
}

export function isOutsideRelativePath(ref: string): boolean {
  return isUnsafeRelativePath(ref, path.normalize(ref));
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
  validateNonEmpty(workspaceRoot, rootLabel);
  const normalizedRef = validateNonEmpty(relativeRef, label);
  assertSafeRelative(relativeRef, path.normalize(normalizedRef), outOfRootMessage);

  const root = resolveRoot(workspaceRoot, rootLabel);
  const resolved = path.resolve(root, path.normalize(normalizedRef));
  const relative = path.relative(root, resolved);

  if (isOutsideResolvedRoot(relative)) {
    throw badInput(outOfRootMessage);
  }

  assertRealPathStaysWithinRoot(root, resolved, outOfRootMessage);
  return resolved;
}

export function resolveExistingRoot(workspaceRoot: string, rootLabel: string): string {
  return resolveRoot(workspaceRoot, rootLabel);
}

export function isOutsideResolvedRoot(relative: string): boolean {
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export function assertRealPathStaysWithinRoot(
  root: string,
  resolved: string,
  message: string,
): void {
  const existingAncestor = resolveExistingAncestor(resolved);
  if (isOutsideResolvedRoot(path.relative(root, existingAncestor))) throw badInput(message);
}
