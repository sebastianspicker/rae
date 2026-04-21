import { describe, it, expect } from "vitest";
import { deduplicateFindings, tokenSimilarity, type TaggedFinding } from "../../src/lib/dedup.js";

function makeFinding(overrides: Partial<TaggedFinding> & { _source: string }): TaggedFinding {
  return {
    id: "f-1",
    category: "correctness",
    description: "Something is wrong",
    severity: "medium",
    _source: overrides._source,
    ...overrides,
  };
}

describe("tokenSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(tokenSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(tokenSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
  });

  it("returns a value between 0 and 1 for partial overlap", () => {
    const sim = tokenSimilarity("the quick brown fox", "the slow brown dog");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe("deduplicateFindings", () => {
  it("merges identical findings from different models", () => {
    const findings: TaggedFinding[] = [
      makeFinding({
        id: "a-1",
        description: "Missing error handling in the authentication module",
        _source: "kimi",
      }),
      makeFinding({
        id: "b-1",
        description: "Missing error handling in the authentication module",
        _source: "glm",
      }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0]?.source_models).toContain("kimi");
    expect(result[0]?.source_models).toContain("glm");
  });

  it("keeps distinct findings separate", () => {
    const findings: TaggedFinding[] = [
      makeFinding({
        id: "a-1",
        description: "SQL injection vulnerability in user input",
        _source: "kimi",
      }),
      makeFinding({
        id: "b-1",
        description: "Performance bottleneck in database query optimization",
        _source: "glm",
      }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
    expect(result[0]?.source_models).toHaveLength(1);
    expect(result[1]?.source_models).toHaveLength(1);
  });

  it("promotes severity when merging findings", () => {
    const findings: TaggedFinding[] = [
      makeFinding({
        id: "a-1",
        description: "Missing input validation on the user API endpoint",
        severity: "low",
        _source: "kimi",
      }),
      makeFinding({
        id: "b-1",
        description: "Missing input validation on the user API endpoint",
        severity: "high",
        _source: "glm",
      }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("high");
  });

  it("groups only within the same category", () => {
    const findings: TaggedFinding[] = [
      makeFinding({
        id: "a-1",
        category: "security",
        description: "Missing rate limiting on the API",
        _source: "kimi",
      }),
      makeFinding({
        id: "b-1",
        category: "performance",
        description: "Missing rate limiting on the API",
        _source: "glm",
      }),
    ];

    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateFindings([])).toEqual([]);
  });
});
