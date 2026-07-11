import type { Criterion, CriterionResult } from "../types.js";

const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_TARGET_LENGTH = 4096;
const BACKSLASH = String.fromCharCode(92);

const hasUnescapedChar = (pattern: string, target: string): boolean => {
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === BACKSLASH) {
      escaped = true;
      continue;
    }
    if (ch === target) return true;
  }
  return false;
};

const isPotentiallyUnsafeRegex = (pattern: string): boolean => {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;
  return hasUnsafeRegexPrimitive(pattern) || hasRepeatedQuantifiedAtom(pattern);
};

const hasUnsafeRegexPrimitive = (pattern: string): boolean =>
  /\\[1-9]/.test(pattern) ||
  hasUnescapedChar(pattern, "(") ||
  hasUnescapedChar(pattern, ")") ||
  hasUnescapedChar(pattern, "|") ||
  /\(\?/.test(pattern) ||
  /(\.\*|\.\+)/.test(pattern) ||
  /[+*?]{2,}/.test(pattern) ||
  /\{\d+,\}/.test(pattern) ||
  /\{,\d+\}/.test(pattern);

const hasRepeatedQuantifiedAtom = (pattern: string): boolean =>
  /((?:\\.|\[[^\]]*\]|[^\\]))[+*](?:\1[+*])+/u.test(pattern);

const resolvePath = (obj: Record<string, unknown>, path: string): unknown => {
  const DISALLOWED_SEGMENTS = new Set(["__proto__", "prototype", "constructor", "toString"]);
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
};

const collectStringValues = (value: unknown): string[] => {
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
};

const extractTraceId = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return nonEmptyString(record.trace_id) ?? nonEmptyString(record.id);
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const checkFieldExists = (artifact: Record<string, unknown>, path: string): CriterionResult => {
  const val = resolvePath(artifact, path);
  const exists = val !== undefined && val !== null;
  return {
    name: "",
    passed: exists,
    evidence: exists
      ? `Field "${path}" exists with type ${typeof val}`
      : `Field "${path}" is missing or null`,
  };
};

const checkFieldEmpty = (artifact: Record<string, unknown>, path: string): CriterionResult => {
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
};

const checkCountMin = (
  artifact: Record<string, unknown>,
  path: string,
  minValue: unknown,
): CriterionResult => {
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
};

const checkCountMax = (
  artifact: Record<string, unknown>,
  path: string,
  maxValue: unknown,
): CriterionResult => {
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
};

const checkNumberMax = (
  artifact: Record<string, unknown>,
  path: string,
  maxValue: unknown,
): CriterionResult => {
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
};

const checkCoverageMin = (
  artifact: Record<string, unknown>,
  criterion: Criterion,
): CriterionResult => {
  const validation = validateCoverageCriterion(criterion);
  if ("passed" in validation) return validation;
  const { sourcePath, targetPaths, threshold } = validation;

  const source = resolvePath(artifact, sourcePath);
  if (!Array.isArray(source)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${sourcePath}" is not an array`,
    };
  }

  const filtered = source.filter((entry) => hasCoverageSourceValue(entry, criterion));

  const sourceIds = filtered
    .map((entry) => extractTraceId(entry))
    .filter((id): id is string => typeof id === "string");

  if (sourceIds.length === 0) {
    return {
      name: "",
      passed: true,
      evidence: "coverage-min source set is empty after filtering; treated as satisfied",
    };
  }

  const covered = new Set(
    targetPaths.flatMap((targetPath) => collectStringValues(resolvePath(artifact, targetPath))),
  );

  const matched = sourceIds.filter((id) => covered.has(id));
  const ratio = matched.length / sourceIds.length;
  const missing = sourceIds.filter((id) => !covered.has(id));
  const passed = ratio >= threshold;

  return {
    name: "",
    passed,
    evidence: `coverage=${ratio.toFixed(4)} threshold=${threshold.toFixed(4)} matched=${matched.length}/${sourceIds.length} missing=${missing.join(", ") || "none"}`,
  };
};

const coverageFailure = (evidence: string): CriterionResult => ({
  name: "",
  passed: false,
  evidence,
});

type CoverageCriterionValidation =
  | CriterionResult
  | {
      sourcePath: string;
      targetPaths: string[];
      threshold: number;
    };

const validateCoverageCriterion = (criterion: Criterion): CoverageCriterionValidation => {
  if (
    typeof criterion.value !== "number" ||
    !Number.isFinite(criterion.value) ||
    criterion.value < 0 ||
    criterion.value > 1
  )
    return coverageFailure("coverage-min value must be a number between 0 and 1");
  if (!criterion.source_path) return coverageFailure("coverage-min requires source_path");
  if (!Array.isArray(criterion.target_paths) || criterion.target_paths.length === 0)
    return coverageFailure("coverage-min requires non-empty target_paths");
  return {
    sourcePath: criterion.source_path,
    targetPaths: criterion.target_paths,
    threshold: criterion.value,
  };
};

const hasCoverageSourceValue = (entry: unknown, criterion: Criterion): boolean => {
  if (!criterion.source_filter_path) return true;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (
    resolvePath(entry as Record<string, unknown>, criterion.source_filter_path) ===
    criterion.source_filter_value
  );
};

const checkRegexMatch = (
  artifact: Record<string, unknown>,
  path: string,
  pattern: unknown,
): CriterionResult => {
  const val = resolvePath(artifact, path);
  const validation = validateRegexInput(val, path, pattern);
  if ("passed" in validation) return validation;
  const { pattern: validatedPattern, value } = validation;
  let re: RegExp;
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp,javascript_dos_rule-non-literal-regexp -- pattern and target lengths are bounded and unsafe constructs are rejected above
    re = new RegExp(validatedPattern);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "",
      passed: false,
      evidence: `Invalid regex pattern /${validatedPattern}/: ${msg}`,
    };
  }
  const matched = re.test(value);
  return {
    name: "",
    passed: matched,
    evidence: matched
      ? `Field "${path}" matches pattern /${validatedPattern}/`
      : `Field "${path}" value "${value}" does not match /${validatedPattern}/`,
  };
};

type RegexInputValidation = CriterionResult | { pattern: string; value: string };

const validateRegexInput = (
  value: unknown,
  path: string,
  pattern: unknown,
): RegexInputValidation => {
  if (typeof value !== "string") return coverageFailure(`Field "${path}" is not a string`);
  if (typeof pattern !== "string")
    return coverageFailure(`Regex pattern must be a string, got ${typeof pattern}`);
  if (value.length > MAX_REGEX_TARGET_LENGTH)
    return coverageFailure(
      `Field "${path}" is too large for regex evaluation (${value.length} > ${MAX_REGEX_TARGET_LENGTH})`,
    );
  if (isPotentiallyUnsafeRegex(pattern))
    return coverageFailure(`Regex pattern /${pattern}/ rejected as potentially unsafe`);
  return { pattern, value };
};

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
