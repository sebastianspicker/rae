/** Validates and snapshots operator-owned mappings from logical workflow tiers to Codex settings. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson } from "./workflow-contract.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const SCHEMA_PATH = resolve(PACKAGE_ROOT, "contracts/workflows/execution-profile-v1.schema.json");
const MAX_PROFILE_BYTES = 64 * 1024;
const validator = new Ajv2020({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(SCHEMA_PATH, "utf8")),
);

export function executionProfileDigest(profile) {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

export function validateExecutionProfile(value) {
  const profile = structuredClone(value);
  if (!validator(profile)) {
    const detail = validator.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid execution profile: ${detail}`);
  }
  return profile;
}

export function loadExecutionProfile(pathValue) {
  const supplied = resolve(pathValue);
  const stat = lstatSync(supplied);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("execution profile path must be a regular non-symlink file");
  if (stat.size > MAX_PROFILE_BYTES)
    throw new Error(`execution profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  if (realpathSync(supplied) !== supplied)
    throw new Error("execution profile path must not traverse symlinks");
  const profile = validateExecutionProfile(JSON.parse(readFileSync(supplied, "utf8")));
  return Object.freeze({ profile, digest: executionProfileDigest(profile), source: supplied });
}

export function resolveExecutionTier(profile, tier = "standard") {
  if (!profile) return { tier: "runtime", model: null, reasoning_effort: null };
  const mapping = profile.tiers[tier];
  if (!mapping) throw new Error(`execution profile does not define logical tier ${tier}`);
  return Object.freeze({ tier, ...mapping });
}
