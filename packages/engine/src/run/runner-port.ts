/** Invokes the private runner CLI without creating a phase-execution import cycle. */
import { cliRunnerEntrypoint, engineRuntimeRoot } from "../primitives/installation-paths.js";
import { runProcess } from "./autonomous-git.js";
import type { SpawnSyncReturns } from "node:child_process";

export function runnerEntrypoint(): string {
  return cliRunnerEntrypoint();
}

export function invokeRunner(
  workspaceRoot: string,
  args: readonly string[],
  allowFailure = false,
): SpawnSyncReturns<string> {
  return runProcess(
    process.execPath,
    [runnerEntrypoint(), ...args, "--project-root", workspaceRoot],
    {
      cwd: engineRuntimeRoot,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      allowFailure,
      label: `pipeline runner ${args[0]}`,
    },
  );
}
