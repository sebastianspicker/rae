/** Supplies bounded, side-effect-narrow helpers for the v2.1 workflow scheduler. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "./workflow-contract.mjs";
import { validateNodeEnvelope } from "./workflow-envelope.mjs";

export const digest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
export const successful = (envelope) => envelope.status === "passed";
export const valueOr = (value, fallback) => (value === undefined ? fallback : value);

export function conditionMatches(edge, envelope) {
  if (!edge.condition || edge.condition === "success") return successful(envelope);
  if (edge.condition === "failure") {
    return ["failed", "blocked", "collected"].includes(envelope.status);
  }
  if (edge.condition === "budget-available") return envelope.payload?.budget_available !== false;
  if (edge.condition === "blocking-findings") {
    return envelope.findings.some(
      (finding) => finding.blocking === true || finding.severity === "blocking",
    );
  }
  return false;
}

export function predecessors(workflow, nodeId) {
  return workflow.edges.filter((edge) => edge.to === nodeId && edge.type !== "loop-back");
}

export function persistEnvelope(runDir, envelope) {
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

export function instanceId(nodeId, itemKey) {
  return itemKey === null ? nodeId : `${nodeId}:${digest(String(itemKey)).slice(0, 16)}`;
}

export function pendingInstanceId(nodeId, itemKey, loop, loopIteration) {
  const stableId = instanceId(nodeId, itemKey);
  return loop && loopIteration > 1 && itemKey === null
    ? `${stableId}:loop-${loopIteration}`
    : stableId;
}

export function freezeEnvelope(value) {
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
  });
}

export function failureEnvelope(base, error) {
  const failure = { type: error?.name ?? "Error", message: error?.message ?? String(error) };
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

export function anyJoinDecision(passed, allSettled) {
  if (passed.length === 0) {
    return allSettled
      ? { impossible: true, reason: "any join has no successful input" }
      : { ready: false };
  }
  const winner = passed[0];
  return {
    ready: true,
    inputs: [winner],
    selection: { mode: "any", winner: winner.envelope.instance_id },
  };
}
