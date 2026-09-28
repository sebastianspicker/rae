/**
 * Maintains the persisted review-loop state machine used by pipeline review commands.
 */
import { getRunDir } from "./state.js";
import { badInput } from "../primitives/errors.js";

export type ReviewState = "explain" | "fix" | "ship";
export type ReviewStatus =
  | "not-started"
  | "in-progress"
  | "pending-approval"
  | "approved"
  | "rejected"
  | "completed";
interface ReviewStateRecord {
  status: ReviewStatus;
  code_mutation_allowed: boolean;
  approval_required: boolean;
  note?: string;
}
export interface ReviewLoop extends Record<string, unknown> {
  run_id: string;
  current_state: ReviewState;
  states: Record<ReviewState, ReviewStateRecord>;
  transition_log: Array<{
    state: ReviewState;
    status: ReviewStatus;
    changed_at: string;
    note?: string;
  }>;
  updated_at: string;
}

export function reviewLoopPath(runId: string, root: string): string {
  return `${getRunDir(runId, root)}/review-loop.json`;
}

export function defaultReviewLoop(runId: string): ReviewLoop {
  return {
    run_id: runId,
    current_state: "explain",
    states: {
      explain: {
        status: "not-started",
        code_mutation_allowed: false,
        approval_required: false,
      },
      fix: {
        status: "not-started",
        code_mutation_allowed: true,
        approval_required: true,
      },
      ship: {
        status: "not-started",
        code_mutation_allowed: false,
        approval_required: true,
      },
    },
    transition_log: [],
    updated_at: new Date().toISOString(),
  };
}

function assertExplainComplete(reviewLoop: ReviewLoop, state: ReviewState): void {
  if (reviewLoop.states.explain.status !== "completed") {
    throw badInput(`${state} state requires explain to be completed first`);
  }
}

export function assertReviewTransition(
  reviewLoop: ReviewLoop,
  state: ReviewState,
  status: ReviewStatus,
): void {
  if (["fix", "ship"].includes(state)) assertExplainComplete(reviewLoop, state);
  if (
    state === "ship" &&
    !["not-started", "completed", "approved"].includes(reviewLoop.states.fix.status)
  ) {
    throw badInput("ship state requires fix to be completed, approved, or not-started");
  }
  if (state === "explain" && ["pending-approval", "approved"].includes(status)) {
    throw badInput("explain state does not support approval statuses");
  }
}
