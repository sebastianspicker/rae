import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluateGate } from "../../src/lib/engine.js";
import { validateArtifact } from "../../src/lib/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");

describe("quality-gate contract integration", () => {
  it("produces gate data that conforms to contracts/quality-gate.schema.json", async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "quality-gate-contract-"));
    const schemaPath = join(sandboxDir, "artifact.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
        },
      }),
    );

    const { data } = await evaluateGate(
      {
        artifact: { title: "Example" },
        artifact_ref: ".pipeline/runs/demo/design.json",
        schema_ref: "artifact.schema.json",
        phase: "design",
        criteria: [{ name: "has-title", type: "field-exists", path: "title" }],
      },
      {
        workspaceRoot: sandboxDir,
        now: new Date("2026-02-22T00:00:00.000Z"),
      },
    );

    const contractSchemaPath = resolve(repoRoot, "contracts/quality-gate.schema.json");
    const contractValidation = await validateArtifact(data, contractSchemaPath);

    expect(contractValidation.valid).toBe(true);
    expect(contractValidation.errors).toEqual([]);
    expect(data.artifact_ref).toBe(".pipeline/runs/demo/design.json");

    rmSync(sandboxDir, { recursive: true, force: true });
  });
});
