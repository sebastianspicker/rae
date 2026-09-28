/** Coordinates autonomous phase execution helpers and runner invocations. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonStrict } from "./state.js";

import { invokeRunner } from "./runner-port.js";
export { invokeRunner };

function reviewState(value: Record<string, unknown> | null, state: string): string | undefined {
  const states = value?.states;
  if (!states || typeof states !== "object" || Array.isArray(states)) return undefined;
  const entry = (states as Record<string, unknown>)[state];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? String((entry as Record<string, unknown>).status ?? "")
    : undefined;
}

export function completeReviewLoop(workspaceRoot: string, runId: string): void {
  const runDir = resolve(workspaceRoot, ".pipeline", "runs", runId);
  const reviewPath = resolve(runDir, "review-loop.json");
  const current = existsSync(reviewPath) ? readJsonStrict(reviewPath) : null;
  if (reviewState(current, "ship") === "pending-approval") return;
  for (const [state, status, note] of reviewTransitions()) {
    const latest = existsSync(reviewPath) ? readJsonStrict(reviewPath) : null;
    if (reviewState(latest, state) === status) continue;
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

function reviewTransitions(): Array<[state: string, status: string, note: string]> {
  return [
    ["explain", "completed", "Autonomous run evidence assembled"],
    ["fix", "completed", "Plan-owned implementation and remediation phases completed"],
    ["ship", "pending-approval", "Human review is required before commit, push, or release"],
  ];
}

export { runOnePhase } from "./phase-executor.js";
