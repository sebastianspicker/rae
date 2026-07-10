import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateCriteria } from "../../src/lib/criteria.js";

describe("field-exists", () => {
  it("passes when field is present", () => {
    const results = evaluateCriteria({ summary: "A brief summary" }, [
      { name: "has-summary", type: "field-exists", path: "summary" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].name).toBe("has-summary");
  });

  it("fails when field is missing", () => {
    const results = evaluateCriteria({ other: 1 }, [
      { name: "has-summary", type: "field-exists", path: "summary" },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("missing");
  });

  it("fails when field is null", () => {
    const results = evaluateCriteria({ summary: null } as unknown as Record<string, unknown>, [
      { name: "has-summary", type: "field-exists", path: "summary" },
    ]);
    expect(results[0].passed).toBe(false);
  });

  it("does not resolve inherited prototype properties", () => {
    const results = evaluateCriteria({ summary: "ok" }, [
      { name: "no-prototype", type: "field-exists", path: "constructor" },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("missing");
  });
});

describe("field-empty", () => {
  it("passes when array is empty", () => {
    const results = evaluateCriteria({ open_questions: [] }, [
      {
        name: "no-open-questions",
        type: "field-empty",
        path: "open_questions",
      },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when array is non-empty", () => {
    const results = evaluateCriteria({ open_questions: ["Why?"] }, [
      {
        name: "no-open-questions",
        type: "field-empty",
        path: "open_questions",
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("1 item");
  });

  it("fails when field is not an array", () => {
    const results = evaluateCriteria({ open_questions: "not an array" }, [
      {
        name: "no-open-questions",
        type: "field-empty",
        path: "open_questions",
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("not an array");
  });
});

describe("count-min", () => {
  it("matches the generated array length against non-negative minimum thresholds", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.nat({ max: 100 }), (items, min) => {
        const results = evaluateCriteria({ items }, [
          {
            name: "min-items",
            type: "count-min",
            path: "items",
            value: min,
          },
        ]);

        expect(results[0].passed).toBe(items.length >= min);
      }),
    );
  });

  it("passes when count meets threshold", () => {
    const results = evaluateCriteria({ items: [1, 2, 3] }, [
      { name: "min-items", type: "count-min", path: "items", value: 3 },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when count is below threshold", () => {
    const results = evaluateCriteria({ items: [1] }, [
      { name: "min-items", type: "count-min", path: "items", value: 3 },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("1 item");
    expect(results[0].evidence).toContain("minimum required: 3");
  });

  it("passes when count exceeds threshold", () => {
    const results = evaluateCriteria({ items: [1, 2, 3, 4, 5] }, [
      { name: "min-items", type: "count-min", path: "items", value: 2 },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when count-min value is not a number", () => {
    const results = evaluateCriteria({ items: [1] }, [
      { name: "min-items", type: "count-min", path: "items", value: "2" },
    ]);

    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("non-negative integer");
  });

  it("fails when count-min value is negative", () => {
    const results = evaluateCriteria({ items: [1] }, [
      { name: "min-items", type: "count-min", path: "items", value: -1 },
    ]);

    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("non-negative integer");
  });
});

describe("count-max", () => {
  it("matches the generated array length against non-negative maximum thresholds", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.nat({ max: 100 }), (items, max) => {
        const results = evaluateCriteria({ items }, [
          {
            name: "max-items",
            type: "count-max",
            path: "items",
            value: max,
          },
        ]);

        expect(results[0].passed).toBe(items.length <= max);
      }),
    );
  });

  it("passes when count is below threshold", () => {
    const results = evaluateCriteria({ items: [1, 2] }, [
      { name: "max-items", type: "count-max", path: "items", value: 3 },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when count exceeds threshold", () => {
    const results = evaluateCriteria({ items: [1, 2, 3, 4] }, [
      { name: "max-items", type: "count-max", path: "items", value: 2 },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("maximum allowed: 2");
  });
});

describe("number-max", () => {
  it("passes when number is within budget", () => {
    const results = evaluateCriteria({ token_estimate: 900 }, [
      {
        name: "token-budget",
        type: "number-max",
        path: "token_estimate",
        value: 1000,
      },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when number exceeds budget", () => {
    const results = evaluateCriteria({ token_estimate: 1200 }, [
      {
        name: "token-budget",
        type: "number-max",
        path: "token_estimate",
        value: 1000,
      },
    ]);
    expect(results[0].passed).toBe(false);
  });
});

describe("coverage-min", () => {
  it("passes when must requirements are fully covered", () => {
    const artifact = {
      requirements: [
        { id: "REQ-1", priority: "must" },
        { id: "REQ-2", priority: "must" },
      ],
      test_links: [["REQ-1"], ["REQ-2"]],
    };
    const results = evaluateCriteria(artifact, [
      {
        name: "must-covered",
        type: "coverage-min",
        path: "unused",
        source_path: "requirements",
        source_filter_path: "priority",
        source_filter_value: "must",
        target_paths: ["test_links"],
        value: 1,
      },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when coverage threshold is not met", () => {
    const artifact = {
      requirements: [
        { trace_id: "REQ-1", priority: "must" },
        { trace_id: "REQ-2", priority: "must" },
      ],
      tasks: [{ covers_requirement_ids: ["REQ-1"] }],
    };
    const results = evaluateCriteria(artifact, [
      {
        name: "must-covered",
        type: "coverage-min",
        path: "unused",
        source_path: "requirements",
        source_filter_path: "priority",
        source_filter_value: "must",
        target_paths: ["tasks"],
        value: 1,
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("REQ-2");
  });
});

describe("regex-match", () => {
  it("passes when string matches pattern", () => {
    const results = evaluateCriteria({ version: "1.2.3" }, [
      {
        name: "semver",
        type: "regex-match",
        path: "version",
        value: "^\\d+\\.\\d+\\.\\d+$",
      },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails when string does not match", () => {
    const results = evaluateCriteria({ version: "latest" }, [
      {
        name: "semver",
        type: "regex-match",
        path: "version",
        value: "^\\d+\\.\\d+\\.\\d+$",
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("does not match");
  });

  it("fails when field is not a string", () => {
    const results = evaluateCriteria({ version: 123 }, [
      {
        name: "semver",
        type: "regex-match",
        path: "version",
        value: "^\\d+$",
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("not a string");
  });

  it("fails gracefully for invalid regex patterns", () => {
    const results = evaluateCriteria({ version: "1.2.3" }, [
      { name: "semver", type: "regex-match", path: "version", value: "[" },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("Invalid regex pattern");
  });

  it("rejects potentially unsafe regex patterns", () => {
    const results = evaluateCriteria({ version: "1.2.3" }, [
      {
        name: "unsafe",
        type: "regex-match",
        path: "version",
        value: "^(safe)$",
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("potentially unsafe");
  });

  it("rejects overlong patterns before compilation", () => {
    const results = evaluateCriteria({ version: "1.2.3" }, [
      {
        name: "too-long",
        type: "regex-match",
        path: "version",
        value: "a".repeat(257),
      },
    ]);
    expect(results[0].passed).toBe(false);
    expect(results[0].evidence).toContain("potentially unsafe");
  });

  it("rejects oversized target strings and nested-quantifier attack patterns", () => {
    const oversized = evaluateCriteria({ value: "a".repeat(4097) }, [
      {
        name: "oversized",
        type: "regex-match",
        path: "value",
        value: "^a+$",
      },
    ]);
    const nested = evaluateCriteria({ value: `${"a".repeat(1000)}!` }, [
      {
        name: "nested",
        type: "regex-match",
        path: "value",
        value: "^(a+)+$",
      },
    ]);

    expect(oversized[0].passed).toBe(false);
    expect(oversized[0].evidence).toContain("too large");
    expect(nested[0].passed).toBe(false);
    expect(nested[0].evidence).toContain("potentially unsafe");
  });

  it("rejects repeated quantified atoms without evaluating them", () => {
    const startedAt = performance.now();
    const repeated = evaluateCriteria({ value: "a".repeat(30) }, [
      {
        name: "adjacent-quantifiers",
        type: "regex-match",
        path: "value",
        value: `^${"a*".repeat(12)}b$`,
      },
    ]);

    expect(repeated[0].passed).toBe(false);
    expect(repeated[0].evidence).toContain("potentially unsafe");
    expect(performance.now() - startedAt).toBeLessThan(100);
  });
});

describe("nested paths", () => {
  it("resolves dotted paths", () => {
    const results = evaluateCriteria({ meta: { author: "Alice" } }, [
      { name: "has-author", type: "field-exists", path: "meta.author" },
    ]);
    expect(results[0].passed).toBe(true);
  });

  it("fails on missing nested path", () => {
    const results = evaluateCriteria({ meta: {} }, [
      { name: "has-author", type: "field-exists", path: "meta.author" },
    ]);
    expect(results[0].passed).toBe(false);
  });

  it.each([
    "__proto__",
    "prototype",
    "constructor",
    "toString",
  ])("rejects the unsafe path segment %s even when it is an own property", (segment) => {
    const artifact = Object.create(null) as Record<string, unknown>;
    artifact[segment] = "secret";
    const results = evaluateCriteria(artifact, [
      { name: "unsafe", type: "field-exists", path: segment },
    ]);
    expect(results[0].passed).toBe(false);
  });
});
