/** Shared path-containment predicates used across engine layers. */
import { isAbsolute, relative, sep } from "node:path";

/**
 * Returns true when a path already expressed relative to some root stays
 * inside that root: it is not `..`, it does not start with `../`, and it is
 * not absolute (an absolute `relative()` result only arises on Windows when
 * the two paths sit on different drives).
 */
export function isContainedRelative(relation: string): boolean {
  return relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

/** Returns true when `candidate` resolves inside `root`, inclusive of the root itself. */
export function isWithinRoot(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || isContainedRelative(relation);
}
