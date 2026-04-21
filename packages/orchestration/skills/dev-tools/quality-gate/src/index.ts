import type { GateResult, Input } from "./types.js";
import { evaluateGate } from "./lib/engine.js";
import { runTool } from "@coding-agents-space/shared";

const TOOL_VERSION = "0.1.0";

runTool<Input, GateResult>(TOOL_VERSION, async (input: Input) => {
  const evaluated = await evaluateGate(input, {
    workspaceRoot: process.env.WORKSPACE_ROOT ?? "/workspace",
  });
  return {
    data: evaluated.data,
    logs: evaluated.logs,
  };
});
