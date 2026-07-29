/**
 * Evaluates bounded quality criteria without allowing untrusted patterns to cause unsafe matching.
 */
import type { Criterion, CriterionResult } from "../types.js";

const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_TARGET_LENGTH = 4096;

export function hasUnescapedChar(
  pattern: string,
  target: string,
  index = 0,
  escaped = false,
): boolean {
  const ch = pattern[index];
  if (ch === undefined) return false;
  if (escaped) return hasUnescapedChar(pattern, target, index + 1, false);
  if (ch.charCodeAt(0) === 92) return hasUnescapedChar(pattern, target, index + 1, true);
  return ch === target || hasUnescapedChar(pattern, target, index + 1, false);
}

export function isPotentiallyUnsafeRegex(pattern: string): boolean {
  return pattern.length > MAX_REGEX_PATTERN_LENGTH || hasUnsafeRegexStructure(pattern);
}

export function hasUnsafeRegexStructure(pattern: string): boolean {
  return (
    hasRegexBackreference(pattern) ||
    hasRegexGrouping(pattern) ||
    hasRegexLookaround(pattern) ||
    hasRegexGreedyWildcard(pattern) ||
    hasRegexRepeatedQuantifier(pattern) ||
    hasRegexUnboundedRange(pattern)
  );
}

export function hasRegexBackreference(pattern: string): boolean {
  return /\\[1-9]/.test(pattern);
}

export function hasRegexGrouping(pattern: string): boolean {
  return (
    hasUnescapedChar(pattern, "(") ||
    hasUnescapedChar(pattern, ")") ||
    hasUnescapedChar(pattern, "|")
  );
}

export function hasRegexLookaround(pattern: string): boolean {
  return /\(\?/.test(pattern);
}

export function hasRegexGreedyWildcard(pattern: string): boolean {
  return /(\.\*|\.\+)/.test(pattern);
}

export function hasRegexRepeatedQuantifier(pattern: string): boolean {
  return /[+*?]{2,}/.test(pattern);
}

export function hasRegexUnboundedRange(pattern: string): boolean {
  return /\{\d+,\}/.test(pattern) || /\{,\d+\}/.test(pattern);
}

export function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const DISALLOWED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
  const segments = path.split(".");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (DISALLOWED_SEGMENTS.has(seg)) {
      return undefined;
    }
    if (!Object.hasOwn(current, seg)) {
      return undefined;
    }
    current = Reflect.get(current, seg);
  }
  return current;
}

export function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      collectStringValues(entry),
    );
  }
  return [];
}

export function extractTraceId(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  return isRecord(value) ? recordTraceId(value) : undefined;
}

export function nonEmptyString(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordTraceId(record: Record<string, unknown>): string | undefined {
  return typeof record.trace_id === "string"
    ? nonEmptyString(record.trace_id)
    : typeof record.id === "string"
      ? nonEmptyString(record.id)
      : undefined;
}

export function checkFieldExists(artifact: Record<string, unknown>, path: string): CriterionResult {
  const val = resolvePath(artifact, path);
  const exists = val !== undefined && val !== null;
  return {
    name: "",
    passed: exists,
    evidence: exists
      ? `Field "${path}" exists with type ${typeof val}`
      : `Field "${path}" is missing or null`,
  };
}

export function checkFieldEmpty(artifact: Record<string, unknown>, path: string): CriterionResult {
  const val = resolvePath(artifact, path);
  if (!Array.isArray(val)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is not an array`,
    };
  }
  const empty = val.length === 0;
  return {
    name: "",
    passed: empty,
    evidence: empty
      ? `Field "${path}" is an empty array`
      : `Field "${path}" has ${val.length} item(s), expected 0`,
  };
}

export function checkCountMin(
  artifact: Record<string, unknown>,
  path: string,
  minValue: unknown,
): CriterionResult {
  const val = resolvePath(artifact, path);
  if (!Array.isArray(val)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is not an array`,
    };
  }
  if (
    typeof minValue !== "number" ||
    !Number.isFinite(minValue) ||
    !Number.isInteger(minValue) ||
    minValue < 0
  ) {
    return {
      name: "",
      passed: false,
      evidence: "count-min value must be a non-negative integer",
    };
  }
  const min = minValue;
  const passed = val.length >= min;
  return {
    name: "",
    passed,
    evidence: `Field "${path}" has ${val.length} item(s), minimum required: ${min}`,
  };
}

export function checkCountMax(
  artifact: Record<string, unknown>,
  path: string,
  maxValue: unknown,
): CriterionResult {
  const val = resolvePath(artifact, path);
  if (!Array.isArray(val)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is not an array`,
    };
  }
  if (
    typeof maxValue !== "number" ||
    !Number.isFinite(maxValue) ||
    !Number.isInteger(maxValue) ||
    maxValue < 0
  ) {
    return {
      name: "",
      passed: false,
      evidence: "count-max value must be a non-negative integer",
    };
  }
  const max = maxValue;
  const passed = val.length <= max;
  return {
    name: "",
    passed,
    evidence: `Field "${path}" has ${val.length} item(s), maximum allowed: ${max}`,
  };
}

export function checkNumberMax(
  artifact: Record<string, unknown>,
  path: string,
  maxValue: unknown,
): CriterionResult {
  const val = resolvePath(artifact, path);
  if (typeof val !== "number" || !Number.isFinite(val)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is not a finite number`,
    };
  }
  if (typeof maxValue !== "number" || !Number.isFinite(maxValue) || maxValue < 0) {
    return {
      name: "",
      passed: false,
      evidence: "number-max value must be a non-negative number",
    };
  }
  const passed = val <= maxValue;
  return {
    name: "",
    passed,
    evidence: `Field "${path}" value is ${val}, maximum allowed: ${maxValue}`,
  };
}

export function checkCoverageMin(
  artifact: Record<string, unknown>,
  criterion: Criterion,
): CriterionResult {
  const invalid = invalidCoverageCriterion(criterion);
  if (invalid) return invalid;
  const sourcePath = criterion.source_path;
  const targetPaths = criterion.target_paths;
  if (!sourcePath || !targetPaths) return failedCriterion("coverage-min requires paths");
  const source = resolvePath(artifact, sourcePath);
  if (!Array.isArray(source))
    return failedCriterion(`Field "${criterion.source_path}" is not an array`);
  const sourceIds = coverageSourceIds(source, criterion);

  if (sourceIds.length === 0) {
    return passedCriterion(
      "coverage-min source set is empty after filtering; treated as satisfied",
    );
  }
  return coverageResult(
    sourceIds,
    coveredTraceIds(artifact, targetPaths),
    criterion.value as number,
  );
}

export function invalidCoverageCriterion(criterion: Criterion): CriterionResult | undefined {
  if (!isCoverageThreshold(criterion.value))
    return failedCriterion("coverage-min value must be a number between 0 and 1");
  if (hasMissingCoverageSource(criterion))
    return failedCriterion("coverage-min requires source_path");
  if (hasMissingCoverageTargets(criterion))
    return failedCriterion("coverage-min requires non-empty target_paths");
  return undefined;
}

export function isCoverageThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function hasMissingCoverageSource(criterion: Criterion): boolean {
  return !criterion.source_path;
}

export function hasMissingCoverageTargets(criterion: Criterion): boolean {
  return !Array.isArray(criterion.target_paths) || criterion.target_paths.length === 0;
}

export function coverageSourceIds(source: unknown[], criterion: Criterion): string[] {
  return source
    .filter(
      (entry) =>
        !criterion.source_filter_path ||
        (isRecord(entry) &&
          resolvePath(entry, criterion.source_filter_path) === criterion.source_filter_value),
    )
    .map(extractTraceId)
    .filter((id): id is string => typeof id === "string");
}

export function coveredTraceIds(artifact: Record<string, unknown>, paths: string[]): Set<string> {
  return new Set(paths.flatMap((path) => collectStringValues(resolvePath(artifact, path))));
}

export function coverageResult(
  sourceIds: string[],
  covered: Set<string>,
  threshold: number,
): CriterionResult {
  const matched = sourceIds.filter((id) => covered.has(id));
  const missing = sourceIds.filter((id) => !covered.has(id));
  const ratio = matched.length / sourceIds.length;
  return {
    name: "",
    passed: ratio >= threshold,
    evidence: `coverage=${ratio.toFixed(4)} threshold=${threshold.toFixed(4)} matched=${matched.length}/${sourceIds.length} missing=${missing.join(", ") || "none"}`,
  };
}

export function failedCriterion(evidence: string): CriterionResult {
  return { name: "", passed: false, evidence };
}

export function passedCriterion(evidence: string): CriterionResult {
  return { name: "", passed: true, evidence };
}

export function checkRegexMatch(
  artifact: Record<string, unknown>,
  path: string,
  pattern: unknown,
): CriterionResult {
  const val = resolvePath(artifact, path);
  const invalid = invalidRegexInput(val, path, pattern);
  if (invalid) return invalid;
  const regexValue = val as string;
  const regexPattern = pattern as string;
  let matched: boolean;
  try {
    matched = regexValue.match(regexPattern) !== null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "",
      passed: false,
      evidence: `Invalid regex pattern /${regexPattern}/: ${msg}`,
    };
  }
  return {
    name: "",
    passed: matched,
    evidence: matched
      ? `Field "${path}" matches pattern /${regexPattern}/`
      : `Field "${path}" value "${regexValue}" does not match /${regexPattern}/`,
  };
}

export function invalidRegexInput(
  value: unknown,
  path: string,
  pattern: unknown,
): CriterionResult | undefined {
  const valueError = invalidRegexTarget(value, path);
  if (valueError) return valueError;
  const patternError = invalidRegexPattern(pattern);
  if (patternError) return patternError;
  return undefined;
}

export function invalidRegexTarget(value: unknown, path: string): CriterionResult | undefined {
  if (typeof value !== "string") return failedCriterion(`Field "${path}" is not a string`);
  return value.length > MAX_REGEX_TARGET_LENGTH
    ? failedCriterion(
        `Field "${path}" is too large for regex evaluation (${value.length} > ${MAX_REGEX_TARGET_LENGTH})`,
      )
    : undefined;
}

export function invalidRegexPattern(pattern: unknown): CriterionResult | undefined {
  if (typeof pattern !== "string")
    return failedCriterion(`Regex pattern must be a string, got ${typeof pattern}`);
  return isPotentiallyUnsafeRegex(pattern)
    ? failedCriterion(`Regex pattern /${pattern}/ rejected as potentially unsafe`)
    : undefined;
}

type CriterionEvaluator = (
  artifact: Record<string, unknown>,
  criterion: Criterion,
) => CriterionResult;

const EVALUATORS = new Map<string, CriterionEvaluator>([
  ["field-exists", (a, c) => checkFieldExists(a, c.path)],
  ["field-empty", (a, c) => checkFieldEmpty(a, c.path)],
  ["count-min", (a, c) => checkCountMin(a, c.path, c.value)],
  ["count-max", (a, c) => checkCountMax(a, c.path, c.value)],
  ["number-max", (a, c) => checkNumberMax(a, c.path, c.value)],
  ["coverage-min", (a, c) => checkCoverageMin(a, c)],
  ["regex-match", (a, c) => checkRegexMatch(a, c.path, c.value)],
]);

/**
 * Evaluates each allowed criterion with bounded matching semantics suitable for untrusted artifact data.
 */
export function evaluateCriteria(
  artifact: Record<string, unknown>,
  criteria: Criterion[],
): CriterionResult[] {
  return criteria.map((c) => {
    const evaluator = EVALUATORS.get(c.type);
    const result = evaluator
      ? evaluator(artifact, c)
      : {
          name: "",
          passed: false,
          evidence: `Unknown criterion type: ${c.type}`,
        };
    result.name = c.name;
    return result;
  });
}
