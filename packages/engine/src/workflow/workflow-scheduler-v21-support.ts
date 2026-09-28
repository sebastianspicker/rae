/** Supplies bounded, side-effect-narrow helpers for the v2.1 workflow scheduler. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./workflow-contract.js";
import { validateNodeEnvelope } from "./workflow-envelope.js";
import type {
  JsonValue,
  WorkflowsNodeEnvelopeV21,
  WorkflowsWorkflowV21,
  WorkflowsWorkflowV21DefsEdge,
} from "@rae/contracts";

export const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const successful = (envelope: WorkflowsNodeEnvelopeV21): boolean =>
  envelope.status === "passed";
export const valueOr = <T>(value: T | undefined, fallback: T): T =>
  value === undefined ? fallback : value;

function payloadField(payload: JsonValue, key: string): JsonValue | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload[key];
}

export function conditionMatches(
  edge: WorkflowsWorkflowV21DefsEdge,
  envelope: WorkflowsNodeEnvelopeV21,
): boolean {
  if (!edge.condition || edge.condition === "success") return successful(envelope);
  if (edge.condition === "failure") {
    return ["failed", "blocked", "collected"].includes(envelope.status);
  }
  if (edge.condition === "budget-available") {
    return payloadField(envelope.payload, "budget_available") !== false;
  }
  if (edge.condition === "blocking-findings") {
    return envelope.findings.some(
      (finding) => finding.blocking === true || finding.severity === "blocking",
    );
  }
  return false;
}

export function predecessors(
  workflow: WorkflowsWorkflowV21,
  nodeId: string,
): WorkflowsWorkflowV21DefsEdge[] {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

export function persistEnvelope(runDir: string | null, envelope: WorkflowsNodeEnvelopeV21): void {
  validateNodeEnvelope(envelope);
  if (!runDir) return;
  const directory = resolve(runDir, "workflow", "attempts", envelope.node_id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const safeInstance = envelope.instance_id.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(
    resolve(directory, `${safeInstance}.${envelope.attempt}.json`),
    `${JSON.stringify(envelope, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

export function instanceId(nodeId: string, itemKey: string | null): string {
  return itemKey === null ? nodeId : `${nodeId}:${digest(String(itemKey)).slice(0, 16)}`;
}

export function pendingInstanceId(
  nodeId: string,
  itemKey: string | null,
  loop: unknown,
  loopIteration: number,
): string {
  const stableId = instanceId(nodeId, itemKey);
  return loop && loopIteration > 1 && itemKey === null
    ? `${stableId}:loop-${loopIteration}`
    : stableId;
}

export function freezeEnvelope(
  value: Partial<WorkflowsNodeEnvelopeV21>,
): Readonly<WorkflowsNodeEnvelopeV21> {
  return Object.freeze({
    schema_version: "2.1.0",
    findings: [],
    evidence_refs: [],
    ownership: {},
    changed_paths: [],
    command_evidence: [],
    resource_usage: {},
    parent_node: null,
    item_key: null,
    item_digest: null,
    failure: null,
    selection: null,
    quorum: null,
    convergence: null,
    execution_tier: "standard",
    ...value,
  } as WorkflowsNodeEnvelopeV21);
}

export function failureEnvelope(
  base: Partial<WorkflowsNodeEnvelopeV21>,
  error: unknown,
): Readonly<WorkflowsNodeEnvelopeV21> {
  const failure = {
    type: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
  const payload = { status: "failed", failure };
  return freezeEnvelope({
    ...base,
    status: "failed",
    failure,
    payload,
    findings: [],
    output_digest: digest(payload),
  });
}

export interface JoinInput {
  envelope: WorkflowsNodeEnvelopeV21;
  [key: string]: unknown;
}

export type AnyJoinDecision =
  | { impossible: true; reason: string }
  | { ready: false }
  | { ready: true; inputs: JoinInput[]; selection: { mode: "any"; winner: string } };

export function anyJoinDecision(passed: JoinInput[], allSettled: boolean): AnyJoinDecision {
  if (passed.length === 0) {
    return allSettled
      ? { impossible: true, reason: "any join has no successful input" }
      : { ready: false };
  }
  const winner = passed[0];
  if (!winner) return { ready: false };
  return {
    ready: true,
    inputs: [winner],
    selection: { mode: "any", winner: winner.envelope.instance_id },
  };
}
