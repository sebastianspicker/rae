import type { DriftData, Input, ReviewData } from "./types.js";
import { runDriftDetect, runReview } from "./lib/engine.js";
import { validateInput } from "./lib/input.js";
import { runTool } from "@coding-agents-space/shared";

const TOOL_VERSION = "0.2.0";

runTool<Input, ReviewData | DriftData>(TOOL_VERSION, async (input: Input, logs: string[]) => {
  validateInput(input);
  let data: ReviewData | DriftData;
  if (input.action.type === "review") {
    data = runReview(input, logs);
  } else {
    data = runDriftDetect(input, logs, {
      workspaceRoot: process.env.WORKSPACE_ROOT ?? "/workspace",
    });
  }
  return { data, logs };
});
