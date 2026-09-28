/**
 * Shared subprocess spawner for pipeline skill tools.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPackageRoot, getWorkspaceRoot } from "./state.js";
import { toolError } from "../primitives/errors.js";
import { repositoryRoot } from "../primitives/installation-paths.js";
/**
 * Provides subprocess support for the orchestration toolchain.
 */

/**
 * Report whether this runtime can prove that skill subprocesses are actually
 * sandboxed. Docker manifests alone do not constrain the direct Node launches
 * used below, so this remains fail-closed until an execution adapter exists.
 */
export function sandboxEnforcementReport(): { enforced: false; reason: string } {
  return {
    enforced: false,
    reason:
      "pipeline skill tools currently run as direct Node subprocesses; declared sandbox manifests are not runtime-enforced",
  };
}

interface SkillToolOptions {
  entrypoint: string;
  input: unknown;
  root?: string;
  toolName: string;
  timeoutMs?: number;
}

interface ToolEnvelope {
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

function prepareSkillToolLaunch({
  entrypoint,
  input,
  root,
  toolName,
  timeoutMs,
}: Required<SkillToolOptions>): {
  resolvedEntry: string;
  spawnOptions: SpawnSyncOptionsWithStringEncoding;
} {
  const toolRoot = getPackageRoot();
  const resolvedEntry = entrypoint.startsWith(".")
    ? resolve(toolRoot, entrypoint)
    : fileURLToPath(import.meta.resolve(entrypoint));
  if (!existsSync(resolvedEntry)) {
    throw toolError(
      toolName,
      "MISSING",
      `${toolName} dist entrypoint missing. Run npm run build in ${entrypoint.replace("/dist/index.js", "")}.`,
    );
  }

  return {
    resolvedEntry,
    spawnOptions: {
      cwd: toolRoot,
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: timeoutMs,
      env: {
        ...process.env,
        WORKSPACE_ROOT: resolve(root || getWorkspaceRoot()),
        RAE_TOOL_ROOT: repositoryRoot,
      },
    },
  };
}

function throwProcessFailure(
  proc: SpawnSyncReturns<string>,
  toolName: string,
  timeoutMs: number,
): void {
  if (proc.error) {
    const isTimeout = "code" in proc.error && proc.error.code === "ETIMEDOUT";
    const msg = isTimeout
      ? `${toolName} timed out after ${timeoutMs}ms`
      : `${toolName} failed to spawn: ${proc.error.message}`;
    throw toolError(toolName, isTimeout ? "TIMEOUT" : "SPAWN", msg);
  }

  if (proc.signal) {
    throw toolError(toolName, "SIGNAL", `${toolName} killed by signal ${proc.signal}`);
  }
}

function parseToolOutput(
  proc: SpawnSyncReturns<string>,
  toolName: string,
): { rawOut: string; parsed: ToolEnvelope } {
  const rawOut = proc.stdout?.trim() ? proc.stdout : proc.stderr?.trim() ? proc.stderr : "";
  if (!rawOut) {
    throw toolError(toolName, "EMPTY", `${toolName} returned empty output`);
  }

  try {
    const parsed: unknown = JSON.parse(rawOut);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tool output must be a JSON object");
    }
    return { rawOut, parsed: parsed as ToolEnvelope };
  } catch (error) {
    throw toolError(toolName, "PARSE", `${toolName} returned invalid JSON: ${String(error)}`);
  }
}

function throwFailedEnvelope(
  proc: SpawnSyncReturns<string>,
  parsed: ToolEnvelope,
  rawOut: string,
  toolName: string,
): void {
  if (proc.status !== 0 || !parsed.success) {
    const msg = parsed?.error?.message || rawOut;
    const failErr = toolError(toolName, "FAILED", `${toolName} failed: ${msg}`);
    const originalCode = failErr.code;
    if (parsed?.error?.code) {
      failErr.code = parsed.error.code;
      failErr.outerCode = originalCode;
    }
    throw failErr;
  }
}

/**
 * Spawn a skill tool as a subprocess and parse its JSON output.
 *
 * @param {object} opts
 * @param {string} opts.entrypoint  Repo-relative path to the dist/index.js
 * @param {object} opts.input       JSON payload piped to stdin
 * @param {string} [opts.root]      Target workspace root exposed to the tool
 * @param {string} opts.toolName    Human-readable tool name for error messages
 * @param {number} [opts.timeoutMs] Subprocess timeout in ms (default 30000)
 * @returns {object} Parsed `data` from the tool's JSON envelope
 */
/**
 * Runs a development skill with the sandbox policy and converts process failures into stable tool errors.
 */
export function spawnSkillTool<T = unknown>({
  entrypoint,
  input,
  root = getPackageRoot(),
  toolName,
  timeoutMs = 30_000,
}: SkillToolOptions): T {
  const { resolvedEntry, spawnOptions } = prepareSkillToolLaunch({
    entrypoint,
    input,
    root,
    toolName,
    timeoutMs,
  });
  const proc = spawnSync(process.execPath, [resolvedEntry], spawnOptions);
  throwProcessFailure(proc, toolName, timeoutMs);
  const { rawOut, parsed } = parseToolOutput(proc, toolName);
  throwFailedEnvelope(proc, parsed, rawOut, toolName);

  return parsed.data as T;
}
