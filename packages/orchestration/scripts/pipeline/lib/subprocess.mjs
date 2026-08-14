/**
 * Shared subprocess spawner for pipeline skill tools.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getPackageRoot, getWorkspaceRoot } from "./state.mjs";
import { toolError } from "./errors.mjs";
/**
 * Provides subprocess support for the orchestration toolchain.
 */

/**
 * Report whether this runtime can prove that skill subprocesses are actually
 * sandboxed. Docker manifests alone do not constrain the direct Node launches
 * used below, so this remains fail-closed until an execution adapter exists.
 */
export function sandboxEnforcementReport() {
  return {
    enforced: false,
    reason:
      "pipeline skill tools currently run as direct Node subprocesses; declared sandbox manifests are not runtime-enforced",
  };
}

function prepareSkillToolLaunch({ entrypoint, input, root, toolName, timeoutMs }) {
  const toolRoot = getPackageRoot();
  const resolvedEntry = resolve(toolRoot, entrypoint);
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
        RAE_TOOL_ROOT: toolRoot,
      },
    },
  };
}

function throwProcessFailure(proc, toolName, timeoutMs) {
  if (proc.error) {
    const isTimeout = proc.error.code === "ETIMEDOUT";
    const msg = isTimeout
      ? `${toolName} timed out after ${timeoutMs}ms`
      : `${toolName} failed to spawn: ${proc.error.message}`;
    throw toolError(toolName, isTimeout ? "TIMEOUT" : "SPAWN", msg);
  }

  if (proc.signal) {
    throw toolError(toolName, "SIGNAL", `${toolName} killed by signal ${proc.signal}`);
  }
}

function parseToolOutput(proc, toolName) {
  const rawOut = proc.stdout?.trim() ? proc.stdout : proc.stderr?.trim() ? proc.stderr : "";
  if (!rawOut) {
    throw toolError(toolName, "EMPTY", `${toolName} returned empty output`);
  }

  try {
    return { rawOut, parsed: JSON.parse(rawOut) };
  } catch (error) {
    throw toolError(toolName, "PARSE", `${toolName} returned invalid JSON: ${String(error)}`);
  }
}

function throwFailedEnvelope(proc, parsed, rawOut, toolName) {
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
export function spawnSkillTool({
  entrypoint,
  input,
  root = getPackageRoot(),
  toolName,
  timeoutMs = 30_000,
}) {
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

  return parsed.data;
}
