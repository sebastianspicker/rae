/** Validates and canonically snapshots graph-native workflow contracts. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import type {
  WorkflowsWorkflowV2,
  WorkflowsWorkflowV21,
  WorkflowsWorkflowV21DefsFailure,
  WorkflowsWorkflowV21DefsMap,
  WorkflowsWorkflowV21DefsQuorum,
  WorkflowsWorkflowV21DefsTransform,
  WorkflowsWorkflowV22,
  WorkflowsWorkflowV22DefsWait,
} from "@rae/contracts";
import { contractsRoot } from "../primitives/installation-paths.js";

export type WorkflowContract = WorkflowsWorkflowV2 | WorkflowsWorkflowV21 | WorkflowsWorkflowV22;

type WorkflowKind =
  | "agent"
  | "map"
  | "transform"
  | "join"
  | "gate"
  | "checkpoint"
  | "loop"
  | "wait"
  | "terminal";
interface WorkflowNodeShape {
  id: string;
  kind: WorkflowKind;
  access: "read" | "write" | "control";
  guidance: string;
  role?: string;
  payload_contract?: string;
  tier?: "economy" | "standard" | "judgment";
  join?: "all" | "any" | "quorum";
  quorum?: WorkflowsWorkflowV21DefsQuorum;
  map?: WorkflowsWorkflowV21DefsMap;
  transform?: WorkflowsWorkflowV21DefsTransform;
  failure_handling?: WorkflowsWorkflowV21DefsFailure;
  resource?: string;
  ownership_plan?: boolean;
  mutation_checkpoint?: boolean;
  verification?: boolean;
  loop?: {
    mode?: "bounded" | "until-dry";
    max_iterations: number;
    members: string[];
    source_pointer?: string;
    stable_key_pointer?: string;
  };
  wait?: WorkflowsWorkflowV22DefsWait;
}

interface WorkflowEdgeShape {
  from: string;
  to: string;
  type: "sequence" | "artifact" | "stream" | "condition" | "loop-back";
  artifact?: string;
  condition?: "success" | "failure" | "blocking-findings" | "budget-available";
}

interface WorkflowShape {
  schema_version: "2.0.0" | "2.1.0" | "2.2.0";
  workflow_id: string;
  revision: number;
  entry_node: string;
  terminal_node: string;
  nodes: WorkflowNodeShape[];
  edges: WorkflowEdgeShape[];
  payload_contracts?: Record<string, unknown>;
  signal_contracts?: Record<string, unknown>;
  budgets?: {
    max_concurrency?: number;
    max_repair_rounds?: number;
    max_attempts_per_node?: number;
  };
}

type SchemaReferences = Array<[path: string, pointer: string]>;
interface WorkflowGraph {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

const WORKFLOW_SCHEMAS = new Map([
  ["2.0.0", resolve(contractsRoot, "workflows/workflow-v2.schema.json")],
  ["2.1.0", resolve(contractsRoot, "workflows/workflow-v2.1.schema.json")],
  ["2.2.0", resolve(contractsRoot, "workflows/workflow-v2.2.schema.json")],
]);
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "command",
  "commands",
  "environment",
  "env",
  "expression",
  "executable",
  "model",
  "provider",
  "reasoning_effort",
  "tool",
  "tools",
]);
const MAX_PAYLOAD_CONTRACT_BYTES = 64 * 1024;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function workflowDigest(workflow: unknown): string {
  return createHash("sha256").update(canonicalJson(workflow)).digest("hex");
}

function schemaValidator(schemaPath: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

const shapeValidators = new Map(
  [...WORKFLOW_SCHEMAS].map(([version, schemaPath]) => [version, schemaValidator(schemaPath)]),
);

function contractError(message: string): Error {
  return new Error(`invalid workflow: ${message}`);
}

function recordSchemaReference(
  path: string,
  key: string,
  entry: unknown,
  refs: SchemaReferences,
): void {
  if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
    throw contractError(`payload contract ${path} contains forbidden key ${key}`);
  }
  if (["$dynamicRef", "$recursiveRef"].includes(key)) {
    throw contractError(`payload contract ${path} contains recursive reference ${key}`);
  }
  if (key !== "$ref") return;
  if (typeof entry !== "string" || !entry.startsWith("#/")) {
    throw contractError(`payload contract ${path} may use local references only`);
  }
  refs.push([path, entry]);
}

function walkSchema(value: unknown, path: string, refs: SchemaReferences): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkSchema(entry, `${path}/${index}`, refs);
    });
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    recordSchemaReference(path, key, entry, refs);
    walkSchema(entry, `${path}/${key}`, refs);
  }
}

function resolvePointer(root: unknown, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, key) => {
      if (value === null || typeof value !== "object") return undefined;
      return (value as Record<string, unknown>)[key];
    }, root);
}

function assertContractSize(name: string, schema: unknown): void {
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_PAYLOAD_CONTRACT_BYTES) {
    throw contractError(`payload contract ${name} exceeds ${MAX_PAYLOAD_CONTRACT_BYTES} bytes`);
  }
}

function assertResolvedReferences(name: string, schema: unknown, refs: SchemaReferences): void {
  for (const [, pointer] of refs) {
    if (resolvePointer(schema, pointer) === undefined) {
      throw contractError(`payload contract ${name} has unresolved reference ${pointer}`);
    }
  }
}

function definitionName(path: string): string | undefined {
  const parts = path.split("/");
  const definitionIndex = parts.indexOf("$defs");
  return definitionIndex === -1 ? undefined : parts[definitionIndex + 1];
}

function definitionEdges(refs: SchemaReferences): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const [path, pointer] of refs) {
    const source = definitionName(path);
    const target = definitionName(pointer);
    if (!source || !target) continue;
    if (!edges.has(source)) edges.set(source, new Set());
    edges.get(source)?.add(target);
  }
  return edges;
}

function assertAcyclicDefinitions(name: string, refs: SchemaReferences): void {
  const edges = definitionEdges(refs);
  const active = new Set<string>();
  const done = new Set<string>();
  function visit(definition: string): void {
    if (active.has(definition))
      throw contractError(`payload contract ${name} contains a recursive schema`);
    if (done.has(definition)) return;
    active.add(definition);
    for (const target of edges.get(definition) ?? []) visit(target);
    active.delete(definition);
    done.add(definition);
  }
  for (const definition of edges.keys()) visit(definition);
}

function assertReferenceExpansionIsBounded(
  name: string,
  schema: unknown,
  refs: SchemaReferences,
): void {
  const counts = new Map<string, number>();
  for (const [, pointer] of refs) {
    const target = resolvePointer(schema, pointer);
    if (target && JSON.stringify(target).includes(`"$ref":"${pointer}"`)) {
      throw contractError(`payload contract ${name} contains a recursive schema`);
    }
    const count = (counts.get(pointer) ?? 0) + 1;
    if (count > 32) {
      throw contractError(`payload contract ${name} contains excessive reference expansion`);
    }
    counts.set(pointer, count);
  }
}

function compilePayloadContract(name: string, schema: unknown): void {
  try {
    new Ajv2020({ allErrors: true, strict: false }).compile(schema as AnySchema);
  } catch (error) {
    throw contractError(
      `payload contract ${name} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validatePayloadContract(name: string, schema: unknown): void {
  assertContractSize(name, schema);
  const refs: SchemaReferences = [];
  walkSchema(schema, name, refs);
  assertResolvedReferences(name, schema, refs);
  assertAcyclicDefinitions(name, refs);
  compilePayloadContract(name, schema);
  // References are intentionally non-recursive. This conservative rule also
  // prevents mutually recursive definitions from consuming unbounded validators.
  assertReferenceExpansionIsBounded(name, schema, refs);
}

function validatePayloadContracts(contracts: Record<string, unknown> = {}): void {
  for (const [name, schema] of Object.entries(contracts)) validatePayloadContract(name, schema);
}

function adjacency(
  workflow: WorkflowShape,
  { includeLoopBack = false }: { includeLoopBack?: boolean } = {},
): WorkflowGraph {
  const outgoing = new Map<string, string[]>(workflow.nodes.map(({ id }) => [id, []]));
  const incoming = new Map<string, string[]>(workflow.nodes.map(({ id }) => [id, []]));
  for (const edge of workflow.edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) {
      throw contractError(`edge ${edge.from} -> ${edge.to} references an unknown node`);
    }
    if (!includeLoopBack && edge.type === "loop-back") continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }
  return { outgoing, incoming };
}

function reachableFrom(start: string, outgoing: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return seen;
}

function assertAcyclic(workflow: WorkflowShape, outgoing: Map<string, string[]>): void {
  const active = new Set<string>();
  const done = new Set<string>();
  for (const start of workflow.nodes.map(({ id }) => id)) {
    if (done.has(start)) continue;
    active.add(start);
    const stack = [{ id: start, index: 0 }];
    while (stack.length) {
      const frame = stack.at(-1);
      if (!frame) break;
      const neighbors = outgoing.get(frame.id) ?? [];
      if (frame.index >= neighbors.length) {
        active.delete(frame.id);
        done.add(frame.id);
        stack.pop();
        continue;
      }
      const next = neighbors[frame.index++];
      if (next === undefined) continue;
      if (active.has(next)) throw contractError(`unbounded cycle includes ${next}`);
      if (done.has(next)) continue;
      active.add(next);
      stack.push({ id: next, index: 0 });
    }
  }
}

function intersectParentDominators(
  parents: string[],
  result: Map<string, Set<string>>,
  all: Set<string>,
): Set<string> {
  let intersection = new Set(all);
  for (const parent of parents) {
    const parentSet = result.get(parent);
    intersection = new Set([...intersection].filter((entry) => parentSet?.has(entry) === true));
  }
  return intersection;
}

function setsDiffer(left: Set<string>, right: Set<string> | undefined): boolean {
  return !right || left.size !== right.size || [...left].some((entry) => !right.has(entry));
}

function dominators(
  workflow: WorkflowShape,
  incoming: Map<string, string[]>,
): Map<string, Set<string>> {
  const ids = workflow.nodes.map(({ id }) => id);
  const all = new Set(ids);
  const result = new Map<string, Set<string>>(
    ids.map((id) => [id, id === workflow.entry_node ? new Set([id]) : new Set(all)]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (id === workflow.entry_node) continue;
      const parents = incoming.get(id) ?? [];
      const intersection = intersectParentDominators(parents, result, all);
      const next = new Set([id, ...intersection]);
      const prior = result.get(id);
      if (setsDiffer(next, prior)) {
        result.set(id, next);
        changed = true;
      }
    }
  }
  return result;
}

function loopMembership(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
): Map<string, string> {
  const loopMembership = new Map<string, string>();
  for (const node of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    for (const member of node.loop?.members ?? []) {
      if (!nodes.has(member)) throw contractError(`loop ${node.id} has unknown member ${member}`);
      if (loopMembership.has(member))
        throw contractError(`node ${member} belongs to multiple loops`);
      loopMembership.set(member, node.id);
    }
  }
  return loopMembership;
}

function validateLoops(workflow: WorkflowShape, nodes: Map<string, WorkflowNodeShape>): void {
  const membership = loopMembership(workflow, nodes);
  for (const edge of workflow.edges.filter(({ type }) => type === "loop-back")) {
    if (!membership.has(edge.from) || membership.get(edge.from) !== membership.get(edge.to)) {
      throw contractError(
        `loop-back ${edge.from} -> ${edge.to} must remain inside one bounded loop`,
      );
    }
  }
}

function topologyContext(workflow: WorkflowShape): {
  nodes: Map<string, WorkflowNodeShape>;
  graph: WorkflowGraph;
} {
  const nodes = new Map<string, WorkflowNodeShape>(workflow.nodes.map((node) => [node.id, node]));
  if (nodes.size !== workflow.nodes.length) throw contractError("node ids must be unique");
  if (!nodes.has(workflow.entry_node) || !nodes.has(workflow.terminal_node)) {
    throw contractError("entry and terminal nodes must exist");
  }
  if (nodes.get(workflow.terminal_node)?.kind !== "terminal") {
    throw contractError("terminal_node must identify a terminal node");
  }
  if (workflow.nodes.filter(({ kind }) => kind === "terminal").length !== 1) {
    throw contractError("workflow must contain exactly one terminal node");
  }
  validateLoops(workflow, nodes);
  const graph = adjacency(workflow);
  return { nodes, graph };
}

function assertEntryAndTerminalTopology(workflow: WorkflowShape, graph: WorkflowGraph): void {
  if ((graph.incoming.get(workflow.entry_node) ?? []).length !== 0)
    throw contractError("entry node has predecessors");
  if ((graph.outgoing.get(workflow.terminal_node) ?? []).length !== 0)
    throw contractError("terminal node has successors");
  assertAcyclic(workflow, graph.outgoing);
  const reachable = reachableFrom(workflow.entry_node, graph.outgoing);
  const orphan = workflow.nodes.find(({ id }) => !reachable.has(id));
  if (orphan) throw contractError(`unreachable node ${orphan.id}`);
}

function assertJoinTopology(workflow: WorkflowShape, graph: WorkflowGraph): void {
  for (const node of workflow.nodes.filter(({ kind }) => kind === "join")) {
    if ((graph.incoming.get(node.id) ?? []).length < 2 || !node.join) {
      throw contractError(
        `join ${node.id} must declare a satisfiable policy and at least two inputs`,
      );
    }
  }
}

type BooleanNodeMarker = "ownership_plan" | "mutation_checkpoint" | "verification";
function markedNodeIds(workflow: WorkflowShape, property: BooleanNodeMarker): Set<string> {
  return new Set(workflow.nodes.filter((node) => node[property] === true).map(({ id }) => id));
}

function assertWriterDominance(workflow: WorkflowShape, dom: Map<string, Set<string>>): void {
  const ownershipIds = markedNodeIds(workflow, "ownership_plan");
  const checkpointIds = markedNodeIds(workflow, "mutation_checkpoint");
  for (const writer of workflow.nodes.filter(({ access }) => access === "write")) {
    if (![...ownershipIds].some((id) => dom.get(writer.id)?.has(id) === true)) {
      throw contractError(`writer ${writer.id} is not dominated by an ownership plan`);
    }
    if (![...checkpointIds].some((id) => dom.get(writer.id)?.has(id) === true)) {
      throw contractError(`writer ${writer.id} is not dominated by a mutation checkpoint`);
    }
  }
}

function assertVerificationDominance(workflow: WorkflowShape, dom: Map<string, Set<string>>): void {
  const verificationIds = markedNodeIds(workflow, "verification");
  if (![...verificationIds].some((id) => dom.get(workflow.terminal_node)?.has(id) === true)) {
    throw contractError("terminal paths are not dominated by verification");
  }
}

function assertWritersAreSerialized(workflow: WorkflowShape): void {
  const full = adjacency(workflow, { includeLoopBack: true }).outgoing;
  const writers = workflow.nodes.filter(({ access }) => access === "write");
  for (let left = 0; left < writers.length; left++) {
    const leftWriter = writers[left];
    if (!leftWriter) continue;
    const leftReach = reachableFrom(leftWriter.id, full);
    for (let right = left + 1; right < writers.length; right++) {
      const rightWriter = writers[right];
      if (!rightWriter) continue;
      const rightReach = reachableFrom(rightWriter.id, full);
      if (!leftReach.has(rightWriter.id) && !rightReach.has(leftWriter.id)) {
        throw contractError(`writers ${leftWriter.id} and ${rightWriter.id} may run in parallel`);
      }
    }
  }
}

function validateTopology(workflow: WorkflowShape): void {
  const { nodes, graph } = topologyContext(workflow);
  assertEntryAndTerminalTopology(workflow, graph);
  assertJoinTopology(workflow, graph);
  if (workflow.schema_version === "2.1.0") validateV21Topology(workflow, nodes, graph);
  if (workflow.schema_version === "2.2.0") validateV22Topology(workflow, nodes, graph);
  const dom = dominators(workflow, graph.incoming);
  assertWriterDominance(workflow, dom);
  assertVerificationDominance(workflow, dom);
  assertWritersAreSerialized(workflow);
}

type KindConfigurationField = "map" | "transform";
function assertKindConfiguration(
  node: WorkflowNodeShape,
  kind: WorkflowKind,
  field: KindConfigurationField,
  requiredMessage: string,
): void {
  if (node.kind === kind && !node[field]) throw contractError(requiredMessage);
  if (node.kind !== kind && node[field]) {
    throw contractError(`node ${node.id} may not declare ${field} configuration`);
  }
}

function assertV21NodeShape(node: WorkflowNodeShape): void {
  assertKindConfiguration(
    node,
    "map",
    "map",
    `map ${node.id} must declare bounded map configuration`,
  );
  assertKindConfiguration(
    node,
    "transform",
    "transform",
    `transform ${node.id} must declare an allowlisted transform`,
  );
}

function assertTransformConfiguration(node: WorkflowNodeShape): void {
  if (node.kind === "transform" && node.transform) {
    if (["limit", "cartesian"].includes(node.transform.operation) && !node.transform.limit)
      throw contractError(`transform ${node.id} requires an explicit limit`);
    if (node.transform.operation === "cartesian" && !node.transform.pointers)
      throw contractError(`Cartesian transform ${node.id} requires bounded source pointers`);
  }
}

function assertQuorumGroups(node: WorkflowNodeShape, incomingIds: Set<string>): void {
  const groupedMembers = new Set<string>();
  for (const group of node.quorum?.groups ?? []) {
    if (group.threshold > group.members.length)
      throw contractError(`quorum group ${group.id} threshold exceeds its members`);
    for (const member of group.members) {
      if (!incomingIds.has(member))
        throw contractError(`quorum group ${group.id} names non-input ${member}`);
      if (groupedMembers.has(member))
        throw contractError(`quorum input ${member} belongs to multiple groups`);
      groupedMembers.add(member);
    }
  }
}

function assertQuorumConfiguration(node: WorkflowNodeShape, graph: WorkflowGraph): void {
  if (node.join !== "quorum") {
    if (node.quorum)
      throw contractError(`non-quorum join ${node.id} may not declare quorum configuration`);
    return;
  }
  if (!node.quorum) throw contractError(`quorum join ${node.id} must declare a threshold`);
  const incomingIds = new Set(graph.incoming.get(node.id) ?? []);
  if (node.quorum.threshold > incomingIds.size)
    throw contractError(`quorum join ${node.id} threshold exceeds its inputs`);
  assertQuorumGroups(node, incomingIds);
}

function assertFailureCollection(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
  node: WorkflowNodeShape,
): void {
  if (node.failure_handling?.mode === "collect") {
    if (node.access === "write") throw contractError(`writer ${node.id} may not collect failures`);
    const successors = workflow.edges
      .filter((edge) => edge.from === node.id && edge.type !== "loop-back")
      .map((edge) => nodes.get(edge.to));
    if (
      !successors.some((successor) => successor?.join === "any" || successor?.join === "quorum")
    ) {
      throw contractError(`collect node ${node.id} must feed an explicit threshold join`);
    }
  }
}

function assertV21Nodes(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
  graph: WorkflowGraph,
): void {
  for (const node of workflow.nodes) {
    assertV21NodeShape(node);
    assertTransformConfiguration(node);
    assertQuorumConfiguration(node, graph);
    assertFailureCollection(workflow, nodes, node);
  }
}

function assertUntilDryLoops(workflow: WorkflowShape): void {
  for (const node of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    if (
      node.loop?.mode === "until-dry" &&
      (!node.loop.source_pointer || !node.loop.stable_key_pointer)
    )
      throw contractError(`until-dry loop ${node.id} requires source and stable-key pointers`);
  }
}

function streamEdges(workflow: WorkflowShape): WorkflowEdgeShape[] {
  return workflow.edges.filter(({ type }) => type === "stream");
}

function recordStreamIncoming(
  streamIncoming: Map<string, number>,
  edge: WorkflowEdgeShape,
  nodes: Map<string, WorkflowNodeShape>,
): void {
  const target = nodes.get(edge.to);
  if (target?.kind !== "map") {
    throw contractError(`stream edge ${edge.from} -> ${edge.to} must target a map node`);
  }
  streamIncoming.set(edge.to, (streamIncoming.get(edge.to) ?? 0) + 1);
}

function streamGraph(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
): Map<string, string[]> {
  const edges = streamEdges(workflow);
  const streamIncoming = new Map<string, number>();
  for (const edge of edges) recordStreamIncoming(streamIncoming, edge, nodes);
  for (const [nodeId, count] of streamIncoming) {
    if (count > 1)
      throw contractError(`mapped stage ${nodeId} has more than one stream predecessor`);
  }
  const streamOutgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!streamOutgoing.has(edge.from)) streamOutgoing.set(edge.from, []);
    streamOutgoing.get(edge.from)?.push(edge.to);
  }
  return streamOutgoing;
}

function assertBoundedStreamDepth(streamOutgoing: Map<string, string[]>): void {
  const visit = (nodeId: string, depth: number, active: Set<string>): void => {
    if (depth > 4) throw contractError(`stream pipeline through ${nodeId} exceeds depth 4`);
    if (active.has(nodeId)) throw contractError(`stream pipeline contains a cycle at ${nodeId}`);
    const nextActive = new Set(active).add(nodeId);
    for (const next of streamOutgoing.get(nodeId) ?? []) visit(next, depth + 1, nextActive);
  };
  for (const nodeId of streamOutgoing.keys()) visit(nodeId, 1, new Set());
}

function validateV21Topology(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
  graph: WorkflowGraph,
): void {
  assertV21Nodes(workflow, nodes, graph);
  assertUntilDryLoops(workflow);
  assertBoundedStreamDepth(streamGraph(workflow, nodes));
}

function assertV22NodeShape(node: WorkflowNodeShape, signalContracts: Set<string>): void {
  if (node.kind === "wait" && !node.wait) {
    throw contractError(`wait ${node.id} must declare a timeout and accepted signals`);
  }
  if (node.kind !== "wait" && node.wait) {
    throw contractError(`non-wait node ${node.id} may not declare wait configuration`);
  }
  if (node.kind === "wait" && node.wait && !signalContracts.has(node.wait.signal_contract)) {
    throw contractError(
      `wait ${node.id} references unknown signal contract ${node.wait.signal_contract}`,
    );
  }
  if (node.kind === "join" && !node.join) {
    throw contractError(`join ${node.id} must declare all or any`);
  }
  if (node.kind !== "join" && node.join) {
    throw contractError(`non-join node ${node.id} may not declare join configuration`);
  }
}

function assertV22NodeShapes(workflow: WorkflowShape): void {
  const signalContracts = new Set(Object.keys(workflow.signal_contracts ?? {}));
  for (const node of workflow.nodes) {
    assertV22NodeShape(node, signalContracts);
  }
}

function assertV22FailureEdges(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
): void {
  for (const edge of workflow.edges.filter((edge) => edge.condition === "failure")) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
      throw contractError(`failure edge ${edge.from} -> ${edge.to} references an unknown node`);
    }
  }
}

/** Enforces the deliberately narrow v2.2 wait contract independently of v2.1. */
function validateV22Topology(
  workflow: WorkflowShape,
  nodes: Map<string, WorkflowNodeShape>,
  graph: WorkflowGraph,
): void {
  validatePayloadContracts(workflow.signal_contracts ?? {});
  assertV22NodeShapes(workflow);
  assertV22FailureEdges(workflow, nodes);
  // Reuse the normal graph analysis so a wait cannot create an unbounded cycle.
  assertBoundedStreamDepth(new Map());
  if ((graph.incoming.get(workflow.entry_node) ?? []).length !== 0) {
    throw contractError("entry node has predecessors");
  }
}

function workflowVersion(value: unknown): string | undefined {
  return value && typeof value === "object" && "schema_version" in value
    ? String(value.schema_version)
    : undefined;
}

export function validateWorkflow(value: unknown): WorkflowContract {
  const workflow: unknown = structuredClone(value);
  const version = workflowVersion(workflow);
  const validateShape = version ? shapeValidators.get(version) : undefined;
  if (!validateShape) throw contractError(`unsupported schema version ${version}`);
  if (!validateShape(workflow)) {
    const detail = (validateShape.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw contractError(detail);
  }
  const typedWorkflow = workflow as WorkflowShape;
  validatePayloadContracts(typedWorkflow.payload_contracts);
  const contractNames = new Set(Object.keys(typedWorkflow.payload_contracts ?? {}));
  for (const node of typedWorkflow.nodes) {
    if (node.payload_contract && !contractNames.has(node.payload_contract)) {
      throw contractError(
        `node ${node.id} references unknown payload contract ${node.payload_contract}`,
      );
    }
  }
  validateTopology(typedWorkflow);
  return typedWorkflow as WorkflowContract;
}

export function workflowSnapshot(value: unknown): Readonly<{
  workflow: WorkflowContract;
  digest: string;
}> {
  const workflow = validateWorkflow(value);
  return Object.freeze({ workflow, digest: workflowDigest(workflow) });
}

export function loadWorkflow(pathValue: string): Readonly<{
  workflow: WorkflowContract;
  digest: string;
}> {
  const supplied = resolve(pathValue);
  const stat = lstatSync(supplied);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw contractError("workflow path must be a regular non-symlink file");
  if (stat.size > 512 * 1024) throw contractError("workflow file exceeds 524288 bytes");
  if (realpathSync(supplied) !== supplied)
    throw contractError("workflow path must not traverse symlinks");
  return workflowSnapshot(JSON.parse(readFileSync(supplied, "utf8")));
}
