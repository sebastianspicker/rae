/** Builds bounded provider context for workflow 2.0 and 2.1 without changing their envelopes. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { canonicalJson } from "./workflow-contract.mjs";
import { validateNodeEnvelope } from "./workflow-envelope.mjs";

export const BOUNDED_CONTEXT_BYTES = 128 * 1024;
export const CONTEXT_POLICY_VERSION = "1.0.0";

const POLICIES = Object.freeze({
  legacy: Object.freeze({
    schema_version: CONTEXT_POLICY_VERSION,
    mode: "legacy",
    assembly: "typed-predecessor-envelopes",
  }),
  bounded: Object.freeze({
    schema_version: CONTEXT_POLICY_VERSION,
    mode: "bounded",
    max_bytes: BOUNDED_CONTEXT_BYTES,
    source_order: Object.freeze(["task", "node-guidance", "mapped-item", "predecessor"]),
    predecessor_overflow: "verified-immutable-attempt-reference",
  }),
});

export class BoundedContextOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoundedContextOverflowError";
  }
}

export function contextPolicyDigest(policy) {
  return createHash("sha256").update(canonicalJson(policy)).digest("hex");
}

export function contextPolicySnapshot(mode = "legacy") {
  const policy = POLICIES[mode];
  if (!policy) throw new Error("context mode must be legacy or bounded");
  return policy;
}

export function validateContextPolicy(value) {
  const expected = contextPolicySnapshot(value?.mode);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("stored context policy does not match its versioned contract");
  }
  return expected;
}

function byteLength(value) {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function predecessorValue(entry) {
  const envelope = entry.envelope;
  return {
    edge_type: entry.edge.type,
    artifact: entry.edge.artifact ?? null,
    node_id: envelope.node_id,
    instance_id: envelope.instance_id ?? envelope.node_id,
    attempt: envelope.attempt,
    loop_iteration: envelope.loop_iteration ?? 1,
    status: envelope.status,
    payload: envelope.payload,
    findings: envelope.findings ?? [],
  };
}

function safeInstance(envelope) {
  return String(envelope.instance_id ?? envelope.node_id).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function attemptRelativePath(envelope) {
  const filename =
    envelope.schema_version === "2.0.0"
      ? `${envelope.loop_iteration ?? 1}.${envelope.attempt}.json`
      : `${safeInstance(envelope)}.${envelope.attempt}.json`;
  return `workflow/attempts/${envelope.node_id}/${filename}`;
}

function expectedOutputDigest(envelope) {
  if (envelope.schema_version === "2.0.0" || envelope.failure) {
    return digest(envelope.payload);
  }
  return digest({
    payload: envelope.payload,
    findings: envelope.findings ?? [],
    evidence_refs: envelope.evidence_refs ?? [],
    ownership: envelope.ownership ?? {},
    changed_paths: envelope.changed_paths ?? [],
    command_evidence: envelope.command_evidence ?? [],
    resource_usage: envelope.resource_usage ?? {},
    selection: envelope.selection ?? null,
    quorum: envelope.quorum ?? null,
    convergence: envelope.convergence ?? null,
  });
}

function verifiedAttemptReference(runDir, entry, value) {
  if (!runDir) {
    throw new BoundedContextOverflowError(
      "bounded predecessor overflow requires a durable immutable attempt artifact",
    );
  }
  const envelope = entry.envelope;
  const artifactRef = attemptRelativePath(envelope);
  const absolute = resolve(runDir, artifactRef);
  const relation = relative(resolve(runDir), absolute);
  if (!relation || relation.startsWith("..") || !existsSync(absolute)) {
    throw new BoundedContextOverflowError(
      "bounded predecessor overflow has no verified immutable attempt artifact",
    );
  }
  const details = lstatSync(absolute);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new BoundedContextOverflowError(
      "bounded predecessor overflow attempt artifact is not a regular file",
    );
  }
  const canonicalRunDir = realpathSync(runDir);
  const canonicalArtifact = realpathSync(absolute);
  const canonicalRelation = relative(canonicalRunDir, canonicalArtifact);
  if (!canonicalRelation || canonicalRelation.startsWith("..")) {
    throw new BoundedContextOverflowError(
      "bounded predecessor overflow attempt artifact escapes the durable run directory",
    );
  }
  let persisted;
  let persistedBody;
  try {
    persistedBody = readFileSync(absolute, "utf8");
    persisted = validateNodeEnvelope(JSON.parse(persistedBody));
  } catch (error) {
    throw new BoundedContextOverflowError(
      `bounded predecessor overflow attempt artifact is invalid: ${error.message}`,
    );
  }
  const identity = ["run_id", "workflow_digest", "node_id", "attempt", "output_digest"];
  if (
    identity.some((key) => persisted[key] !== envelope[key]) ||
    (persisted.instance_id ?? persisted.node_id) !== (envelope.instance_id ?? envelope.node_id) ||
    (persisted.loop_iteration ?? 1) !== (envelope.loop_iteration ?? 1) ||
    persisted.output_digest !== expectedOutputDigest(persisted) ||
    canonicalJson(persisted) !== canonicalJson(JSON.parse(JSON.stringify(envelope)))
  ) {
    throw new BoundedContextOverflowError(
      "bounded predecessor overflow attempt artifact does not match the scheduled input",
    );
  }
  return {
    artifact_ref: artifactRef,
    artifact_digest: createHash("sha256").update(persistedBody).digest("hex"),
    source_digest: digest(value),
    output_digest: envelope.output_digest,
    bytes: byteLength(value),
  };
}

function appendMandatory(items, item, source) {
  const candidate = [...items, item];
  if (byteLength({ items: candidate }) > BOUNDED_CONTEXT_BYTES) {
    throw new BoundedContextOverflowError(
      `mandatory ${source} context exceeds ${BOUNDED_CONTEXT_BYTES} bytes before provider invocation`,
    );
  }
  items.push(item);
}

function orderedInputs(inputs) {
  return [...inputs].sort((left, right) => {
    const leftId = String(left.envelope.instance_id ?? left.envelope.node_id);
    const rightId = String(right.envelope.instance_id ?? right.envelope.node_id);
    return leftId.localeCompare(rightId) || left.edge.from.localeCompare(right.edge.from);
  });
}

/**
 * Returns deterministic prompt data plus measured assembly evidence. A complete
 * predecessor is either inline or represented by its exact persisted attempt.
 */
export function assembleBoundedWorkflowContext({
  task = "",
  node = { id: "unknown", guidance: "" },
  item = null,
  inputs = [],
  runDir = null,
  now = () => performance.now(),
}) {
  const started = now();
  const items = [];
  appendMandatory(items, { source: "task", value: { task } }, "task");
  appendMandatory(
    items,
    { source: "node-guidance", value: { node_id: node.id, guidance: node.guidance ?? "" } },
    "node-guidance",
  );
  if (item !== null && item !== undefined) {
    appendMandatory(items, { source: "mapped-item", value: { item } }, "mapped-item");
  }
  for (const entry of orderedInputs(inputs)) {
    const value = predecessorValue(entry);
    const inline = { source: "predecessor", source_digest: digest(value), value };
    if (byteLength({ items: [...items, inline] }) <= BOUNDED_CONTEXT_BYTES) {
      items.push(inline);
      continue;
    }
    appendMandatory(
      items,
      {
        source: "predecessor",
        source_digest: digest(value),
        reference: verifiedAttemptReference(runDir, entry, value),
      },
      "predecessor-reference",
    );
  }
  const promptContext = { items };
  const inlineBytes = items
    .filter((entry) => entry.value !== undefined)
    .reduce((total, entry) => total + byteLength(entry.value), 0);
  const referencedBytes = items
    .filter((entry) => entry.reference)
    .reduce((total, entry) => total + entry.reference.bytes, 0);
  const finished = now();
  const policy = contextPolicySnapshot("bounded");
  const manifest = Object.freeze({
    schema_version: CONTEXT_POLICY_VERSION,
    policy_digest: contextPolicyDigest(policy),
    cap_bytes: BOUNDED_CONTEXT_BYTES,
    assembled_bytes: byteLength(promptContext),
    inline_bytes: inlineBytes,
    referenced_bytes: referencedBytes,
    item_count: items.length,
    reference_count: items.filter((entry) => entry.reference).length,
  });
  return Object.freeze({
    prompt_context: Object.freeze(promptContext),
    manifest,
    digest: digest({ policy, prompt_context: promptContext }),
    evidence: Object.freeze({
      ...manifest,
      assembly_duration_ms: Math.max(0, finished - started),
    }),
  });
}
