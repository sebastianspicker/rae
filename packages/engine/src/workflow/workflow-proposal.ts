/** Produces a locally validated workflow draft from one read-only ephemeral Codex proposal. */
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { runAgentPhase } from "../agents/agent-executor.js";
import { redact } from "../agents/agent-provider-runtime.js";
import { loadExecutionProfile, resolveExecutionTier } from "./execution-profile.js";
import { loadWorkflow, validateWorkflow } from "./workflow-contract.js";
import { createWorkflowRegistry } from "./workflow-registry.js";
import { contractsRoot } from "../primitives/installation-paths.js";
import type { ExecutionProfile, CapabilitySet } from "./execution-profile.js";
import type { WorkflowContract } from "./workflow-contract.js";
import type { ProposalHelperRequest } from "./workflow-proposal-helper.js";

const V21_SCHEMA = resolve(contractsRoot, "workflows/workflow-v2.1.schema.json");
const MAX_TASK_BYTES = 128 * 1024;

interface ProposalOptions {
  projectRoot?: string;
  task?: string;
  taskFile?: string;
  baseWorkflow?: string;
  workflowId?: string;
  baseRevision?: number | null;
  executionProfile?: string;
  preview?: boolean;
  actor?: string;
  rationale?: string;
}
interface ProposalExecutionRoute extends Record<string, unknown> {
  executor?: "codex" | "opencode";
  model?: string;
  reasoning_effort?: string;
  variant?: string;
  capabilities?: CapabilitySet;
}
interface ProposalRegistry {
  show: ReturnType<typeof createWorkflowRegistry>["show"];
  draft: ReturnType<typeof createWorkflowRegistry>["draft"];
}
interface GeneratedProposal {
  candidate: WorkflowContract;
  base: WorkflowContract;
  registry: ReturnType<typeof createWorkflowRegistry>;
  execution_route: ProposalExecutionRoute | null;
  execution_profile_digest: string | null;
}

function executionRoute(profile: ExecutionProfile): ProposalExecutionRoute {
  return resolveExecutionTier(profile, "judgment") as ProposalExecutionRoute;
}

function taskFilePath(
  options: ProposalOptions,
  projectRoot: string,
): { candidate: string; rel: string } {
  if (!options.taskFile) throw new Error("workflow propose requires --task-file");
  const candidate = resolve(projectRoot, options.taskFile);
  const rel = relative(projectRoot, candidate);
  if (isAbsolute(rel) || rel.startsWith(".."))
    throw new Error("task file must remain below project root");
  return { candidate, rel };
}

function assertSafeTaskFilePath(rel: string): void {
  const protectedPath = rel
    .split(/[\\/]/)
    .some((part) =>
      /^(?:[.]?(?:aws|azure|gnupg|kube|ssh)|.*(?:credential|password|private-key|secret|token).*)$/i.test(
        part,
      ),
    );
  if (protectedPath) throw new Error("task file path may not name protected credential material");
}

function readTaskFile(candidate: string, rel: string): string {
  assertSafeTaskFilePath(rel);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(candidate) !== candidate)
    throw new Error("task file must be a regular non-symlink file");
  if (!/[.](?:md|txt)$/i.test(candidate)) throw new Error("task file must use .md or .txt");
  if (stat.size > MAX_TASK_BYTES) throw new Error(`proposal task exceeds ${MAX_TASK_BYTES} bytes`);
  const text = readFileSync(candidate, "utf8");
  if (text.includes("\0") || text.includes("�"))
    throw new Error("task file must contain valid UTF-8 text");
  return text;
}

function taskText(options: ProposalOptions, projectRoot: string): string {
  if (Boolean(options.task) === Boolean(options.taskFile))
    throw new Error("workflow propose requires exactly one of --task or --task-file");
  if (options.task) return options.task;
  const { candidate, rel } = taskFilePath(options, projectRoot);
  return readTaskFile(candidate, rel);
}

function baseWorkflow(options: ProposalOptions, registry: ProposalRegistry): WorkflowContract {
  if (!options.baseWorkflow) throw new Error("workflow propose requires --base-workflow");
  if (existsSync(resolve(options.baseWorkflow)))
    return loadWorkflow(resolve(options.baseWorkflow)).workflow;
  return registry.show(options.baseWorkflow).workflow;
}

function proposalPrompt({
  task,
  base,
  correction = null,
}: {
  task: string;
  base: WorkflowContract;
  correction?: string | null;
}): string {
  return `Propose one RAE workflow revision for the task below.

Task:
${task}

Base workflow:
${JSON.stringify(base, null, 2)}

Return a complete schema_version 2.1.0 workflow JSON object. Preserve workflow_id, set revision to ${base.revision + 1}, and keep all expansion bounded. Workflow JSON is data only: never include commands, JavaScript, expressions, environment values, tools, providers, concrete model names, reasoning efforts, or remote schema references. Use only logical economy, standard, or judgment tiers. The proposal is a draft and must not claim activation or execution.
${correction ? `\nThe first proposal failed local validation. Correct only these errors and return a complete replacement:\n${correction}\n` : ""}`;
}

function proposalRequest(
  projectRoot: string,
  prompt: string,
  temporary: string,
  attempt: 1 | 2,
  execution: ProposalExecutionRoute | null,
): ProposalHelperRequest {
  return { projectRoot, prompt, temporary, attempt, execution };
}

function parseHelperResponse(raw: string): Record<string, unknown> {
  let response: unknown;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error("workflow proposal helper returned an invalid response");
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("workflow proposal helper returned an invalid response");
  }
  const record = response as Record<string, unknown>;
  if (record.success !== true || !record.artifact || typeof record.artifact !== "object") {
    const error = record.error;
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "workflow proposal helper failed";
    throw new Error(redact(message));
  }
  return record.artifact as Record<string, unknown>;
}

function runProposal(
  projectRoot: string,
  prompt: string,
  temporary: string,
  attempt: 1 | 2,
  execution: ProposalExecutionRoute | null,
): Record<string, unknown> {
  const helper = resolve(import.meta.dirname, "workflow-proposal-helper.js");
  const result = spawnSync(process.execPath, [helper], {
    cwd: projectRoot,
    input: JSON.stringify(proposalRequest(projectRoot, prompt, temporary, attempt, execution)),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
  if (result.error) {
    throw new Error(`workflow proposal helper failed to start: ${redact(result.error.message)}`);
  }
  if (result.status !== 0) {
    if (result.stdout.trim()) return parseHelperResponse(result.stdout);
    throw new Error(
      `workflow proposal helper failed: ${redact(result.stderr).slice(-2000) || "no diagnostic"}`,
    );
  }
  return parseHelperResponse(result.stdout);
}

async function runProposalAsync(
  projectRoot: string,
  prompt: string,
  temporary: string,
  attempt: 1 | 2,
  execution: ProposalExecutionRoute | null,
): Promise<Record<string, unknown>> {
  const result = await runAgentPhase({
    provider: execution?.executor ?? "codex",
    phase: `workflow-proposal-${attempt}`,
    runId: `proposal-${process.pid}`,
    workspaceRoot: projectRoot,
    schemaPath: V21_SCHEMA,
    outputPath: resolve(temporary, `proposal-${attempt}.json`),
    eventLogPath: resolve(temporary, `proposal-${attempt}.events.jsonl`),
    eventLogRoot: temporary,
    prompt,
    sandboxMode: "read-only",
    model: execution?.model,
    reasoningEffort: execution?.reasoning_effort,
    variant: execution?.variant,
    sourceRoot: projectRoot,
    inPlace: true,
    timeoutMs: 30 * 60 * 1000,
  });
  return result.artifact;
}

function proposalBase(options: ProposalOptions, registry: ProposalRegistry): WorkflowContract {
  if (options.workflowId) {
    const shown = registry.show(options.workflowId);
    if (
      options.baseRevision !== null &&
      options.baseRevision !== undefined &&
      Number(options.baseRevision) !== shown.workflow.revision
    ) {
      throw Object.assign(new Error("proposal base revision conflict"), { status: 409 });
    }
    return shown.workflow;
  }
  return baseWorkflow(options, registry);
}

function proposalTask(options: ProposalOptions, projectRoot: string): string | undefined {
  if (options.workflowId) return options.task;
  return taskText(options, projectRoot);
}

function generateCandidate(options: ProposalOptions): GeneratedProposal {
  const projectRoot = realpathSync(resolve(options.projectRoot ?? process.cwd()));
  const registry = createWorkflowRegistry(projectRoot);
  const base = proposalBase(options, registry);
  const task = String(proposalTask(options, projectRoot) ?? "").trim();
  if (!task || Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES)
    throw new Error(`proposal task must be from 1 to ${MAX_TASK_BYTES} bytes`);
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-workflow-proposal-")));
  const loadedProfile = options.executionProfile
    ? loadExecutionProfile(resolve(options.executionProfile))
    : null;
  const execution = loadedProfile ? executionRoute(loadedProfile.profile) : null;
  try {
    let candidate = runProposal(
      projectRoot,
      proposalPrompt({ task, base }),
      temporary,
      1,
      execution,
    );
    let validationError: Error | null = null;
    try {
      candidate = validateWorkflow(candidate);
    } catch (error) {
      validationError = error instanceof Error ? error : new Error(String(error));
    }
    if (validationError) {
      candidate = runProposal(
        projectRoot,
        proposalPrompt({ task, base, correction: validationError.message }),
        temporary,
        2,
        execution,
      );
      candidate = validateWorkflow(candidate);
    }
    const validated = validateWorkflow(candidate);
    if (validated.workflow_id !== base.workflow_id || validated.revision !== base.revision + 1)
      throw new Error("proposal must preserve workflow id and increment the base revision once");
    return {
      candidate: validated,
      base,
      registry,
      execution_route: execution,
      execution_profile_digest: loadedProfile?.digest ?? null,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function generateCandidateAsync(options: ProposalOptions): Promise<GeneratedProposal> {
  const projectRoot = realpathSync(resolve(options.projectRoot ?? process.cwd()));
  const registry = createWorkflowRegistry(projectRoot);
  const base = proposalBase(options, registry);
  const task = String(proposalTask(options, projectRoot) ?? "").trim();
  if (!task || Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES) {
    throw new Error(`proposal task must be from 1 to ${MAX_TASK_BYTES} bytes`);
  }
  const temporary = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-workflow-proposal-")));
  const loadedProfile = options.executionProfile
    ? loadExecutionProfile(resolve(options.executionProfile))
    : null;
  const execution = loadedProfile ? executionRoute(loadedProfile.profile) : null;
  try {
    let candidate: unknown = await runProposalAsync(
      projectRoot,
      proposalPrompt({ task, base }),
      temporary,
      1,
      execution,
    );
    let validationError: Error | null = null;
    try {
      candidate = validateWorkflow(candidate);
    } catch (error) {
      validationError = error instanceof Error ? error : new Error(String(error));
    }
    if (validationError) {
      candidate = await runProposalAsync(
        projectRoot,
        proposalPrompt({ task, base, correction: validationError.message }),
        temporary,
        2,
        execution,
      );
      candidate = validateWorkflow(candidate);
    }
    const validated = candidate as WorkflowContract;
    if (validated.workflow_id !== base.workflow_id || validated.revision !== base.revision + 1) {
      throw new Error("proposal must preserve workflow id and increment the base revision once");
    }
    return {
      candidate: validated,
      base,
      registry,
      execution_route: execution,
      execution_profile_digest: loadedProfile?.digest ?? null,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Returns one validated candidate without saving or activating it. */
export function proposeWorkflowCandidate(options: ProposalOptions): WorkflowContract {
  return generateCandidate(options).candidate;
}

export async function proposeWorkflowCandidateAsync(
  options: ProposalOptions,
): Promise<WorkflowContract> {
  return (await generateCandidateAsync(options)).candidate;
}

export function proposeWorkflow(options: ProposalOptions): Record<string, unknown> {
  const generated = generateCandidate(options);
  if (options.preview) {
    return {
      decision: "previewed",
      drafted: false,
      activated: false,
      executed: false,
      workflow: generated.candidate,
      execution_route: generated.execution_route,
      execution_profile_digest: generated.execution_profile_digest,
    };
  }
  const record = generated.registry.draft(generated.candidate.workflow_id, {
    expected_revision: generated.base.revision,
    actor: options.actor,
    rationale: options.rationale,
    workflow: generated.candidate,
  });
  return {
    ...record,
    decision: "drafted",
    activated: false,
    executed: false,
    execution_route: generated.execution_route,
    execution_profile_digest: generated.execution_profile_digest,
  };
}

export async function proposeWorkflowAsync(
  options: ProposalOptions,
): Promise<Record<string, unknown>> {
  const generated = await generateCandidateAsync(options);
  if (options.preview) {
    return {
      decision: "previewed",
      drafted: false,
      activated: false,
      executed: false,
      workflow: generated.candidate,
      execution_route: generated.execution_route,
      execution_profile_digest: generated.execution_profile_digest,
    };
  }
  const record = generated.registry.draft(generated.candidate.workflow_id, {
    expected_revision: generated.base.revision,
    actor: options.actor,
    rationale: options.rationale,
    workflow: generated.candidate,
  });
  return {
    ...record,
    decision: "drafted",
    activated: false,
    executed: false,
    execution_route: generated.execution_route,
    execution_profile_digest: generated.execution_profile_digest,
  };
}
