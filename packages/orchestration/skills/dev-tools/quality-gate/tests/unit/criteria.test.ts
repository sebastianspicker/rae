import { describe, it, expect } from "vitest";
import { evaluateCriteria } from "../../src/lib/criteria.js";

describe("evaluateCriteria", () => {
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
        { name: "no-open-questions", type: "field-empty", path: "open_questions" },
      ]);
      expect(results[0].passed).toBe(true);
    });

    it("fails when array is non-empty", () => {
      const results = evaluateCriteria({ open_questions: ["Why?"] }, [
        { name: "no-open-questions", type: "field-empty", path: "open_questions" },
      ]);
      expect(results[0].passed).toBe(false);
      expect(results[0].evidence).toContain("1 item");
    });

    it("fails when field is not an array", () => {
      const results = evaluateCriteria({ open_questions: "not an array" }, [
        { name: "no-open-questions", type: "field-empty", path: "open_questions" },
      ]);
      expect(results[0].passed).toBe(false);
      expect(results[0].evidence).toContain("not an array");
    });
  });

  describe("count-min", () => {
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
        { name: "token-budget", type: "number-max", path: "token_estimate", value: 1000 },
      ]);
      expect(results[0].passed).toBe(true);
    });

    it("fails when number exceeds budget", () => {
      const results = evaluateCriteria({ token_estimate: 1200 }, [
        { name: "token-budget", type: "number-max", path: "token_estimate", value: 1000 },
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
        { name: "semver", type: "regex-match", path: "version", value: "^\\d+\\.\\d+\\.\\d+$" },
      ]);
      expect(results[0].passed).toBe(true);
    });

    it("fails when string does not match", () => {
      const results = evaluateCriteria({ version: "latest" }, [
        { name: "semver", type: "regex-match", path: "version", value: "^\\d+\\.\\d+\\.\\d+$" },
      ]);
      expect(results[0].passed).toBe(false);
      expect(results[0].evidence).toContain("does not match");
    });

    it("fails when field is not a string", () => {
      const results = evaluateCriteria({ version: 123 }, [
        { name: "semver", type: "regex-match", path: "version", value: "^\\d+$" },
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
      const results = evaluateCriteria({ version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!" }, [
        { name: "unsafe", type: "regex-match", path: "version", value: "^(a+)+$" },
      ]);
      expect(results[0].passed).toBe(false);
      expect(results[0].evidence).toContain("potentially unsafe");
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
  });
});
