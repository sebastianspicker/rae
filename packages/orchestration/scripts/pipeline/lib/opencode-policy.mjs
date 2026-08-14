/** Defines OpenCode's sealed permission, MCP, and effective-config policy. */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SAFE_PERMISSION_KEYS = Object.freeze([
  "*",
  "bash",
  "doom_loop",
  "edit",
  "external_directory",
  "glob",
  "grep",
  "lsp",
  "question",
  "read",
  "skill",
  "task",
  "todowrite",
  "webfetch",
  "websearch",
  "rae-verification_verify",
]);
const MCP_SERVER_NAME = "rae-verification";
const MCP_SERVER_KEYS = Object.freeze(["command", "enabled", "type"]);
export const BROKER_PATH = resolve(import.meta.dirname, "verification-broker.mjs");

export function permissionSurface(writeAccess) {
  return Object.freeze({
    "*": "deny",
    bash: "deny",
    doom_loop: "deny",
    edit: writeAccess ? "allow" : "deny",
    external_directory: "deny",
    glob: "allow",
    grep: "allow",
    lsp: "deny",
    question: "deny",
    read: "allow",
    skill: "deny",
    task: "deny",
    todowrite: "deny",
    webfetch: "deny",
    websearch: "deny",
    "rae-verification_verify": "allow",
  });
}
export function verificationCatalog() {
  const tools = "/Library/Developer/CommandLineTools/usr/bin/git";
  return { "git-diff-check": [existsSync(tools) ? tools : "/usr/bin/git", "diff", "--check"] };
}
export function inlineConfig({ writeAccess, workspaceRoot, catalogPath, evidencePath }) {
  const permission = permissionSurface(writeAccess);
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    plugin: [],
    command: {},
    instructions: [],
    subagent_depth: 0,
    permission,
    agent: { rae: { description: "RAE contained workflow node", mode: "primary", permission } },
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "local",
        command: [
          process.execPath,
          BROKER_PATH,
          "--workspace",
          workspaceRoot,
          "--catalog",
          catalogPath,
          "--evidence",
          evidencePath,
        ],
        enabled: true,
      },
    },
  };
}
export function safeChildEnvironment(source, runtime, config, permission) {
  const output = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "NO_COLOR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ])
    if (source[key] !== undefined) output[key] = source[key];
  return {
    ...output,
    HOME: runtime.home,
    XDG_CONFIG_HOME: runtime.config,
    XDG_CACHE_HOME: runtime.cache,
    XDG_DATA_HOME: runtime.data,
    XDG_STATE_HOME: runtime.state,
    TMPDIR: runtime.tmp,
    OPENCODE_CONFIG_DIR: runtime.opencodeConfig,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_PERMISSION: JSON.stringify(permission),
    OPENCODE_AUTO_SHARE: "false",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  };
}
export function assertEffectiveConfiguration(config, expected) {
  for (const [key, value] of Object.entries({
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    subagent_depth: 0,
  }))
    if (config[key] !== value) throw new Error(`effective OpenCode config changed ${key}`);
  if (!Array.isArray(config.plugin) || config.plugin.length)
    throw new Error("effective OpenCode plugin surface is not empty");
  if (!exactPermission(config.permission, expected.permission))
    throw new Error("effective OpenCode global permission surface is not exact");
  if (!exactPermission(config.agent?.rae?.permission, expected.permission))
    throw new Error("effective OpenCode agent permission surface is not exact");
  if (!exactMcp(config.mcp, expected.mcp))
    throw new Error("effective OpenCode MCP surface contains an unapproved server");
}
function exactPermission(value, expected) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify([...SAFE_PERMISSION_KEYS].sort()) &&
      SAFE_PERMISSION_KEYS.every((key) => value[key] === expected[key]),
  );
}
function exactMcp(value, expected) {
  const actualServer = value?.[MCP_SERVER_NAME],
    expectedServer = expected?.[MCP_SERVER_NAME];
  return Boolean(
    exactObjectKeys(value, [MCP_SERVER_NAME]) &&
      exactObjectKeys(actualServer, MCP_SERVER_KEYS) &&
      expectedServer &&
      actualServer.type === expectedServer.type &&
      actualServer.enabled === expectedServer.enabled &&
      exactVector(actualServer.command, expectedServer.command),
  );
}
function exactObjectKeys(value, expectedKeys) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort()),
  );
}
function exactVector(value, expected) {
  return Boolean(
    Array.isArray(value) &&
      Array.isArray(expected) &&
      value.length === expected.length &&
      value.every((entry, index) => entry === expected[index]),
  );
}
export function assertNoProjectExtensions(workspaceRoot) {
  for (const directory of [
    "agents",
    "agent",
    "commands",
    "command",
    "plugins",
    "plugin",
    "skills",
    "skill",
    "tools",
    "tool",
  ]) {
    const candidate = resolve(workspaceRoot, ".opencode", directory);
    if (existsSync(candidate) && readdirSync(candidate).length)
      throw new Error(`OpenCode project extension surface is not allowed: .opencode/${directory}`);
  }
}
