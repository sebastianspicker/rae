/**
 * Verifies finding similarity and source-preserving deduplication prevent repeated review work.
 */
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

it("retains first-present fields and ordered source and requirement provenance", () => {
  const findings: TaggedFinding[] = [
    makeFinding({
      id: "first",
      description: "Input parsing lacks a bounded error response",
      severity: "low",
      _source: "architect",
      covers_requirement_ids: ["req-1", "req-2"],
    }),
    makeFinding({
      id: "second",
      description: "Input parsing lacks a bounded error response",
      severity: "high",
      evidence: "First evidence",
      suggestion: "First suggestion",
      trace_id: "trace-first",
      _source: "security",
      covers_requirement_ids: ["req-2", "req-3"],
    }),
    makeFinding({
      id: "third",
      description: "Input parsing lacks a bounded error response",
      severity: "critical",
      evidence: "Later evidence",
      suggestion: "Later suggestion",
      trace_id: "trace-later",
      _source: "performance",
      covers_requirement_ids: ["req-1", "req-4"],
    }),
    makeFinding({
      id: "fourth",
      description: "Input parsing lacks a bounded error response",
      _source: "security",
      covers_requirement_ids: ["req-4", "req-5"],
    }),
  ];

  const result = deduplicateFindings(findings);

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    severity: "critical",
    evidence: "First evidence",
    suggestion: "First suggestion",
    trace_id: "trace-first",
    source_models: ["architect", "security", "performance"],
    covers_requirement_ids: ["req-1", "req-2", "req-3", "req-4", "req-5"],
  });
});

it("uses truthiness when filling optional fields through public deduplication", () => {
  const nullString = null as unknown as string;
  const findings: TaggedFinding[] = [
    makeFinding({
      id: "initial",
      description: "The parser needs a bounded failure response",
      evidence: nullString,
      suggestion: "",
      _source: "architect",
    }),
    makeFinding({
      id: "falsy-incoming",
      description: "The parser needs a bounded failure response",
      evidence: undefined,
      suggestion: "",
      trace_id: nullString,
      _source: "security",
    }),
    makeFinding({
      id: "first-populated",
      description: "The parser needs a bounded failure response",
      evidence: "First evidence",
      suggestion: "First suggestion",
      trace_id: "trace-first",
      _source: "performance",
    }),
    makeFinding({
      id: "later-populated",
      description: "The parser needs a bounded failure response",
      evidence: "Later evidence",
      suggestion: "Later suggestion",
      trace_id: "trace-later",
      _source: "reliability",
    }),
  ];

  const result = deduplicateFindings(findings);

  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    evidence: "First evidence",
    suggestion: "First suggestion",
    trace_id: "trace-first",
  });
});

it.each([
  { label: "undefined", initial: null as unknown as string, terminal: undefined },
  { label: "null", initial: "", terminal: null as unknown as string },
  { label: "an empty string", initial: null as unknown as string, terminal: "" },
])("ignores a terminal $label evidence value", ({ initial, terminal }) => {
  const findings: TaggedFinding[] = [
    makeFinding({
      id: "initial",
      description: "The parser needs a bounded failure response",
      evidence: initial,
      _source: "architect",
    }),
    makeFinding({
      id: "terminal-falsy",
      description: "The parser needs a bounded failure response",
      evidence: terminal,
      _source: "security",
    }),
  ];

  const result = deduplicateFindings(findings);

  expect(result).toHaveLength(1);
  expect(result[0]?.evidence).toBe(initial);
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
