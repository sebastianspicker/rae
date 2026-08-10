/** Executes immutable graph workflow snapshots through the central scheduler. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { changedPaths, assertGitStateInvariant } from "./autonomous-git.mjs";
import { signalProcessGroup } from "./agent-executor.mjs";
import { createCheckpoint, readOperatorControl, setRunStatus } from "./operator-control.mjs";
import { appendTraceEvent } from "./trace.mjs";
import { createRuntimeStateGuard, reconcileRuntimeStateGuard } from "./runtime-state-guard.mjs";
import { scheduleWorkflow } from "./workflow-scheduler.mjs";
import { applyWorkflowTransform } from "./workflow-transforms.mjs";
import { resolveExecutionTier, resolveNodeCapabilities } from "./execution-profile.mjs";
import { validateNodeEnvelope } from "./workflow-envelope.mjs";

const WORKER = resolve(import.meta.dirname, "../workflow-agent-worker.mjs");

function workspaceMutationFingerprint(workspaceRoot) {
  const hash = createHash("sha256");
  const visit = (relativePath) => {
    const absolute = resolve(workspaceRoot, relativePath);
    if (!existsSync(absolute)) {
      hash.update(`${relativePath}\0missing\0`);
      return;
    }
    const stat = lstatSync(absolute);
    hash.update(`${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(absolute));
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${relativePath}/${name}`);
      return;
    }
    if (stat.isFile()) hash.update(readFileSync(absolute));
  };
  for (const pathValue of changedPaths(workspaceRoot)) visit(pathValue);
  return hash.digest("hex");
}

function latestPassedEnvelope(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(directory, name), "utf8")))
    .filter((envelope) => envelope.status === "passed")
    .sort(
      (left, right) =>
        (left.loop_iteration ?? 1) - (right.loop_iteration ?? 1) || left.attempt - right.attempt,
    )
    .at(-1);
}

function assertSafeOwnershipPath(planNode, pathValue) {
  const unsafe =
    typeof pathValue !== "string" ||
    !pathValue ||
    pathValue.startsWith("/") ||
    pathValue.split("/").includes("..");
  if (unsafe) throw new Error(`ownership plan ${planNode.id} contains an unsafe path`);
}

function ownershipPlan(context) {
  const planNode = context.workflow.nodes.find((node) => node.ownership_plan === true);
  if (!planNode) throw new Error("workflow writer has no ownership-plan node");
  const directory = resolve(context.runDir, "workflow", "attempts", planNode.id);
  if (!existsSync(directory)) throw new Error(`workflow writer has no ${planNode.id} envelope`);
  const plan = latestPassedEnvelope(directory)?.payload;
  if (!Array.isArray(plan?.file_ownership) || plan.file_ownership.length === 0)
    throw new Error(`ownership plan ${planNode.id} must declare file_ownership`);
  for (const pathValue of plan.file_ownership) assertSafeOwnershipPath(planNode, pathValue);
  return plan;
}

function assertWriterEvidence(context, node, result, changed) {
  if (node.access !== "write") return;
  const plan = ownershipPlan(context);
  const unauthorized = changed.filter(
    (pathValue) =>
      !plan.file_ownership.some(
        (owned) => pathValue === owned || pathValue.startsWith(`${owned.replace(/\/$/, "")}/`),
      ),
  );
  if (unauthorized.length)
    throw new Error(
      `writer ${node.id} changed paths outside file_ownership: ${unauthorized.join(", ")}`,
    );
  if (
    result.provider === "codex" &&
    !(result.commandEvents ?? []).some(
      (event) => event.successful === true && event.exit_code === 0,
    )
  ) {
    throw new Error(`writer ${node.id} returned no successful command execution evidence`);
  }
}

function runWorker(request, cwd) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const timeout = AbortSignal.timeout(request.timeoutMs + 5000);
    const terminate = () => {
      if (!signalProcessGroup(child.pid, "SIGKILL")) child.kill("SIGKILL");
    };
    timeout.addEventListener("abort", terminate, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 20 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      timeout.removeEventListener("abort", terminate);
      if (code !== 0)
        reject(new Error(`workflow agent worker exited with ${code}: ${stderr.trim()}`));
      else accept(JSON.parse(stdout));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function nodeSchemaPath(context, node) {
  const pathValue = resolve(
    context.runDir,
    "workflow",
    "payload-contracts",
    `${node.id}.schema.json`,
  );
  const contract = context.workflow.payload_contracts?.[node.payload_contract] ?? {
    type: "object",
  };
  writeFileSync(pathValue, `${JSON.stringify(contract, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return pathValue;
}

function promptFor(context, node, inputs, item, assembledContext = null) {
  const inputPayloads = inputs.map(({ edge, envelope }) => ({
    source_node: edge.from,
    edge_type: edge.type,
    artifact: edge.artifact ?? null,
    envelope,
  }));
  return `You are executing one node in a RAE graph-native autonomous workflow.

Run: ${context.runId}
Workflow digest: ${context.workflowDigest}
Node: ${node.id}
Role: ${node.role ?? node.kind}
Mutation mode: ${node.access === "write" ? "workspace-write" : "read-only"}

User task:
${context.task}

${assembledContext ? "Bounded predecessor context (complete inline artifacts or immutable artifact references):" : "Typed predecessor envelopes:"}
${JSON.stringify(assembledContext ?? inputPayloads, null, 2)}

${item === undefined || item === null ? "" : `Mapped item:\n${JSON.stringify(item, null, 2)}\n`}

Node guidance:
${node.guidance}

Mandatory rules:
- Read applicable repository instructions and inspect source evidence before deciding.
- Stay inside the workspace. Never commit, push, publish, deploy, install dependencies, or alter Git remotes.
- Never read or print secrets, credentials, environment files, tokens, or private key material.
- ${node.access === "write" ? "Modify only paths owned by the plan and capture verification commands." : "Do not modify repository files."}
- Return only the JSON payload required by the supplied schema, without Markdown.
`;
}

async function providerNode(context, node, inputs, attempt, instance = {}) {
  const { instancePart, schemaPath, eventLogPath, outputPath } = providerPaths(
    context,
    node,
    attempt,
    instance,
  );
  const { result, beforeFingerprint } = await runProviderWorker(
    context,
    node,
    providerRequest(context, node, inputs, instance, { schemaPath, eventLogPath, outputPath }),
    eventLogPath,
  );
  validateProviderArtifact(context, node, result);
  const changed = changedPaths(context.workspaceRoot);
  assertReadOnlyNodeDidNotMutate(context, node, beforeFingerprint);
  assertWriterEvidence(context, node, result, changed);
  return providerResult(node, result, changed, instancePart, attempt);
}

function providerPaths(context, node, attempt, instance) {
  const outputDir = resolve(context.runDir, "workflow", "agent-outputs");
  const instanceName =
    !instance.instance_id && Number(instance.loop_iteration ?? 1) > 1
      ? `${node.id}.loop-${instance.loop_iteration}`
      : (instance.instance_id ?? node.id);
  const instancePart = instanceName.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  return {
    instancePart,
    schemaPath: nodeSchemaPath(context, node),
    eventLogPath: resolve(outputDir, `${instancePart}.${attempt}.events.jsonl`),
    outputPath: resolve(outputDir, `${instancePart}.${attempt}.json`),
  };
}

function providerRequest(
  context,
  node,
  inputs,
  instance,
  { schemaPath, eventLogPath, outputPath },
) {
  return {
    provider: instance.execution?.executor ?? context.options.provider ?? "auto",
    command: context.options["agent-command"],
    commandArgs: context.options.agentArgs,
    phase: node.id,
    runId: context.runId,
    workspaceRoot: context.workspaceRoot,
    schemaPath,
    outputPath,
    eventLogPath,
    prompt: promptFor(context, node, inputs, instance.item, instance.context?.prompt_context),
    sandboxMode: node.access === "write" ? "workspace-write" : "read-only",
    model: instance.execution?.model ?? context.options.model,
    reasoningEffort: instance.execution?.reasoning_effort ?? context.options["reasoning-effort"],
    variant: instance.execution?.variant ?? null,
    routeId: instance.execution?.route_id ?? null,
    capabilities: instance.execution?.capabilities ?? null,
    sourceRoot: context.projectRoot,
    runDir: context.runDir,
    inPlace: context.workspaceRoot === context.projectRoot,
    timeoutMs: Number(context.options["timeout-seconds"] ?? 1800) * 1000,
    allowUnsafeCommand: context.options["allow-unsafe-command-provider"] === true,
  };
}

async function runProviderWorker(context, node, request, eventLogPath) {
  const beforeFingerprint = workspaceMutationFingerprint(context.workspaceRoot);
  if (node.access !== "write") {
    return { result: await runWorker(request, context.workspaceRoot), beforeFingerprint };
  }
  createRuntimeStateGuard(context.workspaceRoot, context.runId, node.id);
  let result;
  let executionError;
  try {
    result = await runWorker(request, context.workspaceRoot);
  } catch (error) {
    executionError = error;
  } finally {
    const reconciliation = reconcileRuntimeStateGuard(context.workspaceRoot, {
      allowedRefs: [relative(resolve(context.workspaceRoot, ".pipeline"), eventLogPath)],
      expectedRunId: context.runId,
    });
    if (reconciliation.tampered) {
      executionError = new Error(`provider modified protected runtime state in ${node.id}`);
    }
  }
  if (executionError) throw executionError;
  return { result, beforeFingerprint };
}

function validateProviderArtifact(context, node, result) {
  const contract = context.workflow.payload_contracts?.[node.payload_contract] ?? {
    type: "object",
  };
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(contract);
  if (!validate(result.artifact)) throw new Error(`node ${node.id} returned an invalid payload`);
  assertGitStateInvariant(context.workspaceRoot, context.initialGitState, node.id);
}

function assertReadOnlyNodeDidNotMutate(context, node, beforeFingerprint) {
  if (
    node.access !== "write" &&
    workspaceMutationFingerprint(context.workspaceRoot) !== beforeFingerprint
  ) {
    throw new Error(`read-only node ${node.id} changed repository content`);
  }
}

function providerResult(node, result, changed, instancePart, attempt) {
  return {
    status: result.artifact.status ?? "passed",
    payload: result.artifact,
    findings: result.artifact.findings ?? [],
    changed_paths: node.access === "write" ? changed : [],
    command_evidence: result.commandEvents ?? [],
    resource_usage: {
      ...(result.resourceUsage ?? {}),
      capability_surface: result.capabilitySurface ?? null,
      credential_manifest: result.credentialManifest ?? [],
    },
    evidence_refs: [`workflow/agent-outputs/${instancePart}.${attempt}.events.jsonl`],
  };
}

function deterministicNode(context, node, inputs) {
  if (node.kind === "checkpoint") {
    const policy = context.options["checkpoint-policy"] ?? "none";
    if (["before-mutation", "before-mutation-and-ship"].includes(policy)) {
      const checkpoint = createCheckpoint(
        context.runId,
        {
          phase: node.id,
          purpose: "mutation",
          message: "Human approval is required before the graph workflow may modify the workspace.",
        },
        context.workspaceRoot,
      );
      if (checkpoint.status !== "approved") {
        setRunStatus(context.runId, "waiting", context.workspaceRoot, {
          waiting_checkpoint_id: checkpoint.checkpoint_id,
          stop_requested: false,
        });
        const error = new Error(`workflow is waiting for checkpoint ${checkpoint.checkpoint_id}`);
        error.workflowWaiting = true;
        throw error;
      }
    }
  }
  const payload = {
    node_id: node.id,
    status: "passed",
    inputs: inputs.map(({ edge, envelope }) => ({
      source: edge.from,
      digest: envelope.output_digest,
    })),
  };
  if (node.kind === "join") {
    payload.findings = inputs.flatMap(({ envelope }) => envelope.findings ?? []);
    if (node.join === "any" && inputs[0])
      payload.selection = {
        mode: "any",
        winner: inputs[0].envelope.instance_id ?? inputs[0].envelope.node_id,
      };
    if (node.join === "quorum")
      payload.quorum = { threshold: node.quorum.threshold, accepted: inputs.length };
  }
  if (node.kind === "transform") {
    const source =
      inputs.length === 1
        ? inputs[0].envelope.payload
        : { inputs: inputs.map(({ envelope }) => envelope.payload) };
    payload.items = applyWorkflowTransform(node.transform, source);
  }
  if (node.kind === "gate") {
    const findings = inputs.flatMap(({ envelope }) => envelope.findings ?? []);
    const blocking = findings.some(
      (finding) => finding.blocking === true || finding.severity === "blocking",
    );
    payload.status = blocking ? "failed" : "passed";
    payload.findings = findings;
  }
  return { status: payload.status, payload, findings: payload.findings ?? [] };
}

function resumeEnvelopes(context) {
  const root = resolve(context.runDir, "workflow", "attempts");
  if (!existsSync(root)) return [];
  const envelopes = [];
  for (const nodeId of readdirSync(root).sort()) {
    const directory = resolve(root, nodeId);
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const latestByInstance = new Map();
    for (const name of files) {
      const envelope = JSON.parse(readFileSync(resolve(directory, name), "utf8"));
      validateNodeEnvelope(envelope);
      if (envelope.run_id !== context.runId)
        throw new Error(`resume envelope ${nodeId} belongs to a different run`);
      if (envelope.workflow_digest !== context.workflowDigest) {
        throw new Error(`resume envelope ${nodeId} does not match the immutable workflow snapshot`);
      }
      const id = envelope.instance_id ?? envelope.node_id;
      const prior = latestByInstance.get(id);
      if (!prior || envelope.attempt >= prior.attempt) latestByInstance.set(id, envelope);
    }
    envelopes.push(...latestByInstance.values());
  }
  return envelopes;
}

export async function runGraphWorkflow(context, options) {
  const event = (entry) =>
    appendTraceEvent(
      context.runId,
      {
        event: `workflow_${entry.event}`,
        phase: entry.node_id ?? context.workflow.entry_node,
        status: entry.status ?? "ok",
        metadata: Object.fromEntries(
          Object.entries(entry).filter(([key]) => !["event", "status"].includes(key)),
        ),
      },
      context.workspaceRoot,
    );
  return scheduleWorkflow({
    workflow: context.workflow,
    runId: context.runId,
    runDir: context.runDir,
    maxConcurrency: Number(options["max-concurrency"] ?? 4),
    maxRepairRounds: Number(options["max-repair-rounds"] ?? 5),
    through: options.through ?? null,
    stopRequested: () => readOperatorControl(context.runId, context.workspaceRoot).stop_requested,
    resumeEnvelopes: resumeEnvelopes(context),
    onEvent: event,
    task: context.task,
    verifiedGraphRecords: context.verifiedGraphRecords ?? [],
    admittedMemory: context.admittedMemory ?? [],
    contextPolicy: context.contextPolicy ?? options.contextPolicy ?? {},
    resolveTier: (tier, nodeId) => ({
      ...resolveExecutionTier(context.executionProfile, tier, nodeId),
      capabilities: resolveNodeCapabilities(context.executionProfile, nodeId),
    }),
    execute: ({ node, inputs, attempt, ...instance }) =>
      ["agent", "map"].includes(node.kind)
        ? providerNode({ ...context, options }, node, inputs, attempt, instance)
        : deterministicNode({ ...context, options }, node, inputs),
  });
}
