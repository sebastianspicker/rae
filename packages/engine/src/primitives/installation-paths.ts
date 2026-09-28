/** Resolves immutable repository installation paths needed by the private engine. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export const engineRoot = resolve(sourceDirectory, "../../..");
export const repositoryRoot = resolve(engineRoot, "../..");
export const contractsRoot = resolve(repositoryRoot, "packages/contracts/v1/schemas");
export const workflowsRoot = resolve(repositoryRoot, "workflows");
export const engineRuntimeRoot = engineRoot;

export function pipelineInitEntrypoint(): string {
  return resolve(engineRoot, "dist/scripts/pipeline-init.js");
}

export function cliAutonomousEntrypoint(): string {
  return resolve(engineRoot, "dist/src/cli/autonomous.js");
}

export function cliGraphEntrypoint(): string {
  return resolve(engineRoot, "dist/src/cli/graph-cli.js");
}

export function cliWorkflowAgentWorkerEntrypoint(): string {
  return resolve(engineRoot, "dist/src/cli/workflow-agent-worker.js");
}

export function cliRunnerEntrypoint(): string {
  return resolve(engineRoot, "dist/src/cli/runner.js");
}
