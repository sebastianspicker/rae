#!/usr/bin/env node
/** Exposes local graph projection, query, explanation, and memory lifecycle commands. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";
import {
  decideMemory,
  explainGraphNode,
  graphStatus,
  listMemory,
  memoryStatus,
  projectGraph,
  queryGraph,
  rebuildMemory,
  recordRunMemory,
} from "./lib/graph.mjs";

assertSupportedNodeRuntime();

function usage() {
  process.stdout.write(`RAE local graph engineering and memory

Usage:
  ./scripts/rae.sh graph build --project-root <path> [--run-id <id>] [--json]
  ./scripts/rae.sh graph status --project-root <path> [--run-id <id>] [--json]
  ./scripts/rae.sh graph query --project-root <path> --seed <kind:id> [--run-id <id>] [--phase <phase>] [--depth <0..4>] [--limit <1..200>] [--include-model-proposed] [--json]
  ./scripts/rae.sh graph explain --project-root <path> --run-id <id> --node <id> [--json]
  ./scripts/rae.sh graph memory list --project-root <path> [--status all|facts|candidates] [--json]
  ./scripts/rae.sh graph memory promote|reject --project-root <path> --candidate-id <id> --actor <actor> --rationale <text> --source-ref <path> [--json]
  ./scripts/rae.sh graph memory rebuild --project-root <path> [--run-id <id>] [--json]

Graph execution is opt-in. Projections augment raw evidence and never authorize mutation,
change gates, alter Git state, or broaden plan ownership.
`);
}

function parse(argv) {
  const output = { _: [] };
  const booleans = new Set(["json", "help", "include-model-proposed"]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      output._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (booleans.has(key)) {
      output[key] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    output[key] = value;
  }
  return output;
}

function emit(value, options) {
  if (options.json) return process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) || (item && typeof item === "object"))
      process.stdout.write(`${key}: ${JSON.stringify(item)}\n`);
    else process.stdout.write(`${key}: ${item}\n`);
  }
}

function projectRoot(options) {
  return resolve(options["project-root"] ?? process.cwd());
}

function memoryCommand(action, options) {
  switch (action) {
    case "list":
      return listMemory({ projectRoot: projectRoot(options), status: options.status ?? "all" });
    case "status":
      return memoryStatus(projectRoot(options));
    case "rebuild":
      return rebuildGraphMemory(options);
    case "promote":
      return decideGraphMemory("promoted", options);
    case "reject":
      return decideGraphMemory("rejected", options);
    default:
      throw new Error(`unknown graph memory command: ${action}`);
  }
}

function rebuildGraphMemory(options) {
  const project = projectRoot(options);
  const runId = options["run-id"];
  const result = rebuildMemory({ projectRoot: project, runId });
  if (!runId) return result;
  return { ...result, imported: recordRunMemory({ projectRoot: project, runId }) };
}

function decideGraphMemory(decision, options) {
  return decideMemory({
    projectRoot: projectRoot(options),
    candidateId: options["candidate-id"],
    decision,
    actor: options.actor,
    rationale: options.rationale,
    sourceRef: options["source-ref"],
  });
}

function graphCommand(command, options, action) {
  switch (command) {
    case "build":
      return projectGraph({ projectRoot: projectRoot(options), runId: options["run-id"] });
    case "status":
      return graphStatus({ projectRoot: projectRoot(options), runId: options["run-id"] });
    case "query":
      return graphQuery(options);
    case "explain":
      return explainGraph(options);
    case "memory":
      return memoryCommand(action ?? "list", options);
    default:
      throw new Error(`unknown graph command: ${command}`);
  }
}

function graphQuery(options) {
  return queryGraph({
    projectRoot: projectRoot(options),
    runId: options["run-id"],
    seed: options.seed,
    phase: options.phase ?? "query",
    maxDepth: Number(options.depth ?? 4),
    maxRecords: Number(options.limit ?? 200),
    includeModelProposed: options["include-model-proposed"] === true,
  });
}

function explainGraph(options) {
  if (!options.node) throw new Error("graph explain requires --node <id>");
  return explainGraphNode({
    projectRoot: projectRoot(options),
    runId: options["run-id"],
    nodeId: options.node,
  });
}

function main() {
  const options = parse(process.argv.slice(2));
  const [command = "help", action] = options._;
  if (["help", "--help", "-h"].includes(command) || options.help) return usage();
  emit(graphCommand(command, options, action), options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
