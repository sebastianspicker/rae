/** Validate untrusted input against immutable contracts before assigning domain types. */
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import type { ContractTypes } from "./generated.js";
export type * from "./generated.js";
export { schemaDigests } from "./generated.js";

const require = createRequire(import.meta.url);
const validators = new Map<keyof ContractTypes, ValidateFunction>();
export function parseContract<K extends keyof ContractTypes>(
  name: K,
  value: unknown,
): ContractTypes[K] {
  let validate = validators.get(name);
  if (!validate) {
    const path = require.resolve(`@rae/contracts/v1/${name}`);
    const document = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const options = { allErrors: true, strict: false };
    const ajv = String(document.$schema).includes("2020-12")
      ? new Ajv2020(options)
      : new Ajv(options);
    // Install the package's existing format implementation without ESM interop assumptions.
    const addFormats = require("ajv-formats") as (instance: Ajv | Ajv2020) => void;
    addFormats(ajv);
    validate = ajv.compile(document);
    validators.set(name, validate);
  }
  if (!validate(value)) throw new Error(`Invalid ${name}: ${JSON.stringify(validate.errors)}`);
  return value as ContractTypes[K];
}
