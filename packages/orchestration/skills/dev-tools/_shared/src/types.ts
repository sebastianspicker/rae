export interface RunResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: { code: string; message: string; details?: unknown };
  metadata: { tool_version: string; execution_time_ms: number; [k: string]: unknown };
  logs: string[];
}
