/** Builds and verifies the exact per-attempt Codex capability surface. */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);

const MAX_PROJECT_CONFIG_BYTES = 64 * 1024;
const FORBIDDEN_CAPABILITY_KEYS = [
  "agents",
  "apps",
  "hooks",
  "permissions",
  "plugins",
  "skills",
  "tools",
];
const FORBIDDEN_PROJECT_SURFACES = [
  ".agents/skills",
  ".codex/skills",
  ".codex/plugins",
  ".codex/hooks.json",
  ".codex/rules",
];

function readProjectConfig(workspaceRoot) {
  const pathValue = resolve(workspaceRoot, ".codex", "config.toml");
  if (!existsSync(pathValue)) return { path: pathValue, config: {} };
  const stat = lstatSync(pathValue);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("project Codex config must be a regular non-symlink file");
  }
  if (stat.size > MAX_PROJECT_CONFIG_BYTES) {
    throw new Error(`project Codex config exceeds ${MAX_PROJECT_CONFIG_BYTES} bytes`);
  }
  try {
    const { parse } = require("smol-toml");
    return { path: pathValue, config: parse(readFileSync(pathValue, "utf8")) };
  } catch (error) {
    throw new Error(`project Codex config is invalid TOML: ${error.message}`);
  }
}

function assertNoUndeclaredProjectSurfaces(workspaceRoot) {
  for (const relativePath of FORBIDDEN_PROJECT_SURFACES) {
    const absolute = resolve(workspaceRoot, relativePath);
    if (!existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    const populated = stat.isDirectory() ? readdirSync(absolute).length > 0 : stat.isFile();
    if (populated) {
      throw new Error(`project Codex capability surface ${relativePath} is not allowed`);
    }
  }
}

function sameStrings(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function assertConfiguredMcpServers(configured = {}, capabilitySet) {
  const allowed = new Map(capabilitySet.mcp_servers.map((server) => [server.name, server]));
  for (const [name, serverConfig] of Object.entries(configured)) {
    const expected = allowed.get(name);
    if (!expected) throw new Error(`project Codex config declares undeclared MCP server ${name}`);
    const allowedKeys = new Set([
      "url",
      "bearer_token_env_var",
      "enabled_tools",
      "disabled_tools",
      "enabled",
      "required",
    ]);
    const extras = Object.keys(serverConfig).filter((key) => !allowedKeys.has(key));
    if (extras.length) {
      throw new Error(
        `project Codex MCP server ${name} has undeclared settings: ${extras.join(", ")}`,
      );
    }
    if (
      serverConfig.url !== expected.url ||
      serverConfig.bearer_token_env_var !== expected.token_env_var ||
      !sameStrings(serverConfig.enabled_tools, expected.enabled_tools) ||
      (serverConfig.disabled_tools && serverConfig.disabled_tools.length > 0) ||
      serverConfig.enabled === false ||
      serverConfig.required === false
    ) {
      throw new Error(`project Codex MCP server ${name} does not match the operator profile`);
    }
  }
}

/** Rejects project-owned capabilities that could widen the snapshotted operator profile. */
export function assertProjectCodexCapabilities(workspaceRoot, capabilitySet) {
  if (!capabilitySet) return { config_path: null, configured_servers: [] };
  assertNoUndeclaredProjectSurfaces(workspaceRoot);
  const { path, config } = readProjectConfig(workspaceRoot);
  for (const key of FORBIDDEN_CAPABILITY_KEYS) {
    if (config[key] !== undefined) {
      throw new Error(
        `project Codex config setting ${key} is not represented by the operator profile`,
      );
    }
  }
  if (config.features && Object.values(config.features).some((value) => value !== false)) {
    throw new Error("project Codex feature flags may not enable capability-bearing features");
  }
  if (config.web_search !== undefined && config.web_search !== "disabled") {
    throw new Error("project Codex config may not enable web search");
  }
  assertConfiguredMcpServers(config.mcp_servers, capabilitySet);
  return {
    config_path: existsSync(path) ? path : null,
    configured_servers: Object.keys(config.mcp_servers ?? {}).sort(),
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

/** Returns configuration overrides that disable ambient capabilities and declare exact HTTP MCP tools. */
export function codexCapabilityOverrides(capabilitySet) {
  if (!capabilitySet) return [];
  const args = [
    "-c",
    'web_search="disabled"',
    "-c",
    "features.apps=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.hooks=false",
    "-c",
    "agents.enabled=false",
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
  ];
  for (const credentialName of [...capabilitySet.credential_env_vars].sort()) {
    args.push("-c", `shell_environment_policy.filters.${credentialName}="exclude"`);
  }
  for (const server of [...capabilitySet.mcp_servers].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const prefix = `mcp_servers.${server.name}`;
    args.push(
      "-c",
      `${prefix}.url=${tomlString(server.url)}`,
      "-c",
      `${prefix}.bearer_token_env_var=${tomlString(server.token_env_var)}`,
      "-c",
      `${prefix}.enabled_tools=${JSON.stringify(server.enabled_tools)}`,
      "-c",
      `${prefix}.disabled_tools=[]`,
      "-c",
      `${prefix}.required=true`,
      "-c",
      `${prefix}.enabled=true`,
    );
  }
  return args;
}

/** Returns the complete fail-closed capability flags for one `codex exec` invocation. */
export function codexCapabilityArgs(capabilitySet) {
  if (!capabilitySet) return [];
  return [
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...codexCapabilityOverrides(capabilitySet),
  ];
}

/** Returns the declared credential names and exact effective server/tool surface. */
export function capabilitySurface(capabilitySet) {
  if (!capabilitySet) return null;
  return {
    web_search: "disabled",
    credential_env_vars: [...capabilitySet.credential_env_vars].sort(),
    mcp_servers: [...capabilitySet.mcp_servers]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((server) => ({
        name: server.name,
        url: server.url,
        enabled_tools: [...server.enabled_tools].sort(),
        token_env_var: server.token_env_var,
      })),
    disabled_surfaces: ["apps", "hooks", "plugins", "project-rules", "web-search"],
  };
}
