/** Bounded, ephemeral workflow-proposal jobs. Candidates are never saved or activated here. */
import { randomUUID } from "node:crypto";
import { proposeWorkflowCandidateAsync, validateWorkflow } from "@rae/engine";
import type { LoadedExecutionProfile } from "./profiles.js";
import type { OperatorProject } from "./security.js";
const MAX_JOBS = 12;
const MAX_TASK_BYTES = 32 * 1024;
const PROPOSAL_FIELDS = new Set(["task", "base_revision", "execution_profile_id"]);

type HttpError = Error & { status: number };
type ProposalRecord = Record<string, unknown>;
interface ProposalInput {
  task: string;
  baseRevision: number | null;
  executionProfileId: unknown;
}
interface ProposalJob {
  id: string;
  workflowId: string;
  state: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  error?: string;
  candidate?: unknown;
}
interface PublicProposalJob {
  id: string;
  workflow_id: string;
  state: ProposalJob["state"];
  created_at: string;
  completed_at: string | null;
  error?: string;
  candidate?: unknown;
}
interface CandidateInput {
  projectRoot: string;
  workflowId: string;
  task: string;
  baseRevision: number | null;
  executionProfile?: string;
}
type CandidateRunner = (input: CandidateInput) => Promise<unknown>;

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

/** Validates the enclosing proposal object before field-specific checks. */
export function validateProposalBody(body: unknown): ProposalRecord {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw httpError(400, "proposal body is required");
  for (const key of Object.keys(body))
    if (!PROPOSAL_FIELDS.has(key)) throw httpError(400, `unsupported proposal field: ${key}`);
  return body as ProposalRecord;
}

/** Validates and normalizes the proposal fields accepted by the job queue. */
export function validateProposalFields(body: ProposalRecord): ProposalInput {
  if (typeof body.task !== "string" || body.task.trim().length === 0)
    throw httpError(400, "proposal task is required");
  if (Buffer.byteLength(body.task, "utf8") > MAX_TASK_BYTES)
    throw httpError(413, "proposal task exceeds 32768 bytes");
  if (body.base_revision !== undefined && !/^[0-9]{1,9}$/.test(String(body.base_revision))) {
    throw httpError(400, "invalid base_revision");
  }
  return {
    task: body.task.trim(),
    baseRevision:
      typeof body.base_revision === "string" || typeof body.base_revision === "number"
        ? Number(body.base_revision)
        : null,
    executionProfileId: body.execution_profile_id ?? null,
  };
}

function requestInput(body: unknown): ProposalInput {
  return validateProposalFields(validateProposalBody(body));
}

async function defaultCandidateRunner(input: CandidateInput): Promise<unknown> {
  // The legacy `proposeWorkflow` persists a draft and is deliberately never called.
  return proposeWorkflowCandidateAsync(input);
}

async function validateCandidate(candidate: object): Promise<unknown> {
  return validateWorkflow(candidate) as unknown;
}

function publicJob(job: ProposalJob): PublicProposalJob {
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
  private readonly candidateRunner: CandidateRunner;
  private readonly maxJobs: number;
  private readonly jobs: Map<string, ProposalJob>;

  constructor({
    candidateRunner = defaultCandidateRunner,
    maxJobs = MAX_JOBS,
  }: {
    candidateRunner?: CandidateRunner;
    maxJobs?: number;
  } = {}) {
    this.candidateRunner = candidateRunner;
    this.maxJobs = maxJobs;
    this.jobs = new Map<string, ProposalJob>();
  }

  submit({
    project,
    workflowId,
    body,
    executionProfile = null,
  }: {
    project: OperatorProject;
    workflowId: string;
    body: unknown;
    executionProfile?: LoadedExecutionProfile | null;
  }): PublicProposalJob {
    const input = requestInput(body);
    if (input.executionProfileId && !executionProfile?.source) {
      throw httpError(400, "execution_profile_id must name a preloaded execution profile");
    }
    if (this.jobs.size >= this.maxJobs) throw httpError(429, "workflow proposal queue is full");
    const job: ProposalJob = {
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
        job.error =
          error instanceof Error &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status >= 500
            ? error.message
            : "proposal could not be generated";
        job.state = "failed";
      } finally {
        job.completedAt = new Date().toISOString();
      }
    });
    return publicJob(job);
  }

  get(id: string, workflowId: string | null = null): PublicProposalJob {
    const job = this.jobs.get(id);
    if (!job) throw httpError(404, "proposal job not found");
    if (workflowId && job.workflowId !== workflowId) throw httpError(404, "proposal job not found");
    return publicJob(job);
  }
}
