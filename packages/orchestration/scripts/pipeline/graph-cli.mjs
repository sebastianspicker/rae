#!/usr/bin/env node
/** Exposes local graph projection, query, explanation, and memory lifecycle commands. */
import { readFileSync } from "node:fs";
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
import { loadWorkflow } from "./lib/workflow-contract.mjs";
import { loadExecutionProfile } from "./lib/execution-profile.mjs";
import { createWorkflowRegistry } from "./lib/workflow-registry.mjs";
import { proposeWorkflow } from "./lib/workflow-proposal.mjs";
import { analyzeWorkflow } from "./lib/workflow-designer.mjs";

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
  ./scripts/rae.sh graph workflow list --project-root <path> [--json]
  ./scripts/rae.sh graph workflow show --project-root <path> --workflow <id> [--json]
  ./scripts/rae.sh graph workflow validate --project-root <path> (--workflow-file <path> | --workflow <id> --revision <n>) [--json]
  ./scripts/rae.sh graph workflow analyze --workflow-file <path> [--execution-profile <path>] [--json]
  ./scripts/rae.sh graph workflow diff --project-root <path> --workflow <id> --from <n> --to <n> [--json]
  ./scripts/rae.sh graph workflow activate --project-root <path> --workflow <id> --revision <n> --digest <sha256> --actor <label> --rationale <text> [--json]
  ./scripts/rae.sh graph workflow propose --project-root <path> (--task <text> | --task-file <path>) --base-workflow <id|file> --actor <label> --rationale <text> [--execution-profile <path>] [--preview] [--json]

Graph execution is opt-in. Projections augment raw evidence and never authorize mutation,
change gates, alter Git state, or broaden plan ownership.
`);
}

function parse(argv) {
  const output = {
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
    if (!token.startsWith("--")) {
      output.positionals.push(token);
      continue;
    }
    if (!assignBooleanOption(output, token))
      assignOption(output, token, optionValue(remaining, token));
  }
  return output;
}

function assignBooleanOption(output, option) {
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

function optionValue(remaining, option) {
  const value = remaining.shift();
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${option}`);
  return value;
}

function assignOption(output, option, value) {
  if (assignPrimaryOption(output, option, value)) return;
  if (assignSecondaryOption(output, option, value)) return;
  throw new Error(`unknown graph option: ${option}`);
}

function assignPrimaryOption(output, option, value) {
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

function assignWorkflowFileOption(output, option, value) {
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

function assignSecondaryOption(output, option, value) {
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

function emit(value, options) {
  if (options.json) return process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) || (item && typeof item === "object"))
      process.stdout.write(`${key}: ${JSON.stringify(item)}\n`);
    else process.stdout.write(`${key}: ${item}\n`);
  }
}

function projectRoot(options) {
  return resolve(options.projectRoot ?? process.cwd());
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
  const runId = options.runId;
  const result = rebuildMemory({ projectRoot: project, runId });
  if (!runId) return result;
  return { ...result, imported: recordRunMemory({ projectRoot: project, runId }) };
}

function decideGraphMemory(decision, options) {
  return decideMemory({
    projectRoot: projectRoot(options),
    candidateId: options.candidateId,
    decision,
    actor: options.actor,
    rationale: options.rationale,
    sourceRef: options.sourceRef,
  });
}

function graphCommand(command, options, action) {
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
      return workflowCommand(action ?? "list", options);
    default:
      throw new Error(`unknown graph command: ${command}`);
  }
}

function workflowCommand(action, options) {
  if (action === "analyze") return analyzeWorkflowFile(options);
  const registry = createWorkflowRegistry(projectRoot(options));
  if (action === "list") return registry.list();
  if (action === "show") return registry.show(options.workflow);
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
    return registry.validate(options.workflow, options.revision);
  }
  if (action === "diff")
    return registry.diff(options.workflow, { from: options.from, to: options.to });
  if (action === "activate") {
    return registry.activate(options.workflow, options.revision, {
      digest: options.digest,
      actor: options.actor,
      rationale: options.rationale,
    });
  }
  if (action === "propose") {
    return proposeWorkflow(options);
  }
  throw new Error(`unknown graph workflow command: ${action}`);
}

function analyzeWorkflowFile(options) {
  if (!options.workflowFile) throw new Error("workflow analyze requires --workflow-file <path>");
  let workflow;
  try {
    workflow = JSON.parse(readFileSync(resolve(options.workflowFile), "utf8"));
  } catch (error) {
    return {
      valid: false,
      schema_diagnostics: [{ kind: "parse", message: error.message }],
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

function graphQuery(options) {
  return queryGraph({
    projectRoot: projectRoot(options),
    runId: options.runId,
    seed: options.seed,
    phase: options.phase ?? "query",
    maxDepth: Number(options.depth ?? 4),
    maxRecords: Number(options.limit ?? 200),
    includeModelProposed: options.includeModelProposed,
  });
}

function explainGraph(options) {
  if (!options.node) throw new Error("graph explain requires --node <id>");
  return explainGraphNode({
    projectRoot: projectRoot(options),
    runId: options.runId,
    nodeId: options.node,
  });
}

function main() {
  const options = parse(process.argv.slice(2));
  const [command = "help", action] = options.positionals;
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
