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

const validateCoverageCriterion = (c: Input["criteria"][number]): void => {
  if (typeof c.value !== "number" || !Number.isFinite(c.value) || c.value < 0 || c.value > 1) {
    throw badInput("coverage-min criterion requires a value between 0 and 1");
  }
  if (!c.source_path || typeof c.source_path !== "string") {
    throw badInput("coverage-min criterion requires source_path");
  }
  validateCoverageTargets(c);
};

const validateCoverageTargets = (c: Input["criteria"][number]): void => {
  if (!Array.isArray(c.target_paths) || c.target_paths.length === 0) {
    throw badInput("coverage-min criterion requires non-empty target_paths");
  }
  for (const targetPath of c.target_paths) {
    if (typeof targetPath !== "string" || targetPath.length === 0) {
      throw badInput("coverage-min criterion target_paths must contain non-empty strings");
    }
  }
  if (c.source_filter_path !== undefined && typeof c.source_filter_path !== "string") {
    throw badInput("coverage-min source_filter_path must be a string");
  }
};

const validateCriterion = (c: Input["criteria"][number]): void => {
  if (!c.name || typeof c.name !== "string") throw badInput("Each criterion must have a name");
  if (!c.type || typeof c.type !== "string") throw badInput("Each criterion must have a type");
  if (!CRITERION_TYPES.has(c.type)) {
    throw badInput(
      "Each criterion type must be one of: field-exists, field-empty, count-min, count-max, number-max, coverage-min, regex-match",
    );
  }
  if (!c.path || typeof c.path !== "string") throw badInput("Each criterion must have a path");
  validateCriterionValue(c);
};

const validateCriterionValue = (c: Input["criteria"][number]): void => {
  if (c.type === "count-min" || c.type === "count-max") {
    if (
      typeof c.value !== "number" ||
      !Number.isFinite(c.value) ||
      !Number.isInteger(c.value) ||
      c.value < 0
    ) {
      throw badInput(`${c.type} criterion requires a non-negative integer value`);
    }
  }
  validateSpecialCriterionValue(c);
};

const validateSpecialCriterionValue = (c: Input["criteria"][number]): void => {
  if (c.type === "number-max") validateNonNegativeNumber(c.value);
  if (c.type === "coverage-min") validateCoverageCriterion(c);
  if (c.type === "regex-match") validateNonEmptyRegex(c.value);
};

const validateNonNegativeNumber = (value: unknown): void => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw badInput("number-max criterion requires a non-negative number value");
};

const validateNonEmptyRegex = (value: unknown): void => {
  if (typeof value !== "string" || value.length === 0)
    throw badInput("regex-match criterion requires non-empty string value");
};

export function validateInput(input: Input): void {
  validateInputFields(input);
  for (const c of input.criteria) {
    validateCriterion(c);
  }
}

const validateInputFields = (input: Input): void => {
  validateArtifact(input.artifact);
  validateSchemaRef(input.schema_ref);
  validateArtifactRef(input.artifact_ref);
  validatePhase(input.phase);
  validateCriteria(input.criteria);
};

const validateArtifact = (artifact: unknown): void => {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw badInput("artifact must be a JSON object");
};
const validateSchemaRef = (schemaRef: unknown): void => {
  if (!schemaRef || typeof schemaRef !== "string") throw badInput("schema_ref is required");
};
const validateArtifactRef = (artifactRef: unknown): void => {
  if (artifactRef !== undefined && typeof artifactRef !== "string")
    throw badInput("artifact_ref must be a string when provided");
};
const validatePhase = (phase: unknown): void => {
  if (!isGatePhase(phase)) throw badInput("phase must be a valid pipeline phase");
};
const validateCriteria = (criteria: unknown): void => {
  if (!Array.isArray(criteria)) throw badInput("criteria must be an array");
};
