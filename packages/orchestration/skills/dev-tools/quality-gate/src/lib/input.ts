/**
 * Validates quality-gate input and rejects unsupported criteria before evaluation.
 */
import { badInput } from "@coding-agents-space/shared";
import type { Input } from "../types.js";
import { isGatePhase } from "./phases.js";

const CRITERION_TYPES = new Set([
  "field-exists",
  "field-empty",
  "count-min",
  "count-max",
  "number-max",
  "coverage-min",
  "regex-match",
]);

/**
 * Rejects malformed or unsupported gate requests before criteria and schemas are evaluated.
 */
export function validateInput(input: Input): void {
  validateGateRequest(input);
  input.criteria.forEach(validateCriterion);
}

export function validateGateRequest(input: Input): void {
  assertArtifact(input.artifact);
  assertCriterionText(input.schema_ref, "schema_ref is required");
  assertOptionalArtifactRef(input.artifact_ref);
  assertGatePhase(input.phase);
  assertCriteria(input.criteria);
}

export function assertArtifact(artifact: unknown): void {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw badInput("artifact must be a JSON object");
}

export function assertOptionalArtifactRef(artifactRef: unknown): void {
  if (artifactRef !== undefined && typeof artifactRef !== "string") throw badInput("artifact_ref must be a string when provided");
}

export function assertGatePhase(phase: unknown): void {
  if (!isGatePhase(phase)) throw badInput("phase must be a valid pipeline phase");
}

export function assertCriteria(criteria: unknown): void {
  if (!Array.isArray(criteria)) throw badInput("criteria must be an array");
}

export function validateCriterion(c: Input["criteria"][number]): void {
  assertCriterionText(c.name, "Each criterion must have a name");
  assertCriterionText(c.type, "Each criterion must have a type");
  if (!CRITERION_TYPES.has(c.type)) throw badInput("Each criterion type must be one of: field-exists, field-empty, count-min, count-max, number-max, coverage-min, regex-match");
  assertCriterionText(c.path, "Each criterion must have a path");
  validateCriterionValue(c);
}

export function assertCriterionText(value: unknown, message: string): void {
  if (typeof value !== "string" || value.length === 0) throw badInput(message);
}

export function validateCriterionValue(c: Input["criteria"][number]): void {
  if (c.type === "count-min" || c.type === "count-max") return validateNonNegativeInteger(c.value, `${c.type} criterion requires a non-negative integer value`);
  if (c.type === "number-max") return validateNonNegativeNumber(c.value, "number-max criterion requires a non-negative number value");
  if (c.type === "coverage-min") return validateCoverageCriterion(c);
  if (c.type === "regex-match") assertCriterionText(c.value, "regex-match criterion requires non-empty string value");
}

export function validateNonNegativeInteger(value: unknown, message: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw badInput(message);
}

export function validateNonNegativeNumber(value: unknown, message: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw badInput(message);
}

export function validateCoverageCriterion(c: Input["criteria"][number]): void {
  validateCoverageValue(c.value);
  validateCoveragePaths(c);
}

export function validateCoverageValue(value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw badInput("coverage-min criterion requires a value between 0 and 1");
}

export function validateCoveragePaths(c: Input["criteria"][number]): void {
  assertCriterionText(c.source_path, "coverage-min criterion requires source_path");
  if (!Array.isArray(c.target_paths) || c.target_paths.length === 0) throw badInput("coverage-min criterion requires non-empty target_paths");
  c.target_paths.forEach((targetPath) => assertCriterionText(targetPath, "coverage-min criterion target_paths must contain non-empty strings"));
  if (c.source_filter_path !== undefined && typeof c.source_filter_path !== "string") throw badInput("coverage-min source_filter_path must be a string");
}
