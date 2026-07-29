/**
 * Validates gate artifacts against workspace-contained schemas using shared AJV loading.
 */
import { readFileSync } from "node:fs";
import { createAjvInstance } from "@coding-agents-space/shared";
import type { SchemaValidationResult } from "../types.js";

/**
 * Loads and validates an artifact schema only through the shared containment-safe workspace resolver.
 */
export async function validateArtifact(
  artifact: Record<string, unknown>,
  schemaPath: string,
): Promise<SchemaValidationResult> {
  const schemaText = readSchemaText(schemaPath);
  if (schemaText instanceof Error) return { valid: false, errors: [schemaText.message] };
  const schema = parseSchema(schemaText);
  if (schema instanceof Error) return { valid: false, errors: [schema.message] };
  const ajv = await createAjvInstance();
  const validateFn = compileSchema(ajv, schema);
  if (validateFn instanceof Error) return { valid: false, errors: [validateFn.message] };
  return formatValidationResult(validateFn, artifact);
}

export function readSchemaText(schemaPath: string): string | Error {
  try {
    return readFileSync(schemaPath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`Failed to load schema: ${msg}`);
  }
}

export function parseSchema(schemaText: string): Record<string, unknown> | Error {
  try {
    return JSON.parse(schemaText) as Record<string, unknown>;
  } catch {
    return new Error("Schema file is not valid JSON");
  }
}

export function compileSchema(
  ajv: Awaited<ReturnType<typeof createAjvInstance>>,
  schema: Record<string, unknown>,
): ReturnType<typeof ajv.compile> | Error {
  try {
    return ajv.compile(schema);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`Schema compilation failed: ${msg}`);
  }
}

export function formatValidationResult(
  validateFn: {
    (artifact: Record<string, unknown>): boolean;
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  },
  artifact: Record<string, unknown>,
): SchemaValidationResult {
  const valid = validateFn(artifact);
  if (valid) return { valid: true, errors: [] };
  return { valid: false, errors: (validateFn.errors ?? []).map(formatAjvError) };
}

export function formatAjvError(error: { instancePath?: string; message?: string }): string {
  return `${error.instancePath || "/"}: ${error.message ?? "unknown error"}`;
}
