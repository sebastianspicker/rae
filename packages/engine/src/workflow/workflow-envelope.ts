/** Validates immutable workflow envelopes before persistence and resume reconstruction. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type {
  WorkflowsNodeEnvelopeV2,
  WorkflowsNodeEnvelopeV21,
  WorkflowsNodeEnvelopeV22,
} from "@rae/contracts";
import { contractsRoot } from "../primitives/installation-paths.js";

export type WorkflowNodeEnvelope =
  | WorkflowsNodeEnvelopeV2
  | WorkflowsNodeEnvelopeV21
  | WorkflowsNodeEnvelopeV22;

const validators = new Map<string, ValidateFunction>(
  [
    ["2.0.0", "node-envelope-v2.schema.json"],
    ["2.1.0", "node-envelope-v2.1.schema.json"],
    ["2.2.0", "node-envelope-v2.2.schema.json"],
  ].map(([version, name]) => {
    const schema = JSON.parse(readFileSync(resolve(contractsRoot, "workflows", name), "utf8"));
    return [version, new Ajv2020({ allErrors: true, strict: true }).compile(schema)];
  }),
);

export function validateNodeEnvelope(value: unknown): WorkflowNodeEnvelope {
  const envelope: unknown = structuredClone(value);
  const schemaVersion =
    envelope && typeof envelope === "object" && "schema_version" in envelope
      ? String(envelope.schema_version)
      : undefined;
  const validate = schemaVersion ? validators.get(schemaVersion) : undefined;
  if (!validate) throw new Error(`unsupported workflow envelope ${schemaVersion}`);
  if (!validate(envelope)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid workflow envelope: ${detail}`);
  }
  return envelope as WorkflowNodeEnvelope;
}
