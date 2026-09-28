/** Invokes the private runner CLI without creating a phase-execution import cycle. */
import { resolve } from "node:path";
import { engineRuntimeRoot } from "../primitives/installation-paths.mjs";
import { runProcess } from "./autonomous-git.mjs";

export function runnerEntrypoint() {
  return resolve(import.meta.dirname, "../cli/runner.mjs");
}

export function invokeRunner(workspaceRoot, args, allowFailure = false) {
  return runProcess(process.execPath, [runnerEntrypoint(), ...args, "--project-root", workspaceRoot], {
    cwd: engineRuntimeRoot,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    allowFailure,
    label: `pipeline runner ${args[0]}`,
  });
}
