/** Bridges the operator HTTP surface to the pipeline-owned workflow registry. */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const registryPath = resolve(
  import.meta.dirname,
  "../../scripts/pipeline/lib/workflow-registry.mjs",
);
const workflowDesignerPath = resolve(
  import.meta.dirname,
  "../../scripts/pipeline/lib/workflow-designer.mjs",
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

/** Returns pipeline-owned static workflow analysis when that optional export exists. */
export async function analyzeWorkflowFor(workflow) {
  if (!existsSync(workflowDesignerPath))
    return { available: false, reason: "workflow analysis is unavailable" };
  const module = await import(pathToFileURL(workflowDesignerPath).href);
  if (typeof module.analyzeWorkflow !== "function") {
    return { available: false, reason: "workflow analysis is unavailable" };
  }
  return { available: true, analysis: await module.analyzeWorkflow(workflow) };
}

/** Lists the pipeline-owned v2.1 guided templates. */
export async function workflowTemplates() {
  if (!existsSync(workflowDesignerPath)) unavailable();
  const module = await import(pathToFileURL(workflowDesignerPath).href);
  if (typeof module.listWorkflowTemplates !== "function") unavailable();
  return module.listWorkflowTemplates();
}

/** Compiles a guided template to the unchanged workflow v2.1 contract. */
export async function compileWorkflowTemplateFor(templateId, options) {
  if (!existsSync(workflowDesignerPath)) unavailable();
  const module = await import(pathToFileURL(workflowDesignerPath).href);
  if (typeof module.compileWorkflowTemplate !== "function") unavailable();
  return module.compileWorkflowTemplate(templateId, options);
}
