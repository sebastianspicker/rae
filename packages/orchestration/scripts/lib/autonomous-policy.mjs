/** Loads the deliberately narrow, data-only policy seam used by autonomous runs and evals. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_ORDER } from "./constants.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_AUTONOMOUS_POLICY = resolve(
  PACKAGE_ROOT,
  "policies/default.autonomous-policy.json",
);
const MAX_POLICY_BYTES = 128 * 1024;
const MAX_PHASE_GUIDANCE_BYTES = 8 * 1024;
const MAX_TOTAL_GUIDANCE_BYTES = 64 * 1024;

const ALLOWED_INPUTS = {
  arm: [],
  design: ["brief.json"],
  "adversarial-review": ["brief.json", "design.json"],
  plan: ["brief.json", "design.json", "review.json"],
  pmatch: ["brief.json", "design.json", "plan.json"],
  build: ["brief.json", "design.json", "plan.json", "drift-reports/pmatch.json"],
  "quality-static": ["brief.json", "plan.json", "build.json"],
  "quality-tests": ["brief.json", "plan.json", "build.json", "quality-reports/static.json"],
  "post-build": [
    "brief.json",
    "design.json",
    "plan.json",
    "build.json",
    "quality-reports/static.json",
    "quality-reports/tests.json",
  ],
  "release-readiness": [
    "brief.json",
    "design.json",
    "review.json",
    "plan.json",
    "drift-reports/pmatch.json",
    "build.json",
    "quality-reports/static.json",
    "quality-reports/tests.json",
    "quality-reports/post-build.json",
  ],
};

const REQUIRED_INPUTS = {
  arm: [],
  design: ["brief.json"],
  "adversarial-review": ["brief.json", "design.json"],
  plan: ["brief.json", "design.json", "review.json"],
  pmatch: ["brief.json", "plan.json"],
  build: ["plan.json", "drift-reports/pmatch.json"],
  "quality-static": ["plan.json", "build.json"],
  "quality-tests": ["plan.json", "build.json"],
  "post-build": [
    "plan.json",
    "build.json",
    "quality-reports/static.json",
    "quality-reports/tests.json",
  ],
  "release-readiness": [
    "review.json",
    "plan.json",
    "drift-reports/pmatch.json",
    "build.json",
    "quality-reports/static.json",
    "quality-reports/tests.json",
    "quality-reports/post-build.json",
  ],
};

function policyError(message) {
  throw new Error(`invalid autonomous policy: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    policyError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    policyError(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

export function policyDigest(policy) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(policy)))
    .digest("hex");
}

function validatePolicyIdentity(policy) {
  exactKeys(policy, ["schema_version", "policy_id", "phase_guidance", "phase_inputs"], "policy");
  if (policy.schema_version !== "1.0.0") policyError("schema_version must be 1.0.0");
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(policy.policy_id ?? "")) {
    policyError("policy_id must be a lowercase identifier of at most 64 characters");
  }
  exactKeys(policy.phase_guidance, PHASE_ORDER, "phase_guidance");
  exactKeys(policy.phase_inputs, PHASE_ORDER, "phase_inputs");
}

function validatePhaseInputs(phase, inputs) {
  if (!Array.isArray(inputs) || inputs.some((entry) => typeof entry !== "string")) {
    policyError(`phase_inputs.${phase} must be an array of artifact references`);
  }
  if (new Set(inputs).size !== inputs.length) {
    policyError(`phase_inputs.${phase} contains duplicate references`);
  }
  const allowed = new Set(ALLOWED_INPUTS[phase]);
  const invalid = inputs.filter((entry) => !allowed.has(entry));
  if (invalid.length > 0) {
    policyError(`phase_inputs.${phase} contains invalid references: ${invalid.join(", ")}`);
  }
  const missing = REQUIRED_INPUTS[phase].filter((entry) => !inputs.includes(entry));
  if (missing.length > 0) {
    policyError(`phase_inputs.${phase} omits required references: ${missing.join(", ")}`);
  }
}

function validatePhasePolicy(policy, phase) {
  const guidance = policy.phase_guidance[phase];
  if (typeof guidance !== "string") policyError(`phase_guidance.${phase} must be a string`);
  const guidanceBytes = Buffer.byteLength(guidance, "utf8");
  if (guidanceBytes > MAX_PHASE_GUIDANCE_BYTES) {
    policyError(`phase_guidance.${phase} exceeds ${MAX_PHASE_GUIDANCE_BYTES} bytes`);
  }
  validatePhaseInputs(phase, policy.phase_inputs[phase]);
  return guidanceBytes;
}

export function validateAutonomousPolicy(policy) {
  validatePolicyIdentity(policy);
  const totalGuidanceBytes = PHASE_ORDER.reduce(
    (total, phase) => total + validatePhasePolicy(policy, phase),
    0,
  );
  if (totalGuidanceBytes > MAX_TOTAL_GUIDANCE_BYTES) {
    policyError(`phase guidance exceeds ${MAX_TOTAL_GUIDANCE_BYTES} total bytes`);
  }
  return stableValue(policy);
}

function assertUnprotectedPolicyPath(pathValue) {
  const lower = pathValue.toLowerCase();
  const name = basename(lower);
  const segments = lower.split(sep);
  if (
    name === ".env" ||
    name.startsWith(".env.") ||
    [".key", ".pem", ".p12", ".pfx"].includes(extname(name)) ||
    ["auth.json", ".git-credentials", ".netrc", ".npmrc", ".pypirc"].includes(name) ||
    segments.some((segment) =>
      [".ssh", ".aws", ".azure", ".docker", ".gnupg", ".kube"].includes(segment),
    )
  ) {
    policyError("refusing to read a protected credential or key path");
  }
}

function assertSafePolicyPath(pathValue) {
  const supplied = resolve(pathValue);
  assertUnprotectedPolicyPath(supplied);
  const canonical = realpathSync(supplied);
  assertUnprotectedPolicyPath(canonical);
  if (extname(supplied).toLowerCase() !== ".json" || extname(canonical).toLowerCase() !== ".json") {
    policyError("policy path and canonical target must be JSON files");
  }
  if (!statSync(canonical).isFile()) policyError("policy path must resolve to a regular file");
  return canonical;
}

export function loadAutonomousPolicy(pathValue = DEFAULT_AUTONOMOUS_POLICY) {
  const policyPath = assertSafePolicyPath(pathValue);
  const size = statSync(policyPath).size;
  if (size > MAX_POLICY_BYTES) policyError(`file exceeds ${MAX_POLICY_BYTES} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    policyError(`cannot parse JSON: ${error.message}`);
  }
  const policy = validateAutonomousPolicy(parsed);
  return {
    policy,
    digest: policyDigest(policy),
    source: pathValue === DEFAULT_AUTONOMOUS_POLICY ? "default" : "provided",
  };
}
