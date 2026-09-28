/** Assembles bounded, ordered, replayable provider context for workflow v2.2. */
import { createHash } from "node:crypto";
import type { WorkflowsNodeEnvelopeV22, WorkflowsWorkflowV22DefsNode } from "@rae/contracts";

interface ContextInput extends Record<string, unknown> {
  edge: { type: string };
  envelope: WorkflowsNodeEnvelopeV22;
}
interface ContextSource extends Record<string, unknown> {
  trust_class?: string;
  digest?: string;
  id?: string;
  summary?: string;
  envelope?: WorkflowsNodeEnvelopeV22;
}
interface ContextReference extends Record<string, unknown> {
  kind: string;
  source_digest: string;
  bytes: number;
  artifact_ref: string | null;
  summary: string | null;
}
interface SelectedContextItem {
  source: string;
  source_digest: string;
  value?: unknown;
  reference?: ContextReference;
}
interface OmittedContextItem extends Record<string, unknown> {
  source: string;
  source_digest: string;
  bytes: number;
  reason: string;
  trust_class: string;
}
type ContextTuple = [source: string, entry: ContextSource, value: unknown];

export const DEFAULT_CONTEXT_CAP_BYTES = 128 * 1024;
export const MIN_CONTEXT_CAP_BYTES = 16 * 1024;
export const MAX_CONTEXT_CAP_BYTES = 256 * 1024;

export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  return value;
}
const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(canonical(value)), "utf8");
const digest = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

function assertCap(capBytes: number): void {
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

function refFor(
  entry: ContextSource,
  source: string,
  value: unknown,
  summary: string | null = null,
): ContextReference {
  const envelope = entry.envelope ?? entry;
  const digestCandidate = envelope.output_digest ?? entry.digest;
  const sourceDigest = typeof digestCandidate === "string" ? digestCandidate : digest(value);
  const instance = String(
    envelope.instance_id ?? envelope.node_id ?? entry.id ?? source,
  ).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return {
    kind: source,
    source_digest: sourceDigest,
    bytes: bytes(value),
    artifact_ref:
      typeof envelope.node_id === "string"
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
}: {
  selected: SelectedContextItem[];
  omitted: OmittedContextItem[];
  capBytes: number;
  item: ContextSource;
  source: string;
  mandatory: boolean;
  value: unknown;
  summary?: string | null;
  canReference?: boolean;
}): void {
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

function predecessor(entry: ContextInput): Record<string, unknown> {
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

function operational(entry: ContextInput): Record<string, unknown> {
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
}: {
  task?: string;
  node?: Pick<WorkflowsWorkflowV22DefsNode, "id" | "guidance" | "context" | "tier">;
  item?: unknown;
  inputs?: ContextInput[];
  verifiedGraphRecords?: ContextSource[];
  admittedMemory?: ContextSource[];
  contextPolicy?: Record<string, unknown>;
  capBytes?: number;
} = {}): Readonly<{
  manifest: Readonly<WorkflowsNodeEnvelopeV22["context_manifest"]>;
  prompt_context: Readonly<{ items: SelectedContextItem[] }>;
  digest: string;
}> {
  assertCap(capBytes);
  const selected: SelectedContextItem[] = [];
  const omitted: OmittedContextItem[] = [];
  const mandatory: ContextTuple[] = [
    ["task", { trust_class: "operator" }, { task }],
    ["node-guidance", { trust_class: "workflow" }, { node_id: node.id, guidance: node.guidance }],
    ["mapped-item", { trust_class: "workflow" }, { item }],
    ...[...inputs]
      .sort((left, right) =>
        String(left.envelope.instance_id ?? left.envelope.node_id).localeCompare(
          String(right.envelope.instance_id ?? right.envelope.node_id),
        ),
      )
      .map<ContextTuple>((entry) => ["predecessor", entry, predecessor(entry)]),
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
  const optional: ContextTuple[] = [];
  if (
    contextPolicy.allow_operational_evidence === true &&
    node.context?.include_operational_evidence === true
  ) {
    optional.push(
      ...inputs.map<ContextTuple>((entry) => ["operational", entry, operational(entry)]),
    );
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
    optional.push(
      ...verifiedGraphRecords.map<ContextTuple>((entry) => ["verified-graph", entry, entry]),
    );
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
    optional.push(
      ...admittedMemory.map<ContextTuple>((entry) => ["admitted-memory", entry, entry]),
    );
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
  const included = selected.map((entry) => {
    const value = entry.value;
    const trustClass =
      value && typeof value === "object" && "trust_class" in value
        ? String(value.trust_class)
        : "local";
    return {
      source: entry.source,
      source_digest: entry.source_digest,
      bytes: bytes(value ?? entry.reference),
      reason: entry.reference ? "artifact-reference" : "inline",
      trust_class: trustClass,
    };
  });
  const manifest: WorkflowsNodeEnvelopeV22["context_manifest"] = {
    cap_bytes: capBytes,
    assembled_bytes: assembledBytes,
    mandatory_budget_bytes: capBytes,
    optional_budget_bytes: optionalBudget,
    included,
    omitted,
    artifact_refs: selected
      .map((entry) => entry.reference)
      .filter((reference): reference is ContextReference => Boolean(reference)),
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
