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

export function assertReviewTransition(reviewLoop, state, status) {
  if (state === "fix" && reviewLoop.states.explain.status !== "completed") {
    throw badInput("fix state requires explain to be completed first");
  }
  if (state === "ship" && reviewLoop.states.explain.status !== "completed") {
    throw badInput("ship state requires explain to be completed first");
  }
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
