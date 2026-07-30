/** Validates and canonically snapshots graph-native workflow contracts. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const WORKFLOW_SCHEMAS = new Map([
  ["2.0.0", resolve(PACKAGE_ROOT, "contracts/workflows/workflow-v2.schema.json")],
  ["2.1.0", resolve(PACKAGE_ROOT, "contracts/workflows/workflow-v2.1.schema.json")],
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function workflowDigest(workflow) {
  return createHash("sha256").update(canonicalJson(workflow)).digest("hex");
}

function schemaValidator(schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

const shapeValidators = new Map(
  [...WORKFLOW_SCHEMAS].map(([version, schemaPath]) => [version, schemaValidator(schemaPath)]),
);

function contractError(message) {
  return new Error(`invalid workflow: ${message}`);
}

function recordSchemaReference(path, key, entry, refs) {
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

function walkSchema(value, path, refs) {
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

function resolvePointer(root, pointer) {
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value?.[key], root);
}

function assertContractSize(name, schema) {
  if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_PAYLOAD_CONTRACT_BYTES) {
    throw contractError(`payload contract ${name} exceeds ${MAX_PAYLOAD_CONTRACT_BYTES} bytes`);
  }
}

function assertResolvedReferences(name, schema, refs) {
  for (const [, pointer] of refs) {
    if (resolvePointer(schema, pointer) === undefined) {
      throw contractError(`payload contract ${name} has unresolved reference ${pointer}`);
    }
  }
}

function definitionName(path) {
  const parts = path.split("/");
  const definitionIndex = parts.indexOf("$defs");
  return definitionIndex === -1 ? undefined : parts[definitionIndex + 1];
}

function definitionEdges(refs) {
  const edges = new Map();
  for (const [path, pointer] of refs) {
    const source = definitionName(path);
    const target = definitionName(pointer);
    if (!source || !target) continue;
    if (!edges.has(source)) edges.set(source, new Set());
    edges.get(source).add(target);
  }
  return edges;
}

function assertAcyclicDefinitions(name, refs) {
  const edges = definitionEdges(refs);
  const active = new Set();
  const done = new Set();
  function visit(definition) {
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

function assertReferenceExpansionIsBounded(name, schema, refs) {
  const counts = new Map();
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

function compilePayloadContract(name, schema) {
  try {
    new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  } catch (error) {
    throw contractError(`payload contract ${name} is not a valid JSON Schema: ${error.message}`);
  }
}

function validatePayloadContract(name, schema) {
  assertContractSize(name, schema);
  const refs = [];
  walkSchema(schema, name, refs);
  assertResolvedReferences(name, schema, refs);
  assertAcyclicDefinitions(name, refs);
  compilePayloadContract(name, schema);
  // References are intentionally non-recursive. This conservative rule also
  // prevents mutually recursive definitions from consuming unbounded validators.
  assertReferenceExpansionIsBounded(name, schema, refs);
}

function validatePayloadContracts(contracts = {}) {
  for (const [name, schema] of Object.entries(contracts)) validatePayloadContract(name, schema);
}

function adjacency(workflow, { includeLoopBack = false } = {}) {
  const outgoing = new Map(workflow.nodes.map(({ id }) => [id, []]));
  const incoming = new Map(workflow.nodes.map(({ id }) => [id, []]));
  for (const edge of workflow.edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) {
      throw contractError(`edge ${edge.from} -> ${edge.to} references an unknown node`);
    }
    if (!includeLoopBack && edge.type === "loop-back") continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  return { outgoing, incoming };
}

function reachableFrom(start, outgoing) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return seen;
}

function assertAcyclic(workflow, outgoing) {
  const active = new Set();
  const done = new Set();
  function visit(id) {
    if (active.has(id)) throw contractError(`unbounded cycle includes ${id}`);
    if (done.has(id)) return;
    active.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    active.delete(id);
    done.add(id);
  }
  for (const node of workflow.nodes) visit(node.id);
}

function intersectParentDominators(parents, result, all) {
  let intersection = new Set(all);
  for (const parent of parents) {
    intersection = new Set([...intersection].filter((entry) => result.get(parent).has(entry)));
  }
  return intersection;
}

function setsDiffer(left, right) {
  return left.size !== right.size || [...left].some((entry) => !right.has(entry));
}

function dominators(workflow, incoming) {
  const ids = workflow.nodes.map(({ id }) => id);
  const all = new Set(ids);
  const result = new Map(
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

function loopMembership(workflow, nodes) {
  const loopMembership = new Map();
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

function validateLoops(workflow, nodes) {
  const membership = loopMembership(workflow, nodes);
  for (const edge of workflow.edges.filter(({ type }) => type === "loop-back")) {
    if (!membership.has(edge.from) || membership.get(edge.from) !== membership.get(edge.to)) {
      throw contractError(
        `loop-back ${edge.from} -> ${edge.to} must remain inside one bounded loop`,
      );
    }
  }
}

function topologyContext(workflow) {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  if (nodes.size !== workflow.nodes.length) throw contractError("node ids must be unique");
  if (!nodes.has(workflow.entry_node) || !nodes.has(workflow.terminal_node)) {
    throw contractError("entry and terminal nodes must exist");
  }
  if (nodes.get(workflow.terminal_node).kind !== "terminal") {
    throw contractError("terminal_node must identify a terminal node");
  }
  if (workflow.nodes.filter(({ kind }) => kind === "terminal").length !== 1) {
    throw contractError("workflow must contain exactly one terminal node");
  }
  validateLoops(workflow, nodes);
  const graph = adjacency(workflow);
  return { nodes, graph };
}

function assertEntryAndTerminalTopology(workflow, graph) {
  if ((graph.incoming.get(workflow.entry_node) ?? []).length !== 0)
    throw contractError("entry node has predecessors");
  if ((graph.outgoing.get(workflow.terminal_node) ?? []).length !== 0)
    throw contractError("terminal node has successors");
  assertAcyclic(workflow, graph.outgoing);
  const reachable = reachableFrom(workflow.entry_node, graph.outgoing);
  const orphan = workflow.nodes.find(({ id }) => !reachable.has(id));
  if (orphan) throw contractError(`unreachable node ${orphan.id}`);
}

function assertJoinTopology(workflow, graph) {
  for (const node of workflow.nodes.filter(({ kind }) => kind === "join")) {
    if ((graph.incoming.get(node.id) ?? []).length < 2 || !node.join) {
      throw contractError(
        `join ${node.id} must declare a satisfiable policy and at least two inputs`,
      );
    }
  }
}

function markedNodeIds(workflow, property) {
  return new Set(workflow.nodes.filter((node) => node[property] === true).map(({ id }) => id));
}

function assertWriterDominance(workflow, dom) {
  const ownershipIds = markedNodeIds(workflow, "ownership_plan");
  const checkpointIds = markedNodeIds(workflow, "mutation_checkpoint");
  for (const writer of workflow.nodes.filter(({ access }) => access === "write")) {
    if (![...ownershipIds].some((id) => dom.get(writer.id).has(id))) {
      throw contractError(`writer ${writer.id} is not dominated by an ownership plan`);
    }
    if (![...checkpointIds].some((id) => dom.get(writer.id).has(id))) {
      throw contractError(`writer ${writer.id} is not dominated by a mutation checkpoint`);
    }
  }
}

function assertVerificationDominance(workflow, dom) {
  const verificationIds = markedNodeIds(workflow, "verification");
  if (![...verificationIds].some((id) => dom.get(workflow.terminal_node).has(id))) {
    throw contractError("terminal paths are not dominated by verification");
  }
}

function assertWritersAreSerialized(workflow) {
  const full = adjacency(workflow, { includeLoopBack: true }).outgoing;
  const writers = workflow.nodes.filter(({ access }) => access === "write");
  for (let left = 0; left < writers.length; left++) {
    const leftReach = reachableFrom(writers[left].id, full);
    for (let right = left + 1; right < writers.length; right++) {
      const rightReach = reachableFrom(writers[right].id, full);
      if (!leftReach.has(writers[right].id) && !rightReach.has(writers[left].id)) {
        throw contractError(
          `writers ${writers[left].id} and ${writers[right].id} may run in parallel`,
        );
      }
    }
  }
}

function validateTopology(workflow) {
  const { nodes, graph } = topologyContext(workflow);
  assertEntryAndTerminalTopology(workflow, graph);
  assertJoinTopology(workflow, graph);
  if (workflow.schema_version === "2.1.0") validateV21Topology(workflow, nodes, graph);
  const dom = dominators(workflow, graph.incoming);
  assertWriterDominance(workflow, dom);
  assertVerificationDominance(workflow, dom);
  assertWritersAreSerialized(workflow);
}

function assertKindConfiguration(node, kind, field, requiredMessage) {
  if (node.kind === kind && !node[field]) throw contractError(requiredMessage);
  if (node.kind !== kind && node[field]) {
    throw contractError(`node ${node.id} may not declare ${field} configuration`);
  }
}

function assertV21NodeShape(node) {
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

function assertTransformConfiguration(node) {
  if (node.kind === "transform") {
    if (["limit", "cartesian"].includes(node.transform.operation) && !node.transform.limit)
      throw contractError(`transform ${node.id} requires an explicit limit`);
    if (node.transform.operation === "cartesian" && !node.transform.pointers)
      throw contractError(`Cartesian transform ${node.id} requires bounded source pointers`);
  }
}

function assertQuorumGroups(node, incomingIds) {
  const groupedMembers = new Set();
  for (const group of node.quorum.groups ?? []) {
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

function assertQuorumConfiguration(node, graph) {
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

function assertFailureCollection(workflow, nodes, node) {
  if (node.failure_handling?.mode === "collect") {
    if (node.access === "write") throw contractError(`writer ${node.id} may not collect failures`);
    const successors = workflow.edges
      .filter((edge) => edge.from === node.id && edge.type !== "loop-back")
      .map((edge) => nodes.get(edge.to));
    if (!successors.some((successor) => ["any", "quorum"].includes(successor?.join))) {
      throw contractError(`collect node ${node.id} must feed an explicit threshold join`);
    }
  }
}

function assertV21Nodes(workflow, nodes, graph) {
  for (const node of workflow.nodes) {
    assertV21NodeShape(node);
    assertTransformConfiguration(node);
    assertQuorumConfiguration(node, graph);
    assertFailureCollection(workflow, nodes, node);
  }
}

function assertUntilDryLoops(workflow) {
  for (const node of workflow.nodes.filter(({ kind }) => kind === "loop")) {
    if (
      node.loop?.mode === "until-dry" &&
      (!node.loop.source_pointer || !node.loop.stable_key_pointer)
    )
      throw contractError(`until-dry loop ${node.id} requires source and stable-key pointers`);
  }
}

function streamEdges(workflow) {
  return workflow.edges.filter(({ type }) => type === "stream");
}

function recordStreamIncoming(streamIncoming, edge, nodes) {
  const target = nodes.get(edge.to);
  if (target?.kind !== "map") {
    throw contractError(`stream edge ${edge.from} -> ${edge.to} must target a map node`);
  }
  streamIncoming.set(edge.to, (streamIncoming.get(edge.to) ?? 0) + 1);
}

function streamGraph(workflow, nodes) {
  const edges = streamEdges(workflow);
  const streamIncoming = new Map();
  for (const edge of edges) recordStreamIncoming(streamIncoming, edge, nodes);
  for (const [nodeId, count] of streamIncoming) {
    if (count > 1)
      throw contractError(`mapped stage ${nodeId} has more than one stream predecessor`);
  }
  const streamOutgoing = new Map();
  for (const edge of edges) {
    if (!streamOutgoing.has(edge.from)) streamOutgoing.set(edge.from, []);
    streamOutgoing.get(edge.from).push(edge.to);
  }
  return streamOutgoing;
}

function assertBoundedStreamDepth(streamOutgoing) {
  const visit = (nodeId, depth, active) => {
    if (depth > 4) throw contractError(`stream pipeline through ${nodeId} exceeds depth 4`);
    if (active.has(nodeId)) throw contractError(`stream pipeline contains a cycle at ${nodeId}`);
    const nextActive = new Set(active).add(nodeId);
    for (const next of streamOutgoing.get(nodeId) ?? []) visit(next, depth + 1, nextActive);
  };
  for (const nodeId of streamOutgoing.keys()) visit(nodeId, 1, new Set());
}

function validateV21Topology(workflow, nodes, graph) {
  assertV21Nodes(workflow, nodes, graph);
  assertUntilDryLoops(workflow);
  assertBoundedStreamDepth(streamGraph(workflow, nodes));
}

export function validateWorkflow(value) {
  const workflow = structuredClone(value);
  const validateShape = shapeValidators.get(workflow?.schema_version);
  if (!validateShape) throw contractError(`unsupported schema version ${workflow?.schema_version}`);
  if (!validateShape(workflow)) {
    const detail = validateShape.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw contractError(detail);
  }
  validatePayloadContracts(workflow.payload_contracts);
  const contractNames = new Set(Object.keys(workflow.payload_contracts ?? {}));
  for (const node of workflow.nodes) {
    if (node.payload_contract && !contractNames.has(node.payload_contract)) {
      throw contractError(
        `node ${node.id} references unknown payload contract ${node.payload_contract}`,
      );
    }
  }
  validateTopology(workflow);
  return workflow;
}

export function workflowSnapshot(value) {
  const workflow = validateWorkflow(value);
  return Object.freeze({ workflow, digest: workflowDigest(workflow) });
}

export function loadWorkflow(pathValue) {
  const supplied = resolve(pathValue);
  const stat = lstatSync(supplied);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw contractError("workflow path must be a regular non-symlink file");
  if (stat.size > 512 * 1024) throw contractError("workflow file exceeds 524288 bytes");
  if (realpathSync(supplied) !== supplied)
    throw contractError("workflow path must not traverse symlinks");
  return workflowSnapshot(JSON.parse(readFileSync(supplied, "utf8")));
}
