/** Bridges the operator HTTP surface to the pipeline-owned workflow registry. */
import {
  analyzeWorkflow,
  compileWorkflowTemplate,
  createWorkflowRegistry,
  listWorkflowTemplates,
} from "@rae/engine";
import type { OperatorProject } from "./security.js";

type RegistryMethod = (...args: unknown[]) => unknown;
type WorkflowRegistry = Record<string, unknown>;

function unavailable() {
  throw Object.assign(new Error("workflow registry is unavailable"), { status: 503 });
}

/**
 * Gets the engine's registry, whose methods receive the workflow id first and
 * accept a plain JSON request object where applicable.
 */
export async function workflowRegistryFor(project: OperatorProject): Promise<WorkflowRegistry> {
  return createWorkflowRegistry(project.root) as WorkflowRegistry;
}

export function assertRegistryMethod(registry: WorkflowRegistry, name: string): RegistryMethod {
  const method = registry[name];
  if (typeof method !== "function") unavailable();
  return (method as RegistryMethod).bind(registry);
}

/** Returns pipeline-owned static workflow analysis when that optional export exists. */
export async function analyzeWorkflowFor(
  workflow: unknown,
): Promise<{ available: true; analysis: unknown }> {
  return { available: true, analysis: await analyzeWorkflow(workflow) };
}

/** Lists the pipeline-owned v2.1 guided templates. */
export async function workflowTemplates(): Promise<unknown> {
  return listWorkflowTemplates() as unknown;
}

/** Compiles a guided template to the unchanged workflow v2.1 contract. */
export async function compileWorkflowTemplateFor(
  templateId: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  return compileWorkflowTemplate(templateId, options) as unknown;
}
