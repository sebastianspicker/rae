/**
 * Coordinates validated artifacts, schemas, and criteria into a deterministic gate result.
 */
import { randomUUID } from "node:crypto";
import { resolveWithinWorkspace } from "@coding-agents-space/shared";
import type {
  CriterionResult,
  GateResult,
  GateStatus,
  Input,
  SchemaValidationResult,
} from "../types.js";
import { evaluateCriteria } from "./criteria.js";
import { validateInput } from "./input.js";
import { validateArtifact } from "./validate.js";

interface EvaluateGateOptions {
  workspaceRoot?: string;
  now?: Date;
}

/**
 * Derives the deterministic gate verdict from completed schema and criterion checks.
 */
export function deriveGateVerdict(
  schemaValidation: SchemaValidationResult,
  criteriaResults: CriterionResult[],
): Pick<GateResult, "status" | "blocking_failures"> {
  const blockingFailures = criteriaResults
    .filter((result) => !result.passed)
    .map((result) => result.name);
  const status: GateStatus =
    !schemaValidation.valid || blockingFailures.length > 0 ? "fail" : "pass";

  return { status, blocking_failures: blockingFailures };
}

/**
 * Coordinates schema and criterion evaluation while keeping schema references inside the workspace.
 */
export async function evaluateGate(
  input: Input,
  opts: EvaluateGateOptions = {},
): Promise<{ data: GateResult; logs: string[] }> {
  validateInput(input);

  const workspaceRoot = opts.workspaceRoot ?? "/workspace";
  const logs: string[] = [];
  const schemaPath = resolveWithinWorkspace(workspaceRoot, input.schema_ref, "schema_ref");
  logs.push(`Validating artifact against schema: ${schemaPath}`);

  const schemaValidation = await validateArtifact(input.artifact, schemaPath);
  logs.push(`Schema validation: ${schemaValidation.valid ? "passed" : "failed"}`);
  if (schemaValidation.errors.length > 0) {
    logs.push(`Schema errors: ${schemaValidation.errors.join("; ")}`);
  }

  const criteriaResults = evaluateCriteria(input.artifact, input.criteria);
  const verdict = deriveGateVerdict(schemaValidation, criteriaResults);

  logs.push(
    `Criteria evaluated: ${criteriaResults.length}, failures: ${verdict.blocking_failures.length}`,
  );

  return {
    data: {
      gate_id: randomUUID(),
      phase: input.phase,
      status: verdict.status,
      criteria: criteriaResults,
      blocking_failures: verdict.blocking_failures,
      artifact_ref: input.artifact_ref ?? "inline:artifact",
      schema_validation: schemaValidation,
      timestamp: (opts.now ?? new Date()).toISOString(),
    },
    logs,
  };
}
