import path from "node:path";
import { badInput } from "./errors.js";
import {
  assertSafeRelative,
  resolveExistingAncestor,
  resolveRoot,
  validateNonEmpty,
} from "./path-safety-helpers.js";

export function assertRepoRelativePath(ref: string, label: string): void {
  if (typeof ref !== "string") {
    throw badInput(`${label} must be a non-empty string`);
  }
  const normalizedInput = ref.trim();
  if (!normalizedInput) {
    throw badInput(`${label} must be a non-empty string`);
  }
  if (path.isAbsolute(normalizedInput)) {
    throw badInput(`${label} must be repository-relative`);
  }
  const normalized = path.normalize(normalizedInput);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized.endsWith(`${path.sep}..`)
  ) {
    throw badInput(`${label} must be repository-relative`);
  }
}

export function resolveWithinWorkspace(
  workspaceRoot: string,
  relativeRef: string,
  label: string,
  opts: { rootLabel?: string } = {},
): string {
  const rootLabel = opts.rootLabel ?? "workspaceRoot";
  const outOfRootMessage = `${label} must resolve within ${rootLabel}`;
  validateNonEmpty(workspaceRoot, rootLabel);
  validateNonEmpty(relativeRef, label);
  const normalizedRef = relativeRef.trim();
  const normalized = path.normalize(normalizedRef);
  assertSafeRelative(normalizedRef, normalized, outOfRootMessage);
  const root = resolveRoot(workspaceRoot, rootLabel);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw badInput(outOfRootMessage);
  }

  const ancestorReal = resolveExistingAncestor(resolved);
  const ancestorRelative = path.relative(root, ancestorReal);
  if (ancestorRelative.startsWith("..") || path.isAbsolute(ancestorRelative)) {
    throw badInput(outOfRootMessage);
  }

  return resolved;
}
