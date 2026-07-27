/**
 * Validates evaluation tasksets against their JSON Schema before a matrix run consumes them.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const MAX_TASKSET_BYTES = 1_000_000;

function formatErrors(errors = []) {
  return errors
    .map((entry) => {
      const path = entry.instancePath && entry.instancePath.length > 0 ? entry.instancePath : "/";
      return `${path} ${entry.message ?? "invalid"}`;
    })
    .sort();
}

export function validateTasksetSchema({ root, tasksetPath, taskset }) {
  const schemaPath = resolve(root, "contracts/eval-taskset.schema.json");
  if (!existsSync(schemaPath)) {
    const err = new Error("Taskset schema not found: contracts/eval-taskset.schema.json");
    err.code = "E_TASKSET_SCHEMA_MISSING";
    throw err;
  }

  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const tasksetBytes = Buffer.byteLength(JSON.stringify(taskset), "utf8");
  if (tasksetBytes > MAX_TASKSET_BYTES) {
    const err = new Error(`Taskset exceeds ${MAX_TASKSET_BYTES} byte validation limit`);
    err.code = "E_TASKSET_TOO_LARGE";
    throw err;
  }
  // Fixed repository schema and bounded taskset preserve complete diagnostics.
  // nosemgrep: javascript.ajv.security.audit.ajv-allerrors-true.ajv-allerrors-true
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateSchema: false,
  });
  addFormats(ajv, ["date-time", "uri"]);

  const validate = ajv.compile(schema);
  const valid = validate(taskset);
  if (valid) return;

  const details = formatErrors(validate.errors);
  const message = [
    `Taskset schema validation failed for ${tasksetPath}:`,
    ...details.map((line) => `- ${line}`),
  ].join("\n");

  const err = new Error(message);
  err.code = "E_TASKSET_SCHEMA_INVALID";
  throw err;
}
