import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateGate } from "../../src/lib/engine.js";

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
});
