import type { Input, TraceResult } from "./types.js";
import { validateInput } from "./lib/input.js";
import { collectTrace } from "./lib/trace.js";
import { runTool } from "@coding-agents-space/shared";

const TOOL_VERSION = "0.1.0";

runTool<Input, TraceResult>(TOOL_VERSION, async (input: Input, logs: string[]) => {
  validateInput(input);
  const data = await collectTrace(input, logs, {
    workspaceRoot: process.env.WORKSPACE_ROOT ?? "/workspace",
  });
  return { data, logs };
});
