import type { Criterion, CriterionResult } from "../types.js";

const MAX_REGEX_PATTERN_LENGTH = 256;
const MAX_REGEX_TARGET_LENGTH = 4096;

function hasUnescapedChar(pattern: string, target: string): boolean {
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === target) return true;
  }
  return false;
}

function isPotentiallyUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;

  // Backreferences, groups/lookarounds and alternation are common ReDoS primitives.
  if (/\\[1-9]/.test(pattern)) return true;
  if (hasUnescapedChar(pattern, "(") || hasUnescapedChar(pattern, ")")) return true;
  if (hasUnescapedChar(pattern, "|")) return true;
  if (/\(\?/.test(pattern)) return true;
  if (/(\.\*|\.\+)/.test(pattern)) return true;
  if (/[+*?]{2,}/.test(pattern)) return true;
  if (/\{\d+,\}/.test(pattern) || /\{,\d+\}/.test(pattern)) return true;

  return false;
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
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
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function collectStringValues(value: unknown): string[] {
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

function extractTraceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.trace_id === "string" && record.trace_id.length > 0) {
    return record.trace_id;
  }
  if (typeof record.id === "string" && record.id.length > 0) {
    return record.id;
  }
  return undefined;
}

function checkFieldExists(artifact: Record<string, unknown>, path: string): CriterionResult {
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

function checkFieldEmpty(artifact: Record<string, unknown>, path: string): CriterionResult {
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

function checkCountMin(
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

function checkCountMax(
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

function checkNumberMax(
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

function checkCoverageMin(
  artifact: Record<string, unknown>,
  criterion: Criterion,
): CriterionResult {
  const threshold = criterion.value;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    return {
      name: "",
      passed: false,
      evidence: "coverage-min value must be a number between 0 and 1",
    };
  }
  if (!criterion.source_path) {
    return {
      name: "",
      passed: false,
      evidence: "coverage-min requires source_path",
    };
  }
  if (!Array.isArray(criterion.target_paths) || criterion.target_paths.length === 0) {
    return {
      name: "",
      passed: false,
      evidence: "coverage-min requires non-empty target_paths",
    };
  }

  const source = resolvePath(artifact, criterion.source_path);
  if (!Array.isArray(source)) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${criterion.source_path}" is not an array`,
    };
  }

  const filtered = source.filter((entry) => {
    if (!criterion.source_filter_path) {
      return true;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const filterValue = resolvePath(entry as Record<string, unknown>, criterion.source_filter_path);
    return filterValue === criterion.source_filter_value;
  });

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

  const covered = new Set<string>();
  for (const targetPath of criterion.target_paths) {
    const targetVal = resolvePath(artifact, targetPath);
    const strings = collectStringValues(targetVal);
    for (const value of strings) {
      covered.add(value);
    }
  }

  const matched = sourceIds.filter((id) => covered.has(id));
  const ratio = matched.length / sourceIds.length;
  const missing = sourceIds.filter((id) => !covered.has(id));
  const passed = ratio >= threshold;

  return {
    name: "",
    passed,
    evidence: `coverage=${ratio.toFixed(4)} threshold=${threshold.toFixed(4)} matched=${matched.length}/${sourceIds.length} missing=${missing.join(", ") || "none"}`,
  };
}

function checkRegexMatch(
  artifact: Record<string, unknown>,
  path: string,
  pattern: unknown,
): CriterionResult {
  const val = resolvePath(artifact, path);
  if (typeof val !== "string") {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is not a string`,
    };
  }
  if (typeof pattern !== "string") {
    return {
      name: "",
      passed: false,
      evidence: `Regex pattern must be a string, got ${typeof pattern}`,
    };
  }
  if (val.length > MAX_REGEX_TARGET_LENGTH) {
    return {
      name: "",
      passed: false,
      evidence: `Field "${path}" is too large for regex evaluation (${val.length} > ${MAX_REGEX_TARGET_LENGTH})`,
    };
  }
  if (isPotentiallyUnsafeRegex(pattern)) {
    return {
      name: "",
      passed: false,
      evidence: `Regex pattern /${pattern}/ rejected as potentially unsafe`,
    };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "",
      passed: false,
      evidence: `Invalid regex pattern /${pattern}/: ${msg}`,
    };
  }
  const matched = re.test(val);
  return {
    name: "",
    passed: matched,
    evidence: matched
      ? `Field "${path}" matches pattern /${pattern}/`
      : `Field "${path}" value "${val}" does not match /${pattern}/`,
  };
}

type CriterionEvaluator = (
  artifact: Record<string, unknown>,
  criterion: Criterion,
) => CriterionResult;

const EVALUATORS: Record<string, CriterionEvaluator> = {
  "field-exists": (a, c) => checkFieldExists(a, c.path),
  "field-empty": (a, c) => checkFieldEmpty(a, c.path),
  "count-min": (a, c) => checkCountMin(a, c.path, c.value),
  "count-max": (a, c) => checkCountMax(a, c.path, c.value),
  "number-max": (a, c) => checkNumberMax(a, c.path, c.value),
  "coverage-min": (a, c) => checkCoverageMin(a, c),
  "regex-match": (a, c) => checkRegexMatch(a, c.path, c.value),
};

export function evaluateCriteria(
  artifact: Record<string, unknown>,
  criteria: Criterion[],
): CriterionResult[] {
  return criteria.map((c) => {
    const evaluator = EVALUATORS[c.type];
    const result = evaluator
      ? evaluator(artifact, c)
      : { name: "", passed: false, evidence: `Unknown criterion type: ${c.type}` };
    result.name = c.name;
    return result;
  });
}
