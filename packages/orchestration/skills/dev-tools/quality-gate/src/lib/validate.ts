import { readFileSync } from "node:fs";
import { createAjvInstance } from "@coding-agents-space/shared";
import type { SchemaValidationResult } from "../types.js";

export async function validateArtifact(
  artifact: Record<string, unknown>,
  schemaPath: string,
): Promise<SchemaValidationResult> {
  let schemaText: string;
  try {
    schemaText = readFileSync(schemaPath, "utf8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [`Failed to load schema: ${msg}`] };
  }

  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    return { valid: false, errors: ["Schema file is not valid JSON"] };
  }

  const ajv = await createAjvInstance();

  let validateFn: ReturnType<typeof ajv.compile>;
  try {
    validateFn = ajv.compile(schema as Record<string, unknown>);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: [`Schema compilation failed: ${msg}`] };
  }

  const valid = validateFn(artifact);
  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors = (validateFn.errors ?? []).map((e) => {
    const path = e.instancePath || "/";
    return `${path}: ${e.message ?? "unknown error"}`;
  });

  return { valid: false, errors };
}
