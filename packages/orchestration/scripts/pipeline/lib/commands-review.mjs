/**
 * Maintains the persisted review-loop state machine used by pipeline review commands.
 */
import { getRunDir } from "./state.mjs";
import { badInput } from "./errors.mjs";

export function reviewLoopPath(runId, root) {
  return `${getRunDir(runId, root)}/review-loop.json`;
}

export function defaultReviewLoop(runId) {
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

function assertExplainComplete(reviewLoop, state) {
  if (reviewLoop.states.explain.status !== "completed") {
    throw badInput(`${state} state requires explain to be completed first`);
  }
}

export function assertReviewTransition(reviewLoop, state, status) {
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
