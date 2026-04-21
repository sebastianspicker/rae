import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Input } from "../../src/types.js";
import { runDriftDetect, runReview, validateInput } from "../../src/lib/engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../../..");

function loadSchema(pathFromRepoRoot: string): Record<string, unknown> {
  const fullPath = resolve(repoRoot, pathFromRepoRoot);
  return JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
}

function registerFormats(ajv: Ajv): void {
  ajv.addFormat("uri", {
    type: "string",
    validate: (value: string) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
  });

  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
}

function validateWithSchema(
  schema: Record<string, unknown>,
  data: unknown,
): { valid: boolean; errors: unknown[] } {
  const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
  registerFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors ?? [] };
}

describe("contract integration", () => {
  it("review output conforms to contracts/artifacts/review-report.schema.json", () => {
    const input: Input = {
      action: { type: "review" },
      document: { content: "# Design\n- Must use JWT", type: "design" },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [
            {
              id: "a-1",
              category: "architecture",
              description: "Missing service boundary",
              severity: "high",
              evidence: "Single module contains orchestration + persistence logic",
              suggestion: "Split orchestrator and repository layers",
            },
          ],
        },
        {
          reviewer_id: "security-engineer",
          role: "security",
          findings: [
            {
              id: "s-1",
              category: "security",
              description: "JWT validation rules are underspecified",
              severity: "medium",
            },
          ],
        },
      ],
    };
    validateInput(input);
    const logs: string[] = [];
    const data = runReview(input, logs);
    const schema = loadSchema("contracts/artifacts/review-report.schema.json");
    const validated = validateWithSchema(schema, data);

    expect(validated.valid).toBe(true);
    expect(validated.errors).toEqual([]);
    expect(data.fact_checks.length).toBe(data.deduplicated_findings.length);
  });

  it("drift output conforms to contracts/artifacts/drift-report.schema.json", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mmr-drift-contract-"));
    const targetPath = join(tempDir, "target.md");
    writeFileSync(targetPath, "# API\nREST only");

    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        source_ref: ".pipeline/runs/demo/plan.json",
        target_ref: "target.md",
      },
    };
    validateInput(input);
    const logs: string[] = [];
    const data = runDriftDetect(input, logs, { workspaceRoot: tempDir });
    const schema = loadSchema("contracts/artifacts/drift-report.schema.json");
    const validated = validateWithSchema(schema, data);

    expect(validated.valid).toBe(true);
    expect(validated.errors).toEqual([]);
    expect(data.adjudication.mode).toBe("heuristic");

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dual-extractor drift mode resolves conflicts and matches drift contract", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mmr-drift-dual-contract-"));
    const targetPath = join(tempDir, "target.md");
    writeFileSync(targetPath, "# API\nREST only");

    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        source_ref: ".pipeline/runs/demo/plan.json",
        target_ref: "target.md",
        mode: "dual-extractor",
        extractor_claim_sets: [
          {
            extractor: "extractor-a",
            claims: [
              {
                id: "claim-1",
                claim: "Must support GraphQL subscriptions",
                verification_status: "verified",
                evidence: "GraphQL service implementation found",
                confidence: 0.8,
              },
            ],
          },
          {
            extractor: "extractor-b",
            claims: [
              {
                id: "claim-1",
                claim: "Must support GraphQL subscriptions",
                verification_status: "violated",
                evidence: "Only REST endpoints documented",
                confidence: 0.9,
              },
            ],
          },
        ],
      },
    };

    validateInput(input);
    const data = runDriftDetect(input, [], { workspaceRoot: tempDir });
    const schema = loadSchema("contracts/artifacts/drift-report.schema.json");
    const validated = validateWithSchema(schema, data);

    expect(validated.valid).toBe(true);
    expect(validated.errors).toEqual([]);
    expect(data.adjudication.mode).toBe("dual-extractor");
    expect(data.adjudication.conflicts_resolved).toBeGreaterThan(0);
    expect(data.claims.some((claim) => claim.verification_status === "partial")).toBe(true);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects drift-detect without target_ref", () => {
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {},
    };

    expect(() => validateInput(input)).toThrow("drift_config.target_ref is required");
  });

  it("rejects drift-detect with empty target_ref", () => {
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "",
      },
    };

    expect(() => validateInput(input)).toThrow("drift_config.target_ref is required");
  });

  it("fails drift-detect when target_ref cannot be read", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mmr-drift-missing-target-"));
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "missing/file.md",
      },
    };
    validateInput(input);

    expect(() => runDriftDetect(input, [], { workspaceRoot: tempDir })).toThrow(
      "Could not read target_ref",
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects drift-detect with absolute target_ref", () => {
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "/tmp/target.md",
      },
    };

    expect(() => validateInput(input)).toThrow("must resolve within workspaceRoot");
  });

  it("rejects drift-detect target_ref traversal outside workspaceRoot", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mmr-drift-traversal-"));
    const workspaceRoot = join(baseDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });

    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "../outside.md",
      },
    };
    validateInput(input);

    expect(() => runDriftDetect(input, [], { workspaceRoot })).toThrow(
      "drift_config.target_ref must resolve within workspaceRoot",
    );

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects drift-detect target_ref symlink escapes outside workspaceRoot", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "mmr-drift-workspace-link-"));
    const externalDir = mkdtempSync(join(tmpdir(), "mmr-drift-external-link-"));
    const externalTarget = join(externalDir, "target.md");
    writeFileSync(externalTarget, "# external", "utf8");

    const linkPath = join(workspaceRoot, "target.md");
    symlinkSync(externalTarget, linkPath);

    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "target.md",
      },
    };
    validateInput(input);

    expect(() => runDriftDetect(input, [], { workspaceRoot })).toThrow(
      "drift_config.target_ref must resolve within workspaceRoot",
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  });

  it("rejects dual-extractor mode without extractor claim sets", () => {
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        mode: "dual-extractor",
        target_ref: "placeholder.md",
      },
    };

    expect(() => validateInput(input)).toThrow("extractor_claim_sets");
  });

  it("rejects review findings entries missing findings arrays", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
        } as unknown as Input["reviewer_findings"][number],
      ],
    };

    expect(() => validateInput(input)).toThrow("Each reviewer_findings entry requires");
  });

  it("rejects review entries with empty findings arrays", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [],
        },
      ],
    };

    expect(() => validateInput(input)).toThrow("non-empty findings array");
  });

  it("rejects review findings with invalid severity enum", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [
            {
              id: "f-1",
              category: "security",
              description: "Invalid severity should be rejected",
              severity: "urgent" as unknown as "medium",
            },
          ],
        },
      ],
    };

    expect(() => validateInput(input)).toThrow("severity must be one of");
  });

  it("rejects non-string optional finding fields", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [
            {
              id: "f-1",
              category: "security",
              description: "Optional fields must stay typed",
              severity: "medium",
              evidence: 123 as unknown as string,
            },
          ],
        },
      ],
    };

    expect(() => validateInput(input)).toThrow("evidence must be a string");
  });

  it("rejects unexpected properties in reviewer_findings entries", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [],
          extra: "not-allowed",
        } as unknown as Input["reviewer_findings"][number],
      ],
    };

    expect(() => validateInput(input)).toThrow("Unexpected property");
  });

  it("rejects malformed reviewer_findings even for drift-detect action", () => {
    const input: Input = {
      action: { type: "drift-detect" },
      document: {
        content: "# API\n- Must support GraphQL subscriptions",
        type: "plan",
      },
      drift_config: {
        target_ref: "placeholder.md",
      },
      reviewer_findings: [
        {
          foo: "bar",
        } as unknown as Input["reviewer_findings"][number],
      ],
    };

    expect(() => validateInput(input)).toThrow("reviewer_findings");
  });

  it("rejects malformed drift_config even for review action", () => {
    const input: Input = {
      action: { type: "review" },
      document: {
        content: "# Design\n- Must keep schema contracts as source of truth.",
        type: "design",
      },
      reviewer_findings: [
        {
          reviewer_id: "architect-reviewer",
          role: "architect",
          findings: [
            {
              id: "f-1",
              category: "security",
              description: "Typed review entry",
              severity: "low",
            },
          ],
        },
      ],
      drift_config: {
        target_ref: 123 as unknown as string,
      },
    };

    expect(() => validateInput(input)).toThrow("drift_config.target_ref");
  });
});
