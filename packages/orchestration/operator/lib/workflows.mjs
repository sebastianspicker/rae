/** Bridges the operator HTTP surface to the pipeline-owned workflow registry. */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const registryPath = resolve(
  import.meta.dirname,
  "../../scripts/pipeline/lib/workflow-registry.mjs",
);

function unavailable() {
  throw Object.assign(new Error("workflow registry is unavailable"), { status: 503 });
}

/**
 * Loads the pipeline registry lazily so the console remains usable while an
 * older checkout is upgraded. The registry module must export
 * `createWorkflowRegistry(projectRoot)`, returning `{ list, show, draft,
 * validate, diff, activate }`. Methods receive the workflow id first and
 * accept a plain JSON request object where applicable.
 */
export async function workflowRegistryFor(project) {
  if (!existsSync(registryPath))
    return Object.freeze({
      list: unavailable,
      show: unavailable,
      draft: unavailable,
      validate: unavailable,
      diff: unavailable,
      activate: unavailable,
    });
  const module = await import(pathToFileURL(registryPath).href);
  if (typeof module.createWorkflowRegistry !== "function")
    return Object.freeze({
      list: unavailable,
      show: unavailable,
      draft: unavailable,
      validate: unavailable,
      diff: unavailable,
      activate: unavailable,
    });
  return module.createWorkflowRegistry(project.root);
}

export function assertRegistryMethod(registry, name) {
  if (!registry || typeof registry[name] !== "function") unavailable();
  return registry[name].bind(registry);
}
