/** Coordinates autonomous phase execution helpers and runner invocations. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonStrict } from "./state.mjs";

import { invokeRunner } from "./runner-port.mjs";
export { invokeRunner };

export function completeReviewLoop(workspaceRoot, runId) {
  const runDir = resolve(workspaceRoot, ".pipeline", "runs", runId);
  const reviewPath = resolve(runDir, "review-loop.json");
  const current = existsSync(reviewPath) ? readJsonStrict(reviewPath) : null;
  if (current?.states?.ship?.status === "pending-approval") return;
  for (const [state, status, note] of reviewTransitions()) {
    const latest = existsSync(reviewPath) ? readJsonStrict(reviewPath) : null;
    if (latest?.states?.[state]?.status === status) continue;
    invokeRunner(workspaceRoot, [
      "record-review-state",
      "--run-id",
      runId,
      "--state",
      state,
      "--status",
      status,
      "--note",
      note,
    ]);
  }
}

function reviewTransitions() {
  return [
    ["explain", "completed", "Autonomous run evidence assembled"],
    ["fix", "completed", "Plan-owned implementation and remediation phases completed"],
    ["ship", "pending-approval", "Human review is required before commit, push, or release"],
  ];
}

export { runOnePhase } from "./phase-executor.mjs";
