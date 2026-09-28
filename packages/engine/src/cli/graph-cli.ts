#!/usr/bin/env node
/** Exposes local graph projection, query, explanation, and memory lifecycle commands. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeRuntime } from "../primitives/node-runtime.js";
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
} from "../graph/index.js";
import { loadWorkflow } from "../workflow/workflow-contract.js";
import { loadExecutionProfile } from "../workflow/execution-profile.js";
import { createWorkflowRegistry } from "../workflow/workflow-registry.js";
import { proposeWorkflowAsync } from "../workflow/workflow-proposal.js";
import { analyzeWorkflow } from "../workflow/workflow-designer.js";

assertSupportedNodeRuntime();

interface GraphOptions {
  positionals: string[];
  actor?: string;
  candidateId?: string;
  depth?: string;
  help: boolean;
  includeModelProposed: boolean;
  json: boolean;
  limit?: string;
  node?: string;
  phase?: string;
  projectRoot?: string;
  rationale?: string;
  runId?: string;
  seed?: string;
  sourceRef?: string;
  status?: string;
  workflow?: string;
  workflowFile?: string;
  revision?: string;
  digest?: string;
  from?: string;
  to?: string;
  task?: string;
  taskFile?: string;
  baseWorkflow?: string;
  executionProfile?: string;
  preview: boolean;
}

function usage(): void {
  process.stdout.write(`RAE local graph engineering and memory

Usage:
  npm run rae -- graph build --project-root <path> [--run-id <id>] [--json]
  npm run rae -- graph status --project-root <path> [--run-id <id>] [--json]
  npm run rae -- graph query --project-root <path> --seed <kind:id> [--run-id <id>] [--phase <phase>] [--depth <0..4>] [--limit <1..200>] [--include-model-proposed] [--json]
  npm run rae -- graph explain --project-root <path> --run-id <id> --node <id> [--json]
  npm run rae -- graph memory list --project-root <path> [--status all|facts|candidates] [--json]
  npm run rae -- graph memory promote|reject --project-root <path> --candidate-id <id> --actor <actor> --rationale <text> --source-ref <path> [--json]
  npm run rae -- graph memory rebuild --project-root <path> [--run-id <id>] [--json]
  npm run rae -- graph workflow list --project-root <path> [--json]
  npm run rae -- graph workflow show --project-root <path> --workflow <id> [--json]
  npm run rae -- graph workflow validate --project-root <path> (--workflow-file <path> | --workflow <id> --revision <n>) [--json]
  npm run rae -- graph workflow analyze --workflow-file <path> [--execution-profile <path>] [--json]
  npm run rae -- graph workflow diff --project-root <path> --workflow <id> --from <n> --to <n> [--json]
  npm run rae -- graph workflow activate --project-root <path> --workflow <id> --revision <n> --digest <sha256> --actor <label> --rationale <text> [--json]
  npm run rae -- graph workflow propose --project-root <path> (--task <text> | --task-file <path>) --base-workflow <id|file> --actor <label> --rationale <text> [--execution-profile <path>] [--preview] [--json]

Graph execution is opt-in. Projections augment raw evidence and never authorize mutation,
change gates, alter Git state, or broaden plan ownership.
`);
}

function parse(argv: string[]): GraphOptions {
  const output: GraphOptions = {
    positionals: [],
    actor: undefined,
    candidateId: undefined,
    depth: undefined,
    help: false,
    includeModelProposed: false,
    json: false,
    limit: undefined,
    node: undefined,
    phase: undefined,
    projectRoot: undefined,
    rationale: undefined,
    runId: undefined,
    seed: undefined,
    sourceRef: undefined,
    status: undefined,
    workflow: undefined,
    workflowFile: undefined,
    revision: undefined,
    digest: undefined,
    from: undefined,
    to: undefined,
    task: undefined,
    taskFile: undefined,
    baseWorkflow: undefined,
    executionProfile: undefined,
    preview: false,
  };
  const remaining = [...argv];
  while (remaining.length > 0) {
    const token = remaining.shift();
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      output.positionals.push(token);
      continue;
    }
    if (!assignBooleanOption(output, token))
      assignOption(output, token, optionValue(remaining, token));
  }
  return output;
}

function assignBooleanOption(output: GraphOptions, option: string): boolean {
  switch (option) {
    case "--json":
      output.json = true;
      return true;
    case "--help":
      output.help = true;
      return true;
    case "--include-model-proposed":
      output.includeModelProposed = true;
      return true;
    case "--preview":
      output.preview = true;
      return true;
    default:
      return false;
  }
}

function optionValue(remaining: string[], option: string): string {
  const value = remaining.shift();
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${option}`);
  return value;
}

function assignOption(output: GraphOptions, option: string, value: string): void {
  if (assignPrimaryOption(output, option, value)) return;
  if (assignSecondaryOption(output, option, value)) return;
  throw new Error(`unknown graph option: ${option}`);
}

function assignPrimaryOption(output: GraphOptions, option: string, value: string): boolean {
  switch (option) {
    case "--actor":
      output.actor = value;
      return true;
    case "--candidate-id":
      output.candidateId = value;
      return true;
    case "--depth":
      output.depth = value;
      return true;
    case "--limit":
      output.limit = value;
      return true;
    case "--node":
      output.node = value;
      return true;
    case "--phase":
      output.phase = value;
      return true;
    case "--workflow":
      output.workflow = value;
      return true;
    default:
      return assignWorkflowFileOption(output, option, value);
  }
}

function assignWorkflowFileOption(output: GraphOptions, option: string, value: string): boolean {
  switch (option) {
    case "--workflow-file":
      output.workflowFile = value;
      return true;
    case "--task":
      output.task = value;
      return true;
    case "--task-file":
      output.taskFile = value;
      return true;
    case "--base-workflow":
      output.baseWorkflow = value;
      return true;
    case "--execution-profile":
      output.executionProfile = value;
      return true;
    case "--revision":
      output.revision = value;
      return true;
    default:
      return false;
  }
}

function assignSecondaryOption(output: GraphOptions, option: string, value: string): boolean {
  switch (option) {
    case "--project-root":
      output.projectRoot = value;
      return true;
    case "--rationale":
      output.rationale = value;
      return true;
    case "--run-id":
      output.runId = value;
      return true;
    case "--seed":
      output.seed = value;
      return true;
    case "--source-ref":
      output.sourceRef = value;
      return true;
    case "--status":
      output.status = value;
      return true;
    case "--digest":
      output.digest = value;
      return true;
    case "--from":
      output.from = value;
      return true;
    case "--to":
      output.to = value;
      return true;
    default:
      return false;
  }
}

function emit(value: unknown, options: GraphOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  for (const [key, item] of Object.entries(record)) {
    if (Array.isArray(item) || (item && typeof item === "object"))
      process.stdout.write(`${key}: ${JSON.stringify(item)}\n`);
    else process.stdout.write(`${key}: ${item}\n`);
  }
}

function projectRoot(options: GraphOptions): string {
  return resolve(options.projectRoot ?? process.cwd());
}

function requiredOption(options: GraphOptions, key: keyof GraphOptions): string {
  const value = options[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`graph command requires --${String(key)}`);
  }
  return value;
}

function memoryCommand(action: string, options: GraphOptions): unknown {
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

function rebuildGraphMemory(options: GraphOptions): unknown {
  const project = projectRoot(options);
  const runId = options.runId;
  const result = rebuildMemory({ projectRoot: project, runId });
  if (!runId) return result;
  return { ...result, imported: recordRunMemory({ projectRoot: project, runId }) };
}

function decideGraphMemory(decision: "promoted" | "rejected", options: GraphOptions): unknown {
  return decideMemory({
    projectRoot: projectRoot(options),
    candidateId: requiredOption(options, "candidateId"),
    decision,
    actor: requiredOption(options, "actor"),
    rationale: requiredOption(options, "rationale"),
    sourceRef: requiredOption(options, "sourceRef"),
  });
}

async function graphCommand(
  command: string,
  options: GraphOptions,
  action?: string,
): Promise<unknown> {
  switch (command) {
    case "build":
      return projectGraph({ projectRoot: projectRoot(options), runId: options.runId });
    case "status":
      return graphStatus({ projectRoot: projectRoot(options), runId: options.runId });
    case "query":
      return graphQuery(options);
    case "explain":
      return explainGraph(options);
    case "memory":
      return memoryCommand(action ?? "list", options);
    case "workflow":
      return await workflowCommand(action ?? "list", options);
    default:
      throw new Error(`unknown graph command: ${command}`);
  }
}

async function workflowCommand(action: string, options: GraphOptions): Promise<unknown> {
  if (action === "analyze") return analyzeWorkflowFile(options);
  const registry = createWorkflowRegistry(projectRoot(options));
  if (action === "list") return registry.list();
  if (action === "show") return registry.show(requiredOption(options, "workflow"));
  if (action === "validate") {
    if (options.workflowFile) {
      const snapshot = loadWorkflow(resolve(options.workflowFile));
      return {
        valid: true,
        workflow_id: snapshot.workflow.workflow_id,
        revision: snapshot.workflow.revision,
        digest: snapshot.digest,
      };
    }
    return registry.validate(requiredOption(options, "workflow"), options.revision);
  }
  if (action === "diff")
    return registry.diff(requiredOption(options, "workflow"), {
      ...(options.from === undefined ? {} : { from: Number(options.from) }),
      ...(options.to === undefined ? {} : { to: Number(options.to) }),
    });
  if (action === "activate") {
    return registry.activate(requiredOption(options, "workflow"), options.revision, {
      digest: requiredOption(options, "digest"),
      actor: requiredOption(options, "actor"),
      rationale: requiredOption(options, "rationale"),
    });
  }
  if (action === "propose") {
    return await proposeWorkflowAsync(options);
  }
  throw new Error(`unknown graph workflow command: ${action}`);
}

function analyzeWorkflowFile(options: GraphOptions): Record<string, unknown> {
  if (!options.workflowFile) throw new Error("workflow analyze requires --workflow-file <path>");
  let workflow: unknown;
  try {
    workflow = JSON.parse(readFileSync(resolve(options.workflowFile), "utf8"));
  } catch (error) {
    return {
      valid: false,
      schema_diagnostics: [
        { kind: "parse", message: error instanceof Error ? error.message : String(error) },
      ],
      topology_diagnostics: [],
      unreachable_nodes: [],
      unsafe_writer_paths: [],
      missing_verification: {
        required: true,
        node_ids: [],
        terminal_dominated: false,
        diagnostics: ["workflow could not be parsed"],
      },
      estimated_max_attempts: 0,
      estimated_dynamic_instances: 0,
      dynamic_instance_limit: 0,
      concurrency_bound: 0,
      execution_routes: [],
      execution_profile_diagnostics: [],
      monetary_cost: { status: "unavailable" },
    };
  }
  const profile = options.executionProfile
    ? loadExecutionProfile(resolve(options.executionProfile)).profile
    : null;
  return analyzeWorkflow(workflow, { executionProfile: profile });
}

function graphQuery(options: GraphOptions): unknown {
  return queryGraph({
    projectRoot: projectRoot(options),
    runId: options.runId,
    seed: requiredOption(options, "seed"),
    phase: options.phase ?? "query",
    maxDepth: Number(options.depth ?? 4),
    maxRecords: Number(options.limit ?? 200),
    includeModelProposed: options.includeModelProposed,
  });
}

function explainGraph(options: GraphOptions): unknown {
  if (!options.node) throw new Error("graph explain requires --node <id>");
  return explainGraphNode({
    projectRoot: projectRoot(options),
    runId: options.runId,
    nodeId: options.node,
  });
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  const [command = "help", action] = options.positionals;
  if (["help", "--help", "-h"].includes(command) || options.help) return usage();
  emit(await graphCommand(command, options, action), options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
