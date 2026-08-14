/**
 * Verifies gate evaluation rejects unsafe schema references and composes validation results correctly.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateGate } from "../../src/lib/engine.js";

function createWorkspaceSchema(schema: Record<string, unknown>): {
  workspaceRoot: string;
  schemaRef: string;
  remove: () => void;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "qg-workspace-schema-"));
  const schemaRef = "artifact.schema.json";
  writeFileSync(join(workspaceRoot, schemaRef), JSON.stringify(schema), "utf8");

  return {
    workspaceRoot,
    schemaRef,
    remove: () => rmSync(workspaceRoot, { recursive: true, force: true }),
  };
}

describe("evaluateGate", () => {
  it("rejects absolute schema_ref paths outside workspaceRoot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "qg-workspace-"));
    const externalDir = mkdtempSync(join(tmpdir(), "qg-external-"));
    const externalSchema = join(externalDir, "schema.json");
    writeFileSync(externalSchema, JSON.stringify({ type: "object" }), "utf8");

    await expect(
      evaluateGate(
        {
          artifact: {},
          schema_ref: externalSchema,
          phase: "arm",
          criteria: [],
        },
        { workspaceRoot },
      ),
    ).rejects.toThrow("schema_ref must resolve within workspaceRoot");

    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it("rejects schema_ref traversal outside workspaceRoot", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "qg-base-"));
    const workspaceRoot = join(baseDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const externalSchema = join(baseDir, "outside.schema.json");
    writeFileSync(externalSchema, JSON.stringify({ type: "object" }), "utf8");

    await expect(
      evaluateGate(
        {
          artifact: {},
          schema_ref: "../outside.schema.json",
          phase: "arm",
          criteria: [],
        },
        { workspaceRoot },
      ),
    ).rejects.toThrow("schema_ref must resolve within workspaceRoot");

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects schema_ref symlinks that resolve outside workspaceRoot", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "qg-workspace-link-"));
    const externalDir = mkdtempSync(join(tmpdir(), "qg-external-link-"));
    const externalSchema = join(externalDir, "schema.json");
    writeFileSync(externalSchema, JSON.stringify({ type: "object" }), "utf8");

    const linkPath = join(workspaceRoot, "link.schema.json");
    symlinkSync(externalSchema, linkPath);

    await expect(
      evaluateGate(
        {
          artifact: {},
          schema_ref: "link.schema.json",
          phase: "arm",
          criteria: [],
        },
        { workspaceRoot },
      ),
    ).rejects.toThrow("schema_ref must resolve within workspaceRoot");

    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it("fails in criterion order when a valid artifact misses required criteria", async () => {
    const workspace = createWorkspaceSchema({
      type: "object",
      required: ["title", "sections"],
      properties: {
        title: { type: "string" },
        sections: { type: "array", items: { type: "string" } },
      },
    });

    try {
      const result = await evaluateGate(
        {
          artifact: { title: "Design", sections: ["overview"] },
          artifact_ref: ".pipeline/runs/demo/design.json",
          schema_ref: workspace.schemaRef,
          phase: "design",
          criteria: [
            { name: "owner-present", type: "field-exists", path: "owner" },
            { name: "two-sections", type: "count-min", path: "sections", value: 2 },
            { name: "title-present", type: "field-exists", path: "title" },
          ],
        },
        { workspaceRoot: workspace.workspaceRoot, now: new Date("2026-08-11T10:00:00.000Z") },
      );

      expect(result.data).toEqual({
        gate_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ),
        phase: "design",
        status: "fail",
        criteria: [
          {
            name: "owner-present",
            passed: false,
            evidence: 'Field "owner" is missing or null',
          },
          {
            name: "two-sections",
            passed: false,
            evidence: 'Field "sections" has 1 item(s), minimum required: 2',
          },
          {
            name: "title-present",
            passed: true,
            evidence: 'Field "title" exists with type string',
          },
        ],
        blocking_failures: ["owner-present", "two-sections"],
        artifact_ref: ".pipeline/runs/demo/design.json",
        schema_validation: { valid: true, errors: [] },
        timestamp: "2026-08-11T10:00:00.000Z",
      });
      expect(result.logs).toEqual([
        `Validating artifact against schema: ${join(realpathSync(workspace.workspaceRoot), workspace.schemaRef)}`,
        "Schema validation: passed",
        "Criteria evaluated: 3, failures: 2",
      ]);
    } finally {
      workspace.remove();
    }
  });

  it("fails schema validation even when every criterion passes", async () => {
    const workspace = createWorkspaceSchema({
      type: "object",
      required: ["title", "version"],
      properties: {
        title: { type: "string" },
        version: { type: "string" },
      },
    });

    try {
      const result = await evaluateGate(
        {
          artifact: { title: "Design" },
          schema_ref: workspace.schemaRef,
          phase: "design",
          criteria: [{ name: "title-present", type: "field-exists", path: "title" }],
        },
        { workspaceRoot: workspace.workspaceRoot, now: new Date("2026-08-11T10:00:00.000Z") },
      );

      expect(result.data).toEqual({
        gate_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ),
        phase: "design",
        status: "fail",
        criteria: [
          {
            name: "title-present",
            passed: true,
            evidence: 'Field "title" exists with type string',
          },
        ],
        blocking_failures: [],
        artifact_ref: "inline:artifact",
        schema_validation: { valid: false, errors: ["/: must have required property 'version'"] },
        timestamp: "2026-08-11T10:00:00.000Z",
      });
      expect(result.logs).toEqual([
        `Validating artifact against schema: ${join(realpathSync(workspace.workspaceRoot), workspace.schemaRef)}`,
        "Schema validation: failed",
        "Schema errors: /: must have required property 'version'",
        "Criteria evaluated: 1, failures: 0",
      ]);
    } finally {
      workspace.remove();
    }
  });
});
