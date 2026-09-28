/** Derive structural types from immutable schemas; runtime validators remain authoritative. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = boolean | { [key: string]: Json };
const packageRoot = resolve(import.meta.dirname, "..");
const schemaRoot = join(packageRoot, "v1/schemas");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(join(directory, entry.name))
        : entry.name.endsWith(".schema.json")
          ? [join(directory, entry.name)]
          : [],
    )
    .sort();
}
function object(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function schema(value: Json | undefined): Schema {
  if (typeof value === "boolean") return value;
  return object(value);
}
function name(value: string): string {
  return value
    .replace(/\.schema\.json$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}
const schemaFiles = files(schemaRoot);
const documents = new Map(
  schemaFiles.map((path) => [path, JSON.parse(readFileSync(path, "utf8")) as Schema]),
);
const aliases = new Map<string, string>();
const definitions: string[] = [];
const identifiers = new Map(
  [...documents].flatMap(([path, value]) =>
    typeof value !== "boolean" && typeof value.$id === "string" ? [[value.$id, path] as const] : [],
  ),
);
function reference(ref: string, from: string): string {
  const [location, fragment = ""] = ref.split("#");
  const target = location ? (identifiers.get(location) ?? resolve(dirname(from), location)) : from;
  let node = documents.get(target);
  if (node === undefined) throw new Error(`Unresolved schema reference ${ref} in ${from}`);
  const parts = fragment
    ? fragment
        .slice(1)
        .split("/")
        .map((part) => decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~"))
    : [];
  for (const part of parts) {
    if (typeof node === "boolean" || node[part] === undefined)
      throw new Error(`Missing schema pointer ${ref}`);
    node = schema(node[part]);
  }
  return declare(target, fragment, node);
}
function declare(path: string, pointer: string, value: Schema): string {
  const key = `${path}#${pointer}`;
  const existing = aliases.get(key);
  if (existing) return existing;
  const alias = name(relative(schemaRoot, path)) + (pointer ? name(pointer) : "");
  if ([...aliases.values()].includes(alias)) throw new Error(`Duplicate type alias ${alias}`);
  aliases.set(key, alias);
  const rendered = render(value, path);
  definitions.push(`export type ${alias} = ${rendered};`);
  return alias;
}
function render(value: Schema, path: string): string {
  if (typeof value === "boolean") return value ? "JsonValue" : "never";
  if (Object.hasOwn(value, "const")) return JSON.stringify(value.const);
  if (Array.isArray(value.enum))
    return value.enum.map((item) => JSON.stringify(item)).join(" | ") || "never";
  const constraints: string[] = [];
  if (typeof value.$ref === "string") constraints.push(reference(value.$ref, path));
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(value[key]))
      constraints.push(
        `(${value[key].map((item) => `(${render(schema(item), path)})`).join(key === "allOf" ? " & " : " | ")})`,
      );
  }
  if (Array.isArray(value.type))
    constraints.push(
      value.type
        .map((type) =>
          render({ ...value, type, allOf: [], anyOf: [], oneOf: [], $ref: null }, path),
        )
        .join(" | "),
    );
  else
    switch (value.type) {
      case "null":
        constraints.push("null");
        break;
      case "boolean":
        constraints.push("boolean");
        break;
      case "integer":
      case "number":
        constraints.push("number");
        break;
      case "string":
        constraints.push("string");
        break;
      case "array":
        constraints.push(`Array<${render(schema(value.items), path)}>`);
        break;
      case "object": {
        const required = new Set(Array.isArray(value.required) ? value.required : []);
        const properties = Object.entries(object(value.properties)).map(
          ([key, child]) =>
            `${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${render(schema(child), path)}`,
        );
        // Index signatures use unknown when declared properties have different
        // types. Ajv enforces additionalProperties and patternProperties at runtime.
        if (value.additionalProperties !== false) properties.push("[key: string]: unknown");
        constraints.push(
          properties.length ? `{ ${properties.join("; ")} }` : "Record<string, never>",
        );
        break;
      }
    }
  return constraints.filter((item) => item !== "()").join(" & ") || "JsonValue";
}
for (const [path, value] of documents) declare(path, "", value);
const mapping = schemaFiles
  .map((path) => `${JSON.stringify(relative(schemaRoot, path))}: ${aliases.get(`${path}#`)}`)
  .join(";\n  ");
const hashes = Object.fromEntries(
  schemaFiles.map((path) => [
    relative(schemaRoot, path),
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]),
);
const output = `/** Generated by scripts/generate-types.ts. Do not edit. */\nexport type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };\n\n${definitions.join("\n\n")}\n\nexport interface ContractTypes {\n  ${mapping};\n}\nexport const schemaDigests = ${JSON.stringify(hashes, null, 2)} as const;\n`;
const target = join(packageRoot, "src/generated.ts");
const formatted = execFileSync(
  resolve(packageRoot, "../../node_modules/.bin/biome"),
  ["format", `--stdin-file-path=${target}`],
  { input: output, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== formatted)
    throw new Error("Contract types are stale; run generate:types");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, formatted);
}
