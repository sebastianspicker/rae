import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import type { RunResult } from "./types.js";

export function readStdin(): string {
  return readFileSync(0, "utf8");
}

export function getErrorDetails(stack?: string): string | undefined {
  return process.env.DEBUG_ERROR_DETAILS === "1" ? stack : undefined;
}

export interface ToolHandlerResult<TData> {
  data: TData;
  logs: string[];
}

export async function runTool<TInput, TData>(
  toolVersion: string,
  handler: (
    input: TInput,
    logs: string[],
  ) => Promise<ToolHandlerResult<TData>> | ToolHandlerResult<TData>,
): Promise<void> {
  const t0 = performance.now();
  let logs: string[] = [];

  try {
    const raw = readStdin();
    if (!raw || !raw.trim()) {
      throw Object.assign(new Error("Empty input: expected JSON on stdin"), {
        code: "E_BAD_INPUT",
      });
    }

    const input = JSON.parse(raw) as TInput;
    const evaluated = await handler(input, logs);
    logs = evaluated.logs;

    const result: RunResult<TData> = {
      success: true,
      data: evaluated.data,
      metadata: {
        tool_version: toolVersion,
        execution_time_ms: Math.round(performance.now() - t0),
      },
      logs,
    };

    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    const error = err as { code?: string; message?: string; stack?: string };
    const result: RunResult<TData> = {
      success: false,
      error: {
        code: error.code ?? "E_UNKNOWN",
        message: error.message ?? "Unknown error",
        details: getErrorDetails(error.stack),
      },
      metadata: {
        tool_version: toolVersion,
        execution_time_ms: Math.round(performance.now() - t0),
      },
      logs,
    };
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}
