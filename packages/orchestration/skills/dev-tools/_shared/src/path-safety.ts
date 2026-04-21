import { realpathSync } from "node:fs";
import path from "node:path";
import { badInput } from "./errors.js";

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
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    throw badInput(`${rootLabel} must be a non-empty string`);
  }
  if (typeof relativeRef !== "string" || relativeRef.trim().length === 0) {
    throw badInput(`${label} must be a non-empty string`);
  }
  const normalizedRef = relativeRef.trim();
  const normalized = path.normalize(normalizedRef);

  if (
    path.isAbsolute(normalizedRef) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.includes(`${path.sep}..${path.sep}`) ||
    normalized.endsWith(`${path.sep}..`)
  ) {
    throw badInput(outOfRootMessage);
  }

  let root: string;
  try {
    root = realpathSync(path.resolve(workspaceRoot));
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") {
      throw badInput(`${rootLabel} does not exist`);
    }
    throw err;
  }
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw badInput(outOfRootMessage);
  }

  try {
    const resolvedReal = realpathSync(resolved);
    const resolvedRel = path.relative(root, resolvedReal);
    if (resolvedRel.startsWith("..") || path.isAbsolute(resolvedRel)) {
      throw badInput(outOfRootMessage);
    }
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== "ENOENT") {
      throw err;
    }
  }

  return resolved;
}
