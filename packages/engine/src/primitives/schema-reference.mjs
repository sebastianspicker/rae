/** Maps persisted pre-v1 contract references onto the versioned contract package. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./installation-paths.mjs";

const LEGACY_CONTRACT_PREFIX = "contracts/";
const VERSIONED_CONTRACT_PREFIX = "packages/contracts/v1/schemas/";

export function currentSchemaReference(reference) {
  if (!reference.startsWith(LEGACY_CONTRACT_PREFIX)) return reference;
  const candidate = `${VERSIONED_CONTRACT_PREFIX}${reference.slice(LEGACY_CONTRACT_PREFIX.length)}`;
  return existsSync(resolve(repositoryRoot, candidate)) ? candidate : reference;
}
