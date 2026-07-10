import { expect, it } from "vitest";
import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function expectSchemaValid(schemaPath: string, data: unknown): void {
  const schema = loadSchema(schemaPath);
  const ajv = new Ajv({
    allErrors: false,
    strict: false,
    validateSchema: false,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);
  const valid = validate(data);
  expect(valid, `${schemaPath}: ${JSON.stringify(validate.errors ?? [])}`).toBe(true);
}

function expectSchemaInvalid(schemaPath: string, data: unknown): void {
  const schema = loadSchema(schemaPath);
  const ajv = new Ajv({
    allErrors: false,
    strict: false,
    validateSchema: false,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);
  const valid = validate(data);
  expect(valid).toBe(false);
}

function createBriefArtifact(): Record<string, unknown> {
  return {
    requirements: [
      {
        id: "req-1",
        description: "The pipeline must block on failed quality gates.",
        priority: "must",
      },
    ],
    constraints: [
      {
        type: "hard",
        description: "Node.js 20+ runtime is required.",
        source: "platform",
      },
    ],
    non_goals: [
      {
        description: "Do not add external paid model APIs.",
        reason: "Core must stay API-key free.",
      },
    ],
    style: {
      tone: "concise",
      patterns: ["phase-based"],
      conventions: ["artifact contracts"],
    },
    key_concepts: [
      {
        term: "quality gate",
        definition: "A blocking checkpoint that must pass before progression.",
      },
    ],
    decisions: [
      {
        decision: "Use artifact schemas as canonical contracts.",
        rationale: "Deterministic validation across all phases.",
      },
    ],
    open_questions: [],
  };
}

it("keeps arm -> design -> ar -> plan -> pmatch artifacts schema-conformant", () => {
  const briefArtifact = createBriefArtifact();
  expectSchemaValid("contracts/artifacts/brief.schema.json", briefArtifact);

  const designArtifact = {
    analysis: {
      summary: "Use contract-driven handoffs with independent validation contexts.",
      principles: [
        {
          principle: "Context minimization",
          implication: "Each phase receives only the scope it needs.",
        },
      ],
    },
    constraints_classification: [
      {
        constraint: "Node.js 20+ runtime is required.",
        original_type: "hard",
        validated_type: "hard",
        evaluation: "Required by runtime toolchains and CI configuration.",
        flagged: false,
      },
    ],
    approach: {
      description: "Enforce schema contracts and phase-level gate checks.",
      rationale: "Prevent drift and reduce ambiguous execution.",
      components: [
        {
          name: "quality-gate",
          responsibility: "Validate artifacts and acceptance criteria.",
          interfaces: ["contracts/quality-gate.schema.json"],
        },
      ],
    },
    research: [
      {
        source: "Repository contracts",
        url: "https://example.com/contracts",
        finding: "Artifact schemas define non-ambiguous handoff structure.",
        verified_at: "2026-02-22T00:00:00Z",
      },
    ],
    codebase_alignment: [
      {
        pattern: "Schema-first contracts",
        file_paths: ["contracts/artifacts/review-report.schema.json"],
        alignment_status: "aligned",
        notes: "Existing runtime output already targets artifact schemas.",
      },
    ],
    iteration_history: [
      {
        iteration: 1,
        changes: "Clarified claim verification outputs for drift detection.",
        rationale: "Improve deterministic reporting in pmatch phase.",
      },
    ],
  };
  expectSchemaValid("contracts/artifacts/design-document.schema.json", designArtifact);

  const reviewInput: Input = {
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
            id: "arch-1",
            category: "architecture",
            description: "Plan should include explicit ownership map.",
            severity: "medium",
            evidence: "Ownership conflict risks parallel build collisions.",
          },
        ],
      },
      {
        reviewer_id: "security-engineer",
        role: "security",
        findings: [
          {
            id: "sec-1",
            category: "security",
            description: "Drift checks should fail on unreadable target references.",
            severity: "high",
          },
        ],
      },
    ],
  };
  validateInput(reviewInput);
  const reviewArtifact = runReview(reviewInput, []);
  expectSchemaValid("contracts/artifacts/review-report.schema.json", reviewArtifact);

  const executionPlanArtifact = {
    task_groups: [
      {
        group_id: "group-core",
        builder_tier: "high_reasoning",
        scope_override: {
          reason:
            "This phase has only one schema-focused task; using a single-task group intentionally.",
        },
        tasks: [
          {
            id: "task-1",
            description: "Enforce capability-tier based builder allocation.",
            execution_session: {
              session_id: "build-task-1",
              session_kind: "build-task",
              fresh_context: true,
              inherits_history: false,
              max_attempts: 2,
              retry_behavior: "restart-fresh-session",
            },
            context_manifest: {
              selection_policy: "task-scoped-minimal",
              ordering_policy: "owned-files-first-then-requirements",
              files_loaded: [
                {
                  path: "contracts/artifacts/execution-plan.schema.json",
                  bytes: 512,
                },
              ],
              docs_loaded: [
                {
                  url: "https://example.com/task-context",
                  retrieved_at: "2026-04-14T00:00:00Z",
                },
              ],
              token_estimate: 1200,
              char_count_estimate: 4800,
            },
            file_paths: ["contracts/artifacts/execution-plan.schema.json"],
            code_patterns: [
              {
                file: "contracts/artifacts/execution-plan.schema.json",
                pattern: "builder_tier enum = [high_reasoning, balanced, fast]",
              },
            ],
            test_cases: [
              {
                name: "reject-legacy-builder-tier",
                execution_session: {
                  session_id: "quality-case-reject-legacy-builder-tier",
                  session_kind: "quality-case",
                  fresh_context: true,
                  inherits_history: false,
                  max_attempts: 2,
                  retry_behavior: "restart-fresh-session",
                },
                context_manifest: {
                  selection_policy: "task-scoped-minimal",
                  ordering_policy: "owned-files-first-then-requirements",
                  files_loaded: [
                    {
                      path: "contracts/artifacts/execution-plan.schema.json",
                      bytes: 512,
                    },
                  ],
                  docs_loaded: [
                    {
                      url: "https://example.com/task-context",
                      retrieved_at: "2026-04-14T00:00:00Z",
                    },
                  ],
                  token_estimate: 1200,
                  char_count_estimate: 4800,
                },
                setup: "Validate plan artifact with non-canonical builder tier.",
                assertion: "Schema validation fails",
                expected: "non-canonical value rejected",
              },
            ],
            acceptance_criteria: ["Execution plan schema accepts only canonical capability tiers."],
          },
        ],
      },
    ],
    file_ownership: {
      "contracts/artifacts/execution-plan.schema.json": "group-core",
    },
    verification_commands: [
      {
        command: "./scripts/verify.sh",
        description: "Run repository verification after changes.",
      },
    ],
  };
  expectSchemaValid("contracts/artifacts/execution-plan.schema.json", executionPlanArtifact);

  const tempDir = mkdtempSync(join(tmpdir(), "pipeline-fixture-"));
  const targetPath = join(tempDir, "implementation.md");
  writeFileSync(
    targetPath,
    [
      "# Execution",
      "- Run ./scripts/verify.sh after implementation.",
      "- Attach schema validation evidence to gate artifacts.",
    ].join("\n"),
    "utf8",
  );

  const driftInput: Input = {
    action: { type: "drift-detect" },
    document: {
      content: [
        "# Execution",
        "- Must run ./scripts/verify.sh after implementation.",
        "- Must attach schema validation evidence to gate artifacts.",
      ].join("\n"),
      type: "plan",
    },
    drift_config: {
      source_ref: ".pipeline/runs/demo/plan.json",
      target_ref: "implementation.md",
    },
  };
  validateInput(driftInput);
  const driftArtifact = runDriftDetect(driftInput, [], { workspaceRoot: tempDir });
  expectSchemaValid("contracts/artifacts/drift-report.schema.json", driftArtifact);

  rmSync(tempDir, { recursive: true, force: true });
});

it("rejects design artifacts when research.verified_at is missing", () => {
  const invalidDesignArtifact = {
    analysis: {
      summary: "Use contract-driven handoffs with independent validation contexts.",
      principles: [
        {
          principle: "Context minimization",
          implication: "Each phase receives only the scope it needs.",
        },
      ],
    },
    constraints_classification: [
      {
        constraint: "Node.js 20+ runtime is required.",
        original_type: "hard",
        validated_type: "hard",
        evaluation: "Required by runtime toolchains and CI configuration.",
        flagged: false,
      },
    ],
    approach: {
      description: "Enforce schema contracts and phase-level gate checks.",
      rationale: "Prevent drift and reduce ambiguous execution.",
    },
    research: [
      {
        source: "Repository contracts",
        finding: "Artifact schemas define non-ambiguous handoff structure.",
      },
    ],
    codebase_alignment: [
      {
        pattern: "Schema-first contracts",
        alignment_status: "aligned",
      },
    ],
    iteration_history: [
      {
        iteration: 1,
        changes: "Initial draft",
        rationale: "Test required research timestamp",
      },
    ],
  };

  expectSchemaInvalid("contracts/artifacts/design-document.schema.json", invalidDesignArtifact);
});
