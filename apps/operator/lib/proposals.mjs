/** Bounded, ephemeral workflow-proposal jobs. Candidates are never saved or activated here. */
import { randomUUID } from "node:crypto";
import {
  proposeWorkflowCandidate,
  validateWorkflow,
} from "@rae/engine";
const MAX_JOBS = 12;
const MAX_TASK_BYTES = 32 * 1024;
const PROPOSAL_FIELDS = new Set(["task", "base_revision", "execution_profile_id"]);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Validates the enclosing proposal object before field-specific checks. */
export function validateProposalBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw httpError(400, "proposal body is required");
  for (const key of Object.keys(body))
    if (!PROPOSAL_FIELDS.has(key)) throw httpError(400, `unsupported proposal field: ${key}`);
  return body;
}

/** Validates and normalizes the proposal fields accepted by the job queue. */
export function validateProposalFields(body) {
  if (typeof body.task !== "string" || body.task.trim().length === 0)
    throw httpError(400, "proposal task is required");
  if (Buffer.byteLength(body.task, "utf8") > MAX_TASK_BYTES)
    throw httpError(413, "proposal task exceeds 32768 bytes");
  if (body.base_revision !== undefined && !/^[0-9]{1,9}$/.test(String(body.base_revision))) {
    throw httpError(400, "invalid base_revision");
  }
  return {
    task: body.task.trim(),
    baseRevision: body.base_revision ?? null,
    executionProfileId: body.execution_profile_id ?? null,
  };
}

function requestInput(body) {
  return validateProposalFields(validateProposalBody(body));
}

async function defaultCandidateRunner(input) {
  // The legacy `proposeWorkflow` persists a draft and is deliberately never called.
  return proposeWorkflowCandidate(input);
}

async function validateCandidate(candidate) {
  return validateWorkflow(candidate);
}

function publicJob(job) {
  return {
    id: job.id,
    workflow_id: job.workflowId,
    state: job.state,
    created_at: job.createdAt,
    completed_at: job.completedAt ?? null,
    ...(job.error ? { error: job.error } : {}),
    ...(job.candidate ? { candidate: job.candidate } : {}),
  };
}

export class WorkflowProposalJobs {
  constructor({ candidateRunner = defaultCandidateRunner, maxJobs = MAX_JOBS } = {}) {
    this.candidateRunner = candidateRunner;
    this.maxJobs = maxJobs;
    this.jobs = new Map();
  }

  submit({ project, workflowId, body, executionProfile = null }) {
    const input = requestInput(body);
    if (input.executionProfileId && !executionProfile?.source) {
      throw httpError(400, "execution_profile_id must name a preloaded execution profile");
    }
    if (this.jobs.size >= this.maxJobs) throw httpError(429, "workflow proposal queue is full");
    const job = {
      id: `proposal-${randomUUID()}`,
      workflowId,
      state: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    queueMicrotask(async () => {
      job.state = "running";
      try {
        const candidate = await this.candidateRunner({
          projectRoot: project.root,
          workflowId,
          task: input.task,
          baseRevision: input.baseRevision,
          ...(executionProfile ? { executionProfile: executionProfile.source } : {}),
        });
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          throw new Error("proposal runner returned no workflow candidate");
        }
        job.candidate = structuredClone(await validateCandidate(candidate));
        job.state = "completed";
      } catch (error) {
        job.error = error?.status >= 500 ? error.message : "proposal could not be generated";
        job.state = "failed";
      } finally {
        job.completedAt = new Date().toISOString();
      }
    });
    return publicJob(job);
  }

  get(id, workflowId = null) {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, "proposal job not found");
    if (workflowId && job.workflowId !== workflowId) throw httpError(404, "proposal job not found");
    return publicJob(job);
  }
}
