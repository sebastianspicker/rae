/** Assembles bounded, ordered, replayable provider context for workflow v2.2. */
import { createHash } from "node:crypto";

export const DEFAULT_CONTEXT_CAP_BYTES = 128 * 1024;
export const MIN_CONTEXT_CAP_BYTES = 16 * 1024;
export const MAX_CONTEXT_CAP_BYTES = 256 * 1024;

export class ContextOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const bytes = (value) => Buffer.byteLength(JSON.stringify(canonical(value)), "utf8");
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

function assertCap(capBytes) {
  if (
    !Number.isInteger(capBytes) ||
    capBytes < MIN_CONTEXT_CAP_BYTES ||
    capBytes > MAX_CONTEXT_CAP_BYTES
  ) {
    throw new ContextOverflowError(
      `workflow context cap must be an integer from ${MIN_CONTEXT_CAP_BYTES} to ${MAX_CONTEXT_CAP_BYTES} bytes`,
    );
  }
}

function refFor(entry, source, value, summary = null) {
  const envelope = entry.envelope ?? entry;
  const sourceDigest = envelope.output_digest ?? entry.digest ?? digest(value);
  const instance = String(
    envelope.instance_id ?? envelope.node_id ?? entry.id ?? source,
  ).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return {
    kind: source,
    source_digest: sourceDigest,
    bytes: bytes(value),
    artifact_ref: envelope.node_id
      ? `workflow/attempts/${envelope.node_id}/${instance}.${envelope.attempt}.json`
      : null,
    summary,
  };
}

function addItem({
  selected,
  omitted,
  capBytes,
  item,
  source,
  mandatory,
  value,
  summary = null,
  canReference = true,
}) {
  const sourceDigest = digest(value);
  const inline = { source, source_digest: sourceDigest, value };
  const candidate = [...selected, inline];
  if (bytes({ items: candidate }) <= capBytes) {
    selected.push(inline);
    return;
  }
  if (!canReference) {
    if (mandatory)
      throw new ContextOverflowError(
        `mandatory workflow context exceeds its ${capBytes}-byte cap before provider invocation`,
      );
    omitted.push({
      source,
      source_digest: sourceDigest,
      bytes: bytes(value),
      reason: "optional-budget",
      trust_class: item.trust_class ?? "local",
    });
    return;
  }
  const reference = {
    source,
    source_digest: sourceDigest,
    reference: refFor(item, source, value, summary),
  };
  if (bytes({ items: [...selected, reference] }) <= capBytes) {
    selected.push(reference);
    return;
  }
  const record = {
    source,
    source_digest: sourceDigest,
    bytes: bytes(value),
    reason: mandatory ? "mandatory-overflow" : "optional-budget",
    trust_class: item.trust_class ?? "local",
  };
  if (mandatory)
    throw new ContextOverflowError(
      `mandatory workflow context exceeds its ${capBytes}-byte cap before provider invocation`,
    );
  omitted.push(record);
}

function predecessor(entry) {
  const envelope = entry.envelope;
  return {
    edge_type: entry.edge.type,
    node_id: envelope.node_id,
    instance_id: envelope.instance_id ?? envelope.node_id,
    status: envelope.status,
    payload: envelope.payload,
    findings: envelope.findings ?? [],
    evidence_refs: envelope.evidence_refs ?? [],
  };
}

function operational(entry) {
  const envelope = entry.envelope;
  return {
    node_id: envelope.node_id,
    changed_paths: envelope.changed_paths ?? [],
    command_evidence: envelope.command_evidence ?? [],
    resource_usage: envelope.resource_usage ?? {},
  };
}

/**
 * Builds one stable context in strict source order. Mandatory records never
 * truncate: a complete inline object, a complete immutable reference, or a
 * pre-provider overflow error. Optional sources require explicit policy.
 */
export function assembleWorkflowContextV22({
  task = "",
  node = { id: "unknown", guidance: "" },
  item = null,
  inputs = [],
  verifiedGraphRecords = [],
  admittedMemory = [],
  contextPolicy = {},
  capBytes = DEFAULT_CONTEXT_CAP_BYTES,
}) {
  assertCap(capBytes);
  const selected = [];
  const omitted = [];
  const mandatory = [
    ["task", { trust_class: "operator" }, { task }],
    ["node-guidance", { trust_class: "workflow" }, { node_id: node.id, guidance: node.guidance }],
    ["mapped-item", { trust_class: "workflow" }, { item }],
    ...[...inputs]
      .sort((left, right) =>
        String(left.envelope.instance_id ?? left.envelope.node_id).localeCompare(
          String(right.envelope.instance_id ?? right.envelope.node_id),
        ),
      )
      .map((entry) => ["predecessor", entry, predecessor(entry)]),
  ];
  for (const [source, entry, value] of mandatory)
    addItem({
      selected,
      omitted,
      capBytes,
      item: entry,
      source,
      mandatory: true,
      value,
      canReference: source === "predecessor",
    });
  const optionalBudget = Math.min(Number(contextPolicy.optional_budget_bytes ?? 0), capBytes);
  const optional = [];
  if (
    contextPolicy.allow_operational_evidence === true &&
    node.context?.include_operational_evidence === true
  ) {
    optional.push(...inputs.map((entry) => ["operational", entry, operational(entry)]));
  } else if (node.context?.include_operational_evidence === true) {
    omitted.push(
      ...inputs.map((entry) => ({
        source: "operational",
        source_digest: digest(operational(entry)),
        bytes: bytes(operational(entry)),
        reason: "policy-denied",
        trust_class: "local",
      })),
    );
  }
  if (contextPolicy.allow_verified_graph === true)
    optional.push(...verifiedGraphRecords.map((entry) => ["verified-graph", entry, entry]));
  else
    omitted.push(
      ...verifiedGraphRecords.map((entry) => ({
        source: "verified-graph",
        source_digest: digest(entry),
        bytes: bytes(entry),
        reason: "policy-denied",
        trust_class: entry.trust_class ?? "advisory",
      })),
    );
  if (contextPolicy.allow_admitted_memory === true)
    optional.push(...admittedMemory.map((entry) => ["admitted-memory", entry, entry]));
  else
    omitted.push(
      ...admittedMemory.map((entry) => ({
        source: "admitted-memory",
        source_digest: digest(entry),
        bytes: bytes(entry),
        reason: "policy-denied",
        trust_class: entry.trust_class ?? "advisory",
      })),
    );
  let optionalUsed = 0;
  for (const [source, entry, value] of optional) {
    const entryBytes = bytes(value);
    if (optionalUsed + entryBytes > optionalBudget) {
      omitted.push({
        source,
        source_digest: digest(value),
        bytes: entryBytes,
        reason: "optional-budget",
        trust_class: entry.trust_class ?? "advisory",
      });
      continue;
    }
    const before = selected.length;
    addItem({
      selected,
      omitted,
      capBytes,
      item: entry,
      source,
      mandatory: false,
      value,
      summary: entry.summary ?? null,
    });
    if (selected.length > before) optionalUsed += entryBytes;
  }
  const assembledBytes = bytes({ items: selected });
  const included = selected.map((entry) => ({
    source: entry.source,
    source_digest: entry.source_digest,
    bytes: bytes(entry.value ?? entry.reference),
    reason: entry.reference ? "artifact-reference" : "inline",
    trust_class: entry.value?.trust_class ?? "local",
  }));
  const manifest = {
    cap_bytes: capBytes,
    assembled_bytes: assembledBytes,
    mandatory_budget_bytes: capBytes,
    optional_budget_bytes: optionalBudget,
    included,
    omitted,
    artifact_refs: selected.filter((entry) => entry.reference).map((entry) => entry.reference),
    inline_artifacts: selected
      .filter((entry) => entry.value)
      .map(({ source, source_digest }) => ({ source, source_digest })),
  };
  return Object.freeze({
    manifest: Object.freeze(manifest),
    prompt_context: Object.freeze({ items: selected }),
    digest: digest(manifest),
  });
}
