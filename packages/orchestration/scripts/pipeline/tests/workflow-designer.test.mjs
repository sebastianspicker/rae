/** Verifies guided workflow compilation, static diagnostics, and graph CLI analysis. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyzeWorkflow,
  compileWorkflowTemplate,
  listWorkflowTemplates,
} from "../lib/workflow-designer.mjs";

const graphCli = resolve(import.meta.dirname, "../graph-cli.mjs");

describe("guided workflow designer", () => {
  test("compiles every guided template directly to a valid v2.1 workflow", () => {
    const templates = listWorkflowTemplates();
    expect(templates.map(({ id }) => id)).toEqual([
      "single-agent-verification",
      "maker-checker-repair",
      "parallel-review-quorum",
      "mapped-work",
      "bounded-until-dry-loop",
    ]);
    for (const template of templates) {
      const workflow = compileWorkflowTemplate(template.id);
      expect(workflow.schema_version).toBe("2.1.0");
      expect(workflow.nodes.some((node) => node.verification)).toBe(true);
    }
  });

  test("reports independent schema and topology diagnostics, including unreachable nodes", () => {
    const workflow = compileWorkflowTemplate("single-agent-verification");
    workflow.nodes.push({ id: "orphan", kind: "agent", access: "read", guidance: "orphan" });
    workflow.nodes.find((node) => node.id === "verify").verification = false;
    const report = analyzeWorkflow(workflow);
    expect(report.valid).toBe(false);
    expect(report.schema_diagnostics.map(({ message }) => message).join("\n")).toMatch(
      /unreachable node orphan|terminal paths are not dominated by verification/,
    );
    expect(report.unreachable_nodes).toContain("orphan");
    expect(report.missing_verification).toMatchObject({
      required: true,
      terminal_dominated: false,
    });
    expect(report.monetary_cost).toEqual({ status: "unavailable" });
  });

  test("reports unsafe writer paths and estimates bounded mapped execution", () => {
    const workflow = compileWorkflowTemplate("mapped-work", {
      max_map_items: 3,
      max_dynamic_instances: 8,
      max_attempts_per_node: 2,
    });
    const writer = workflow.nodes.find((node) => node.id === "apply");
    workflow.nodes.find((node) => node.id === "plan").ownership_plan = false;
    const report = analyzeWorkflow(workflow);
    expect(report.unsafe_writer_paths).toEqual([
      expect.objectContaining({
        node_id: writer.id,
        reasons: expect.arrayContaining(["missing ownership-plan dominance"]),
      }),
    ]);
    expect(report.estimated_dynamic_instances).toBe(3);
    expect(report.estimated_max_attempts).toBeGreaterThan(0);
    expect(report.concurrency_bound).toBe(4);
  });

  test("resolves logical routes from an optional operator-owned execution profile", () => {
    const workflow = compileWorkflowTemplate("parallel-review-quorum");
    const report = analyzeWorkflow(workflow, {
      executionProfile: {
        schema_version: "1.0.0",
        profile_id: "designer-profile",
        tiers: {
          economy: { model: "economy-model", reasoning_effort: "low" },
          standard: { model: "standard-model", reasoning_effort: "medium" },
          judgment: { model: "judgment-model", reasoning_effort: "high" },
        },
      },
    });
    expect(report.execution_routes).toContainEqual(
      expect.objectContaining({ node_id: "contracts", tier: "judgment", model: "judgment-model" }),
    );
  });

  test("graph workflow analyze reads a candidate file without requiring a registry draft", () => {
    const root = mkdtempSync(resolve(tmpdir(), "rae-workflow-designer-"));
    const workflowPath = resolve(root, "workflow.json");
    writeFileSync(
      workflowPath,
      `${JSON.stringify(compileWorkflowTemplate("single-agent-verification"))}\n`,
    );
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [graphCli, "workflow", "analyze", "--workflow-file", workflowPath, "--json"],
        { encoding: "utf8" },
      ),
    );
    expect(report).toMatchObject({ valid: true, monetary_cost: { status: "unavailable" } });
  });
});
