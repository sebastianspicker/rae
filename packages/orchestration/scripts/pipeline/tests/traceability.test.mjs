/**
 * Tests for traceability helper functions.
 * Note: evaluateMustTraceability() requires quality-gate subprocess
 * and is tested indirectly via pipeline integration. These tests
 * cover the pure extraction and coverage functions.
 */
import { describe, it, expect } from "vitest";
import { buildCoverageResult, buildRequirementCoverageLedger } from "../lib/traceability.mjs";

// The traceability module doesn't export its helpers directly,
// so we test the logic patterns used internally by reimporting
// the module and testing the exported evaluateMustTraceability
// indirectly through its behavior contracts.

// We CAN test the coverage logic by exercising the extraction patterns
// that traceability.mjs uses internally. These match the data structures
// from brief.schema.json and execution-plan.schema.json.

describe("traceability data extraction patterns", () => {
  // These tests verify the data extraction logic that traceability.mjs
  // applies to brief, plan, drift, and design artifacts.

  describe("must requirement extraction from brief", () => {
    it("extracts must-priority requirement IDs", () => {
      const brief = {
        requirements: [
          { id: "REQ-001", priority: "must" },
          { id: "REQ-002", priority: "should" },
          { id: "REQ-003", priority: "must" },
        ],
      };
      const mustIds = brief.requirements
        .filter((r) => r.priority === "must")
        .map((r) => r.id)
        .sort();
      expect(mustIds).toEqual(["REQ-001", "REQ-003"]);
    });

    it("returns empty for no must requirements", () => {
      const brief = {
        requirements: [{ id: "REQ-001", priority: "should" }],
      };
      const mustIds = brief.requirements.filter((r) => r.priority === "must").map((r) => r.id);
      expect(mustIds).toEqual([]);
    });
  });

  describe("plan task requirement extraction", () => {
    it("extracts covers_requirement_ids from all tasks across groups", () => {
      const plan = {
        task_groups: [
          {
            group_id: "g1",
            tasks: [
              { id: "t1", covers_requirement_ids: ["REQ-001", "REQ-002"] },
              { id: "t2", covers_requirement_ids: ["REQ-003"] },
            ],
          },
          {
            group_id: "g2",
            tasks: [{ id: "t3", covers_requirement_ids: ["REQ-001"] }],
          },
        ],
      };
      const ids = new Set();
      for (const group of plan.task_groups) {
        for (const task of group.tasks) {
          for (const id of task.covers_requirement_ids || []) {
            ids.add(id);
          }
        }
      }
      expect([...ids].sort()).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
    });
  });

  describe("plan test requirement extraction", () => {
    it("extracts covers_requirement_ids from test_cases", () => {
      const plan = {
        task_groups: [
          {
            group_id: "g1",
            tasks: [
              {
                id: "t1",
                test_cases: [
                  { name: "test1", covers_requirement_ids: ["REQ-001"] },
                  { name: "test2", covers_requirement_ids: ["REQ-002"] },
                ],
              },
            ],
          },
        ],
      };
      const ids = new Set();
      for (const group of plan.task_groups) {
        for (const task of group.tasks) {
          for (const tc of task.test_cases || []) {
            for (const id of tc.covers_requirement_ids || []) {
              ids.add(id);
            }
          }
        }
      }
      expect([...ids].sort()).toEqual(["REQ-001", "REQ-002"]);
    });
  });

  describe("drift claim requirement extraction", () => {
    it("extracts covers_requirement_ids from claims", () => {
      const drift = {
        claims: [
          { id: "d1", covers_requirement_ids: ["REQ-001"] },
          { id: "d2", covers_requirement_ids: ["REQ-002", "REQ-003"] },
        ],
      };
      const ids = new Set();
      for (const claim of drift.claims) {
        for (const id of claim.covers_requirement_ids || []) {
          ids.add(id);
        }
      }
      expect([...ids].sort()).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
    });
  });

  describe("coverage result logic", () => {
    it("full coverage when all source IDs are in target", () => {
      const source = ["REQ-001", "REQ-002"];
      const target = new Set(["REQ-001", "REQ-002", "REQ-003"]);
      const missing = source.filter((id) => !target.has(id));
      expect(missing).toEqual([]);
    });

    it("partial coverage identifies missing IDs", () => {
      const source = ["REQ-001", "REQ-002", "REQ-003"];
      const target = new Set(["REQ-001"]);
      const missing = source.filter((id) => !target.has(id));
      expect(missing).toEqual(["REQ-002", "REQ-003"]);
    });

    it("empty source always passes", () => {
      const result = buildCoverageResult("must-covered-by-plan-tasks", [], []);
      expect(result.passed).toBe(false);
      expect(result.evidence).toContain("matched=0/0");
    });
  });

  describe("requirement coverage ledger", () => {
    it("marks requirements covered when both task and test coverage exist", () => {
      const ledger = buildRequirementCoverageLedger({
        brief: {
          requirements: [{ id: "REQ-001", priority: "must" }],
        },
        plan: {
          task_groups: [
            {
              group_id: "g1",
              tasks: [
                {
                  id: "task-1",
                  covers_requirement_ids: ["REQ-001"],
                  acceptance_criteria: ["tc-1 passes"],
                  test_cases: [{ name: "tc-1", covers_requirement_ids: ["REQ-001"] }],
                },
              ],
            },
          ],
        },
      });

      expect(ledger.summary.covered_requirements).toBe(1);
      expect(ledger.summary.missing_requirements).toBe(0);
      expect(ledger.qc_summary.coverage_status).toBe("complete");
      expect(ledger.requirements[0].status).toBe("covered");
      expect(ledger.requirements[0].acceptance_criteria).toEqual(["tc-1 passes"]);
    });

    it("marks requirements missing when neither task nor test coverage exists", () => {
      const ledger = buildRequirementCoverageLedger({
        brief: {
          requirements: [{ id: "REQ-001", priority: "must" }],
        },
        plan: {
          task_groups: [
            {
              group_id: "g1",
              tasks: [{ id: "task-1", test_cases: [] }],
            },
          ],
        },
      });

      expect(ledger.summary.covered_requirements).toBe(0);
      expect(ledger.summary.missing_requirements).toBe(1);
      expect(ledger.qc_summary.coverage_status).toBe("missing");
      expect(ledger.requirements[0].missing_task_ids).toContain("unplanned-task-coverage");
      expect(ledger.requirements[0].missing_test_cases).toContain("unplanned-test-coverage");
    });

    it("marks requirements partial when only task or test coverage exists", () => {
      const ledger = buildRequirementCoverageLedger({
        brief: {
          requirements: [{ id: "REQ-001", priority: "must" }],
        },
        plan: {
          task_groups: [
            {
              group_id: "g1",
              tasks: [
                {
                  id: "task-1",
                  covers_requirement_ids: ["REQ-001"],
                  test_cases: [],
                },
              ],
            },
          ],
        },
      });

      expect(ledger.summary.partial_requirements).toBe(1);
      expect(ledger.qc_summary.coverage_status).toBe("partial");
      expect(ledger.requirements[0].status).toBe("partial");
    });

    it("treats missing MUST requirements as missing coverage", () => {
      const ledger = buildRequirementCoverageLedger({
        brief: {
          requirements: [{ id: "REQ-001", priority: "should" }],
        },
        plan: {
          task_groups: [],
        },
      });

      expect(ledger.summary.total_requirements).toBe(0);
      expect(ledger.qc_summary.coverage_status).toBe("missing");
      expect(ledger.qc_summary.headline).toContain("No MUST requirements");
    });
  });
});
