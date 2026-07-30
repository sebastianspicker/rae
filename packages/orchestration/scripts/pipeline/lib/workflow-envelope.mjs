/** Validates immutable workflow envelopes before persistence and resume reconstruction. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const validators = new Map(
  [
    ["2.0.0", "node-envelope-v2.schema.json"],
    ["2.1.0", "node-envelope-v2.1.schema.json"],
  ].map(([version, name]) => {
    const schema = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, "contracts/workflows", name), "utf8"),
    );
    return [version, new Ajv2020({ allErrors: true, strict: true }).compile(schema)];
  }),
);

export function validateNodeEnvelope(value) {
  const envelope = structuredClone(value);
  const validate = validators.get(envelope?.schema_version);
  if (!validate) throw new Error(`unsupported workflow envelope ${envelope?.schema_version}`);
  if (!validate(envelope)) {
    const detail = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid workflow envelope: ${detail}`);
  }
  return envelope;
}
