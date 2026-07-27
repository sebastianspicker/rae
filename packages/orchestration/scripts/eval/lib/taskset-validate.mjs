/**
 * Validates evaluation tasksets against their JSON Schema before a matrix run consumes them.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

function loadModule(name, root) {
  const candidates = [
    root,
    resolve(root, "skills/dev-tools/_shared"),
    resolve(root, "skills/dev-tools/quality-gate"),
    resolve(root, "skills/dev-tools/multi-model-review"),
    resolve(root, "skills/dev-tools/trace-collector"),
  ];

  for (const base of candidates) {
    try {
      const resolved = require.resolve(name, { paths: [base] });
      return require(resolved);
    } catch {
      // continue
    }
  }

  const err = new Error(
    `Missing dependency "${name}" for taskset schema validation. Install dependencies (for example: cd skills/dev-tools/quality-gate && npm ci).`,
  );
  err.code = "E_MISSING_DEPENDENCY";
  throw err;
}

function normalizeAjvConstructor(mod) {
  const candidate = mod?.default ?? mod;
  if (typeof candidate === "function") return candidate;
  const nested = candidate?.default ?? candidate;
  if (typeof nested === "function") return nested;
  const err = new Error("Unable to resolve Ajv constructor for taskset validation");
  err.code = "E_BAD_AJV_IMPORT";
  throw err;
}

function normalizeFormatsFn(mod) {
  const candidate = mod?.default ?? mod;
  if (typeof candidate === "function") return candidate;
  const nested = candidate?.default ?? candidate;
  if (typeof nested === "function") return nested;
  const err = new Error("Unable to resolve ajv-formats function for taskset validation");
  err.code = "E_BAD_AJV_FORMATS_IMPORT";
  throw err;
}

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
  const AjvClass = normalizeAjvConstructor(loadModule("ajv", root));
  const addFormats = normalizeFormatsFn(loadModule("ajv-formats", root));

  const ajv = new AjvClass({ allErrors: true, strict: false, validateSchema: false });
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
