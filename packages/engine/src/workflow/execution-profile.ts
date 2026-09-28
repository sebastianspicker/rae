/** Validates and snapshots operator-owned mappings from logical workflow tiers to Codex settings. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type {
  WorkflowsExecutionProfileV1,
  WorkflowsExecutionProfileV2,
  WorkflowsExecutionProfileV3,
  WorkflowsWorkflowV2,
  WorkflowsWorkflowV21,
  WorkflowsWorkflowV22,
} from "@rae/contracts";
import { canonicalJson } from "./workflow-contract.js";
import { contractsRoot } from "../primitives/installation-paths.js";

const SCHEMA_PATHS = new Map([
  ["1.0.0", resolve(contractsRoot, "workflows/execution-profile-v1.schema.json")],
  ["2.0.0", resolve(contractsRoot, "workflows/execution-profile-v2.schema.json")],
  ["3.0.0", resolve(contractsRoot, "workflows/execution-profile-v3.schema.json")],
]);
const MAX_PROFILE_BYTES = 64 * 1024;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (instance: Ajv2020) => void;
addFormats(ajv);
interface CapabilityServer {
  name: string;
  transport: "streamable-http";
  url: string;
  enabled_tools: string[];
  token_env_var: string;
}

export interface CapabilitySet {
  web_search: "disabled";
  mcp_servers: CapabilityServer[];
  credential_env_vars: string[];
}

interface CodexRoute {
  executor: "codex";
  model: string;
  reasoning_effort: "low" | "medium" | "high" | "xhigh";
}

interface OpenCodeRoute {
  executor: "opencode";
  model: string;
  variant?: string;
}

type ExecutionRoute = CodexRoute | OpenCodeRoute;
export type ExecutionProfileExecutor = ExecutionRoute["executor"];
export type ResolvedWorkflowRoute = Readonly<
  ExecutionRoute & {
    node_id: string;
    tier: LogicalTier;
    route_id: string;
  }
>;
type ExecutionProfileV2 = Omit<
  WorkflowsExecutionProfileV2,
  "capability_sets" | "node_capability_sets"
> & {
  capability_sets: Record<string, CapabilitySet>;
  node_capability_sets: Record<string, string>;
};
type ExecutionProfileV3 = Omit<WorkflowsExecutionProfileV3, "routes" | "node_routes"> & {
  routes: Record<string, ExecutionRoute>;
  node_routes?: Record<string, string>;
};
export type ExecutionProfile =
  | WorkflowsExecutionProfileV1
  | ExecutionProfileV2
  | ExecutionProfileV3;
type WorkflowContract = WorkflowsWorkflowV2 | WorkflowsWorkflowV21 | WorkflowsWorkflowV22;
type LogicalTier = keyof WorkflowsExecutionProfileV1["tiers"];

const validators = new Map<string, ValidateFunction>(
  [...SCHEMA_PATHS].map(([version, pathValue]) => [
    version,
    ajv.compile(JSON.parse(readFileSync(pathValue, "utf8"))),
  ]),
);

export function executionProfileDigest(profile: ExecutionProfile): string {
  return createHash("sha256").update(canonicalJson(profile)).digest("hex");
}

function schemaVersion(value: unknown): string | undefined {
  return value && typeof value === "object" && "schema_version" in value
    ? String(value.schema_version)
    : undefined;
}

export function validateExecutionProfile(value: unknown): ExecutionProfile {
  const profile: unknown = structuredClone(value);
  const version = schemaVersion(profile);
  const validator = version ? validators.get(version) : undefined;
  if (!validator) {
    throw new Error(
      `invalid execution profile: unsupported schema_version ${version ?? "missing"}`,
    );
  }
  if (!validator(profile)) {
    const detail = (validator.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`invalid execution profile: ${detail}`);
  }
  const typedProfile = profile as ExecutionProfile;
  if (typedProfile.schema_version === "2.0.0") validateCapabilityReferences(typedProfile);
  if (typedProfile.schema_version === "3.0.0") validateRouteReferences(typedProfile);
  return typedProfile;
}

function validateRouteReferences(profile: ExecutionProfileV3): void {
  for (const [tier, routeId] of Object.entries(profile.tiers)) {
    if (!profile.routes[routeId]) {
      throw new Error(
        `invalid execution profile: tier ${tier} references undefined route ${routeId}`,
      );
    }
  }
  for (const [nodeId, routeId] of Object.entries(profile.node_routes ?? {})) {
    if (!profile.routes[routeId]) {
      throw new Error(
        `invalid execution profile: node ${nodeId} references undefined route ${routeId}`,
      );
    }
  }
}

function validateCapabilityReferences(profile: ExecutionProfileV2): void {
  if (!profile.capability_sets[profile.default_capability_set]) {
    throw new Error("invalid execution profile: default_capability_set is not defined");
  }
  for (const [nodeId, capabilitySetName] of Object.entries(profile.node_capability_sets)) {
    if (!profile.capability_sets[capabilitySetName]) {
      throw new Error(
        `invalid execution profile: node ${nodeId} references undefined capability set ${capabilitySetName}`,
      );
    }
  }
  for (const [setName, capabilitySet] of Object.entries(profile.capability_sets)) {
    validateCapabilitySetServers(setName, capabilitySet);
  }
}

function validateCapabilityServer(
  server: CapabilityServer,
  setName: string,
  credentialEnvVars: readonly string[],
  serverNames: Set<string>,
): void {
  const parsed = new URL(server.url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== server.url
  ) {
    throw new Error(
      `invalid execution profile: MCP server ${server.name} in ${setName} must use an exact credential-free HTTPS URL without a query or fragment`,
    );
  }
  if (serverNames.has(server.name)) {
    throw new Error(`invalid execution profile: duplicate MCP server ${server.name} in ${setName}`);
  }
  serverNames.add(server.name);
  if (!credentialEnvVars.includes(server.token_env_var)) {
    throw new Error(
      `invalid execution profile: MCP token variable ${server.token_env_var} is not declared by capability set ${setName}`,
    );
  }
}

function validateCapabilitySetServers(setName: string, capabilitySet: CapabilitySet): void {
  const serverNames = new Set<string>();
  for (const server of capabilitySet.mcp_servers) {
    validateCapabilityServer(server, setName, capabilitySet.credential_env_vars, serverNames);
  }
}

export function loadExecutionProfile(pathValue: string): Readonly<{
  profile: ExecutionProfile;
  digest: string;
  source: string;
}> {
  const supplied = resolve(pathValue);
  const stat = lstatSync(supplied);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("execution profile path must be a regular non-symlink file");
  if (stat.size > MAX_PROFILE_BYTES)
    throw new Error(`execution profile exceeds ${MAX_PROFILE_BYTES} bytes`);
  if (realpathSync(supplied) !== supplied)
    throw new Error("execution profile path must not traverse symlinks");
  const profile = validateExecutionProfile(JSON.parse(readFileSync(supplied, "utf8")));
  return Object.freeze({ profile, digest: executionProfileDigest(profile), source: supplied });
}

export function resolveExecutionTier(
  profile: ExecutionProfile | null | undefined,
  tier: LogicalTier = "standard",
  nodeId: string | null = null,
): Readonly<Record<string, unknown>> {
  if (!profile) return { tier: "runtime", model: null, reasoning_effort: null };
  if (profile.schema_version === "3.0.0") {
    const routeId = (nodeId && profile.node_routes?.[nodeId]) ?? profile.tiers[tier];
    const route = profile.routes[routeId];
    if (!route) throw new Error(`execution profile does not define route ${routeId}`);
    return Object.freeze({ tier, route_id: routeId, ...structuredClone(route) });
  }
  const mapping = profile.tiers[tier];
  if (!mapping) throw new Error(`execution profile does not define logical tier ${tier}`);
  return Object.freeze({ tier, ...mapping });
}

/** Proves that a v2 profile names exactly one capability set for every workflow node. */
export function assertExecutionProfileCoverage(
  profile: ExecutionProfile | null | undefined,
  workflow: WorkflowContract,
): void {
  if (profile?.schema_version === "3.0.0") {
    const expected = new Set(workflow.nodes.map((node) => node.id));
    const extras = Object.keys(profile.node_routes ?? {}).filter((nodeId) => !expected.has(nodeId));
    if (extras.length) {
      throw new Error(
        `execution profile node route map contains nodes outside the workflow: ${extras.sort().join(", ")}`,
      );
    }
    return;
  }
  if (profile?.schema_version !== "2.0.0") return;
  if (workflow.schema_version !== "2.2.0") {
    throw new Error("execution profile schema 2.0.0 requires workflow schema 2.2.0");
  }
  const expected = workflow.nodes.map((node) => node.id).sort();
  const actual = Object.keys(profile.node_capability_sets).sort();
  const missing = expected.filter((nodeId) => !actual.includes(nodeId));
  const extras = actual.filter((nodeId) => !expected.includes(nodeId));
  if (missing.length || extras.length) {
    throw new Error(
      `execution profile node capability map must exactly match the workflow (missing: ${missing.join(", ") || "none"}; extras: ${extras.join(", ") || "none"})`,
    );
  }
}

/** Resolves the immutable least-privilege surface for one node. */
export function resolveNodeCapabilities(
  profile: ExecutionProfile | null | undefined,
  nodeId: string,
): Readonly<CapabilitySet & { name: string }> | null {
  if (profile?.schema_version !== "2.0.0") return null;
  const setName = profile.node_capability_sets[nodeId] ?? profile.default_capability_set;
  const capabilitySet = profile.capability_sets[setName];
  if (!capabilitySet) {
    throw new Error(
      `execution profile does not define capability set ${setName} for node ${nodeId}`,
    );
  }
  return Object.freeze({ name: setName, ...structuredClone(capabilitySet) });
}

/** Resolves the immutable route selected for every provider-backed workflow node. */
export function resolveWorkflowRoutes(
  profile: ExecutionProfile | null | undefined,
  workflow: WorkflowContract,
): ResolvedWorkflowRoute[] {
  if (profile?.schema_version !== "3.0.0") return [];
  return workflow.nodes
    .filter((node) => ["agent", "map"].includes(node.kind))
    .map(
      (node) =>
        ({
          node_id: node.id,
          ...resolveExecutionTier(
            profile,
            "tier" in node ? (node.tier ?? "standard") : "standard",
            node.id,
          ),
        }) as ResolvedWorkflowRoute,
    );
}

export function executionProfileExecutors(
  profile: ExecutionProfile | null | undefined,
): ExecutionProfileExecutor[] {
  if (!profile) return [];
  if (profile.schema_version !== "3.0.0") return ["codex"];
  return [...new Set(Object.values(profile.routes).map((route) => route.executor))].sort();
}

/** Records credential provenance without persisting credential values. */
export function credentialDigestManifest(
  capabilitySet: Pick<CapabilitySet, "credential_env_vars"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Array<Readonly<{ name: string; digest: string }>> {
  if (!capabilitySet) return [];
  return capabilitySet.credential_env_vars.map((name) => {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`declared credential environment variable ${name} is missing`);
    }
    return Object.freeze({
      name,
      digest: createHash("sha256").update(`credential-env:${name}`).digest("hex"),
    });
  });
}
