import type { GatePhase } from "./lib/phases.js";

export type { GatePhase };

export type CriterionType =
  | "field-exists"
  | "field-empty"
  | "count-min"
  | "count-max"
  | "number-max"
  | "coverage-min"
  | "regex-match";

export type GateStatus = "pass" | "fail" | "warn";

export interface Criterion {
  name: string;
  type: CriterionType;
  path: string;
  value?: unknown;
  source_path?: string;
  source_filter_path?: string;
  source_filter_value?: unknown;
  target_paths?: string[];
}

export interface Input {
  artifact: Record<string, unknown>;
  artifact_ref?: string;
  schema_ref: string;
  phase: GatePhase;
  criteria: Criterion[];
}

export interface CriterionResult {
  name: string;
  passed: boolean;
  evidence: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export interface GateResult {
  gate_id: string;
  phase: GatePhase;
  status: GateStatus;
  criteria: CriterionResult[];
  blocking_failures: string[];
  artifact_ref: string;
  schema_validation: SchemaValidationResult;
  timestamp?: string;
}
