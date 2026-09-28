/** Bridges the operator HTTP surface to the pipeline-owned workflow registry. */
import {
  analyzeWorkflow,
  compileWorkflowTemplate,
  createWorkflowRegistry,
  listWorkflowTemplates,
} from "@rae/engine";

function unavailable() {
  throw Object.assign(new Error("workflow registry is unavailable"), { status: 503 });
}

/**
 * Gets the engine's registry, whose methods receive the workflow id first and
 * accept a plain JSON request object where applicable.
 */
export async function workflowRegistryFor(project) {
  return createWorkflowRegistry(project.root);
}

export function assertRegistryMethod(registry, name) {
  if (!registry || typeof registry[name] !== "function") unavailable();
  return registry[name].bind(registry);
}

/** Returns pipeline-owned static workflow analysis when that optional export exists. */
export async function analyzeWorkflowFor(workflow) {
  return { available: true, analysis: await analyzeWorkflow(workflow) };
}

/** Lists the pipeline-owned v2.1 guided templates. */
export async function workflowTemplates() {
  return listWorkflowTemplates();
}

/** Compiles a guided template to the unchanged workflow v2.1 contract. */
export async function compileWorkflowTemplateFor(templateId, options) {
  return compileWorkflowTemplate(templateId, options);
}
