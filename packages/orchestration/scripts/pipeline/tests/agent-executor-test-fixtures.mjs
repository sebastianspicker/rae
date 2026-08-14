/**
 * Shared fake providers and temporary-root cleanup for agent executor tests.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempRoots = [];

export function cleanupTempRoots() {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

export function fakeCodex(authenticated) {
  const root = mkdtempSync(join(tmpdir(), "rae-codex-doctor-"));
  tempRoots.push(root);
  const executable = join(root, "codex");
  writeFileSync(
    executable,
    [
      "#!/bin/sh",
      'if [ "$1" = "exec" ]; then',
      '  printf "%s\\n" "--sandbox --output-schema --ephemeral --json --ignore-user-config --strict-config"',
      "  exit 0",
      "fi",
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      `  exit ${authenticated ? 0 : 1}`,
      "fi",
      "exit 2",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(executable, 0o755);
  return root;
}

export function fakeCodexProfileSurface({ output = "[]", status = 0, stderr = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rae-codex-profile-surface-"));
  tempRoots.push(root);
  const executable = join(root, "codex");
  const transcriptPath = join(root, "profile-probe.json");
  const sequencePath = join(root, "profile-probe-sequence.jsonl");
  writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      `const transcriptPath = ${JSON.stringify(transcriptPath)};`,
      `const sequencePath = ${JSON.stringify(sequencePath)};`,
      `const output = ${JSON.stringify(output)};`,
      `const stderr = ${JSON.stringify(stderr)};`,
      `const status = ${status};`,
      'fs.appendFileSync(sequencePath, JSON.stringify(args) + "\\n");',
      'if (args[0] === "exec" && args[1] === "--help") {',
      '  process.stdout.write("--sandbox --output-schema --ephemeral --json --ignore-user-config --strict-config\\n");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "login" && args[1] === "status") process.exit(0);',
      'if (args.includes("mcp") && args.includes("list")) {',
      "  fs.writeFileSync(",
      "    transcriptPath,",
      "    JSON.stringify({",
      "      args,",
      "      cwd: process.cwd(),",
      "      env: {",
      "        CODEX_HOME: process.env.CODEX_HOME,",
      "        RAE_MCP_TOKEN_RESEARCH: process.env.RAE_MCP_TOKEN_RESEARCH,",
      "        HTTPS_PROXY: process.env.HTTPS_PROXY,",
      "        SSL_CERT_FILE: process.env.SSL_CERT_FILE,",
      "        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,",
      "        UNDECLARED_SECRET: process.env.UNDECLARED_SECRET,",
      "      },",
      "    }),",
      "  );",
      "  if (stderr) process.stderr.write(stderr);",
      "  process.stdout.write(output);",
      "  process.exit(status);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(executable, 0o755);
  return { root, transcriptPath, sequencePath };
}

export function profileCapabilities() {
  return {
    web_search: "disabled",
    credential_env_vars: ["RAE_MCP_TOKEN_RESEARCH"],
    mcp_servers: [
      {
        name: "archive",
        url: "https://mcp.example.invalid/archive",
        enabled_tools: ["read"],
        token_env_var: "RAE_MCP_TOKEN_RESEARCH",
      },
      {
        name: "research",
        url: "https://mcp.example.invalid/rae",
        enabled_tools: ["alpha", "zeta"],
        token_env_var: "RAE_MCP_TOKEN_RESEARCH",
      },
    ],
  };
}

export function fakeCodexRuntime(events = []) {
  const root = mkdtempSync(join(tmpdir(), "rae-codex-runtime-"));
  tempRoots.push(root);
  const executable = join(root, "codex");
  writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const prompt = fs.readFileSync(0, "utf8");',
      "if (process.env.RAE_TEST_UNKNOWN_SECRET) process.exit(23);",
      'if (prompt.includes("ENV_PROBE") && process.env.OPENAI_API_KEY !== "allowed-auth") process.exit(24);',
      'if (prompt.includes("ENV_PROBE") && process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE !== "codex_cli_rs") process.exit(25);',
      'if (prompt.includes("CAPABILITY_PROBE") && !args.includes("--ignore-user-config")) process.exit(26);',
      'if (prompt.includes("CAPABILITY_PROBE") && !args.includes("--strict-config")) process.exit(27);',
      'if (prompt.includes("CAPABILITY_PROBE") && !args.includes(\'mcp_servers.research.enabled_tools=["lookup_claim"]\')) process.exit(28);',
      'if (prompt.includes("CAPABILITY_PROBE") && !args.includes(\'shell_environment_policy.filters.RAE_MCP_TOKEN_RESEARCH="exclude"\')) process.exit(29);',
      'if (prompt.includes("CAPABILITY_PROBE") && process.env.RAE_MCP_TOKEN_RESEARCH !== "declared-token") process.exit(30);',
      'if (prompt.includes("CAPABILITY_PROBE") && process.env.HTTPS_PROXY) process.exit(31);',
      'const outputIndex = args.indexOf("--output-last-message");',
      'fs.writeFileSync(args[outputIndex + 1], "{}\\n", "utf8");',
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "git diff --check", cwd: ".", exit_code: 0 } }) + "\\n");',
      ...events.map(
        (event) => `process.stdout.write(${JSON.stringify(`${JSON.stringify(event)}\n`)});`,
      ),
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(executable, 0o755);
  return { root, executable };
}

export function fakeTimedOutCommandProvider({ detachedChild = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rae-command-timeout-"));
  tempRoots.push(root);
  const executable = join(root, "provider");
  const marker = join(root, detachedChild ? "detached-marker" : "group-marker");
  const child = [
    "const fs = require('node:fs');",
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'escaped'), 700);`,
    "setTimeout(() => {}, 3000);",
  ].join(" ");
  const spawnOptions = detachedChild ? ", { detached: true, stdio: 'ignore' }" : "";
  writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}]${spawnOptions});`,
      detachedChild ? "child.unref();" : "",
      "setTimeout(() => {}, 3000);",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(executable, 0o755);
  return { root, executable, marker };
}
