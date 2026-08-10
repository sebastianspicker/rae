/** Produces a locally validated workflow draft from one read-only ephemeral Codex proposal. */
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { runAgentPhase } from "./agent-executor.mjs";
import { loadExecutionProfile, resolveExecutionTier } from "./execution-profile.mjs";
import { loadWorkflow, validateWorkflow } from "./workflow-contract.mjs";
import { createWorkflowRegistry } from "./workflow-registry.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const V21_SCHEMA = resolve(PACKAGE_ROOT, "contracts/workflows/workflow-v2.1.schema.json");
const MAX_TASK_BYTES = 128 * 1024;

function taskFilePath(options, projectRoot) {
  const candidate = resolve(projectRoot, options.taskFile);
  const rel = relative(projectRoot, candidate);
  if (isAbsolute(rel) || rel.startsWith(".."))
    throw new Error("task file must remain below project root");
  return { candidate, rel };
}

function assertSafeTaskFilePath(rel) {
  const protectedPath = rel
    .split(/[\\/]/)
    .some((part) =>
      /^(?:[.]?(?:aws|azure|gnupg|kube|ssh)|.*(?:credential|password|private-key|secret|token).*)$/i.test(
        part,
      ),
    );
  if (protectedPath) throw new Error("task file path may not name protected credential material");
}

function readTaskFile(candidate, rel) {
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

function taskText(options, projectRoot) {
  if (Boolean(options.task) === Boolean(options.taskFile))
    throw new Error("workflow propose requires exactly one of --task or --task-file");
  if (options.task) return options.task;
  const { candidate, rel } = taskFilePath(options, projectRoot);
  return readTaskFile(candidate, rel);
}

function baseWorkflow(options, registry) {
  if (!options.baseWorkflow) throw new Error("workflow propose requires --base-workflow");
  if (existsSync(resolve(options.baseWorkflow)))
    return loadWorkflow(resolve(options.baseWorkflow)).workflow;
  return registry.show(options.baseWorkflow).workflow;
}

function proposalPrompt({ task, base, correction = null }) {
  return `Propose one RAE workflow revision for the task below.

Task:
${task}

Base workflow:
${JSON.stringify(base, null, 2)}

Return a complete schema_version 2.1.0 workflow JSON object. Preserve workflow_id, set revision to ${base.revision + 1}, and keep all expansion bounded. Workflow JSON is data only: never include commands, JavaScript, expressions, environment values, tools, providers, concrete model names, reasoning efforts, or remote schema references. Use only logical economy, standard, or judgment tiers. The proposal is a draft and must not claim activation or execution.
${correction ? `\nThe first proposal failed local validation. Correct only these errors and return a complete replacement:\n${correction}\n` : ""}`;
}

function runProposal(projectRoot, prompt, temporary, attempt, execution) {
  return runAgentPhase({
    provider: execution?.executor ?? "codex",
    phase: `workflow-proposal-${attempt}`,
    runId: `proposal-${process.pid}`,
    workspaceRoot: projectRoot,
    schemaPath: V21_SCHEMA,
    outputPath: resolve(temporary, `proposal-${attempt}.json`),
    eventLogPath: resolve(temporary, `proposal-${attempt}.events.jsonl`),
    prompt,
    sandboxMode: "read-only",
    model: execution?.model,
    reasoningEffort: execution?.reasoning_effort,
    variant: execution?.variant,
    sourceRoot: projectRoot,
    inPlace: true,
    timeoutMs: 30 * 60 * 1000,
  }).artifact;
}

function proposalBase(options, registry) {
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

function proposalTask(options, projectRoot) {
  if (options.workflowId) return options.task;
  return taskText(options, projectRoot);
}

function generateCandidate(options) {
  const projectRoot = realpathSync(resolve(options.projectRoot ?? process.cwd()));
  const registry = createWorkflowRegistry(projectRoot);
  const base = proposalBase(options, registry);
  const task = String(proposalTask(options, projectRoot) ?? "").trim();
  if (!task || Buffer.byteLength(task, "utf8") > MAX_TASK_BYTES)
    throw new Error(`proposal task must be from 1 to ${MAX_TASK_BYTES} bytes`);
  const temporary = mkdtempSync(resolve(tmpdir(), "rae-workflow-proposal-"));
  const loadedProfile = options.executionProfile
    ? loadExecutionProfile(resolve(options.executionProfile))
    : null;
  const execution = loadedProfile ? resolveExecutionTier(loadedProfile.profile, "judgment") : null;
  try {
    let candidate = runProposal(
      projectRoot,
      proposalPrompt({ task, base }),
      temporary,
      1,
      execution,
    );
    let validationError = null;
    try {
      candidate = validateWorkflow(candidate);
    } catch (error) {
      validationError = error;
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
    if (candidate.workflow_id !== base.workflow_id || candidate.revision !== base.revision + 1)
      throw new Error("proposal must preserve workflow id and increment the base revision once");
    return {
      candidate,
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
export function proposeWorkflowCandidate(options) {
  return generateCandidate(options).candidate;
}

export function proposeWorkflow(options) {
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
