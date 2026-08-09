/**
 * Exercises provider selection, redaction, and structured agent artifacts so pipeline phases fail safely.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDoctor, minimalChildEnvironment, runAgentPhase } from "../lib/agent-executor.mjs";
import { codexCapabilityArgs } from "../lib/codex-capabilities.mjs";

const tempRoots = [];

function fakeCodex(authenticated) {
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

function fakeCodexRuntime(events = []) {
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

function fakeTimedOutCommandProvider({ detachedChild = false } = {}) {
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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("agentDoctor", () => {
  it("builds a sealed one-run capability surface and hides MCP credentials from shell tools", () => {
    const args = codexCapabilityArgs({
      web_search: "disabled",
      credential_env_vars: ["RESEARCH_MCP_TOKEN"],
      mcp_servers: [
        {
          name: "research",
          url: "https://mcp.example.invalid/rae",
          enabled_tools: ["lookup_claim"],
          token_env_var: "RESEARCH_MCP_TOKEN",
        },
      ],
    });
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).toContain("--strict-config");
    expect(args).toContain('web_search="disabled"');
    expect(args).toContain("features.apps=false");
    expect(args).toContain("features.plugins=false");
    expect(args).toContain('mcp_servers.research.enabled_tools=["lookup_claim"]');
    expect(args).toContain('shell_environment_policy.filters.RESEARCH_MCP_TOKEN="exclude"');
  });

  it("drops ambient proxy, trust-store, XDG, and undeclared credential variables for v2", () => {
    const child = minimalChildEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/fixture",
        CODEX_HOME: "/codex/fixture",
        HTTPS_PROXY: "http://proxy.invalid",
        SSL_CERT_FILE: "/private/ca.pem",
        XDG_CONFIG_HOME: "/private/config",
        OPENAI_API_KEY: "ambient-provider-secret",
        RAE_MCP_TOKEN_RESEARCH: "declared-mcp-secret",
      },
      "/workspace",
      ["RAE_MCP_TOKEN_RESEARCH"],
    );
    expect(child).toMatchObject({
      PATH: "/bin",
      HOME: "/home/fixture",
      CODEX_HOME: "/codex/fixture",
      RAE_MCP_TOKEN_RESEARCH: "declared-mcp-secret",
      PWD: "/workspace",
    });
    expect(child.HTTPS_PROXY).toBeUndefined();
    expect(child.SSL_CERT_FILE).toBeUndefined();
    expect(child.XDG_CONFIG_HOME).toBeUndefined();
    expect(child.OPENAI_API_KEY).toBeUndefined();
  });

  it("runs Codex with only the profile-declared MCP surface and credential", () => {
    const { root } = fakeCodexRuntime();
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "CAPABILITY_PROBE",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      capabilities: {
        web_search: "disabled",
        credential_env_vars: ["RAE_MCP_TOKEN_RESEARCH"],
        mcp_servers: [
          {
            name: "research",
            url: "https://mcp.example.invalid/rae",
            enabled_tools: ["lookup_claim"],
            token_env_var: "RAE_MCP_TOKEN_RESEARCH",
          },
        ],
      },
      env: {
        PATH: root,
        HOME: root,
        CODEX_HOME: root,
        HTTPS_PROXY: "http://ambient-proxy.invalid",
        RAE_MCP_TOKEN_RESEARCH: "declared-token",
        UNDECLARED_SECRET: "must-not-leak",
      },
    });

    expect(result.capabilitySurface.mcp_servers[0].enabled_tools).toEqual(["lookup_claim"]);
    expect(result.credentialManifest).toEqual([
      {
        name: "RAE_MCP_TOKEN_RESEARCH",
        digest: "85e04780d862d1d9814a9a1575e689dab694f01f25f9e5d9510e3ee60f836970",
      },
    ]);
  });

  it("passes only when Codex has required capabilities and authentication", () => {
    const path = fakeCodex(true);
    const result = agentDoctor({ provider: "codex", env: { PATH: path } });

    expect(result.success).toBe(true);
    expect(result.sandbox_enforced).toBe(true);
    expect(result.capabilities.authenticated).toBe(true);
  });

  it("fails when the Codex CLI is not authenticated", () => {
    const path = fakeCodex(false);
    const result = agentDoctor({ provider: "codex", env: { PATH: path } });

    expect(result.success).toBe(false);
    expect(result.capabilities.authenticated).toBe(false);
    expect(result.detail).toContain("unauthenticated");
  });

  it("skips non-executable PATH entries and fails closed when no executable remains", () => {
    const blockedRoot = mkdtempSync(join(tmpdir(), "rae-non-executable-codex-"));
    tempRoots.push(blockedRoot);
    const blockedExecutable = join(blockedRoot, "codex");
    writeFileSync(blockedExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(blockedExecutable, 0o644);
    const executableRoot = fakeCodex(true);

    expect(
      agentDoctor({
        provider: "codex",
        env: { PATH: [blockedRoot, executableRoot].join(delimiter) },
      }).success,
    ).toBe(true);
    expect(agentDoctor({ provider: "codex", env: { PATH: blockedRoot } })).toMatchObject({
      success: false,
      executable: null,
    });
  });

  it("persists a validated Codex JSON event stream with command evidence", () => {
    const { root, executable } = fakeCodexRuntime([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 24763,
          cached_input_tokens: 24448,
          output_tokens: 122,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    const outputPath = join(root, "artifact.json");
    const eventLogPath = join(root, "events.jsonl");
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath,
      eventLogPath,
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    expect(result.artifact).toEqual({});
    expect(result.eventCount).toBe(2);
    expect(result.commandEventCount).toBe(1);
    expect(result.successfulCommandEventCount).toBe(1);
    expect(result.commandEvents).toEqual([
      {
        command: "git diff --check",
        working_directory: ".",
        phase: null,
        exit_code: 0,
        successful: true,
      },
    ]);
    expect(result.resourceUsage).toEqual({
      measurement_status: "complete",
      input_tokens: 24763,
      cached_input_tokens: 24448,
      output_tokens: 122,
      reasoning_output_tokens: 0,
      missing_measurements: [],
      parser: "codex-turn-completed-usage-v1",
    });
    expect(readFileSync(eventLogPath, "utf8")).toContain("command_execution");
    expect(result.provider).toBe("codex");
    expect(result.eventLogPath).toBe(eventLogPath);
    expect(executable).toBe(join(root, "codex"));
  });

  it("scrubs unknown secrets while preserving required Codex authentication", () => {
    const { root } = fakeCodexRuntime();
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "ENV_PROBE",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: {
        PATH: root,
        OPENAI_API_KEY: "allowed-auth",
        RAE_TEST_UNKNOWN_SECRET: "must-not-leak",
        CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "untrusted",
      },
    });

    expect(result.provider).toBe("codex");
  });

  it("marks absent usage unavailable without inventing zero values", () => {
    const { root } = fakeCodexRuntime();
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    expect(result.resourceUsage.measurement_status).toBe("unavailable");
    expect(result.resourceUsage.input_tokens).toBeUndefined();
    expect(result.resourceUsage.output_tokens).toBeUndefined();
    expect(result.resourceUsage.missing_measurements).toEqual([
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
    ]);
  });

  it("does not count message text or failed commands as successful command evidence", () => {
    const { root } = fakeCodexRuntime([
      { type: "item.completed", item: { type: "agent_message", text: "command_execution" } },
      {
        type: "item.completed",
        item: { type: "command_execution", command: "npm test", exit_code: 1 },
      },
    ]);
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    // The fixture emits one successful git diff command before the supplied
    // events. The message is ignored and the failed command is retained only
    // as failed evidence.
    expect(result.commandEventCount).toBe(2);
    expect(result.successfulCommandEventCount).toBe(1);
    expect(result.commandEvents.at(-1)).toEqual({
      command: "npm test",
      working_directory: null,
      phase: null,
      exit_code: 1,
      successful: false,
    });
  });

  it("does not persist an absolute command working directory outside the workspace", () => {
    const externalCwd = join(tmpdir(), "rae-external-workspace");
    const { root } = fakeCodexRuntime([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          cwd: externalCwd,
          exit_code: 0,
        },
      },
    ]);
    const eventLogPath = join(root, "events.jsonl");
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath,
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    expect(result.commandEvents.at(-1).working_directory).toBeNull();
    expect(readFileSync(eventLogPath, "utf8")).not.toContain(externalCwd);
  });

  it("marks incomplete documented usage partial", () => {
    const { root } = fakeCodexRuntime([
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
      },
    ]);
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath: join(root, "events.jsonl"),
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    expect(result.resourceUsage).toMatchObject({
      measurement_status: "partial",
      input_tokens: 10,
      cached_input_tokens: 4,
      output_tokens: 2,
      missing_measurements: ["reasoning_output_tokens"],
    });
    expect(result.resourceUsage.reasoning_output_tokens).toBeUndefined();
  });

  it("persists the redacted stream before rejecting invalid usage", () => {
    const { root } = fakeCodexRuntime([
      {
        type: "turn.completed",
        usage: {
          input_tokens: -1,
          cached_input_tokens: 0,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    const eventLogPath = join(root, "events.jsonl");

    expect(() =>
      runAgentPhase({
        provider: "codex",
        workspaceRoot: root,
        schemaPath: join(root, "schema.json"),
        outputPath: join(root, "artifact.json"),
        eventLogPath,
        prompt: "Return the test artifact.",
        sandboxMode: "read-only",
        timeoutMs: 5_000,
        env: { PATH: root },
      }),
    ).toThrow("input_tokens must be a non-negative safe integer");
    expect(readFileSync(eventLogPath, "utf8")).toContain('"input_tokens":-1');
  });

  it("redacts structured credential fields and command arguments from event evidence", () => {
    const { root } = fakeCodexRuntime([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "tool --api-key top-secret-value --header 'Bearer bearer-secret-value'",
          exit_code: 0,
          environment: {
            access_token: "structured-secret-value",
            AWS_SECRET_ACCESS_KEY: "aws-secret-value",
            GITHUB_TOKEN: "github-secret-value",
            openaiApiKey: "openai-secret-value",
            "x-api-key": "header-secret-value",
            private_key: "private-key-value",
            safe_label: "visible-value",
          },
        },
      },
    ]);
    const eventLogPath = join(root, "events.jsonl");
    const result = runAgentPhase({
      provider: "codex",
      workspaceRoot: root,
      schemaPath: join(root, "schema.json"),
      outputPath: join(root, "artifact.json"),
      eventLogPath,
      prompt: "Return the test artifact.",
      sandboxMode: "read-only",
      timeoutMs: 5_000,
      env: { PATH: root },
    });

    const evidence = readFileSync(eventLogPath, "utf8");
    expect(evidence).not.toContain("top-secret-value");
    expect(evidence).not.toContain("bearer-secret-value");
    expect(evidence).not.toContain("structured-secret-value");
    for (const secret of [
      "aws-secret-value",
      "github-secret-value",
      "openai-secret-value",
      "header-secret-value",
      "private-key-value",
    ]) {
      expect(evidence).not.toContain(secret);
    }
    expect(evidence).toContain("visible-value");
    expect(evidence).toContain("[REDACTED]");
    expect(JSON.stringify(result.commandEvents)).not.toContain("top-secret-value");
    expect(JSON.stringify(result.commandEvents)).not.toContain("bearer-secret-value");
    expect(result.commandEvents.at(-1).command).toContain("[REDACTED]");
    for (const line of evidence.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("kills ordinary provider descendants after a timeout and reports containment uncertainty", async () => {
    const { root, executable, marker } = fakeTimedOutCommandProvider();
    expect(() =>
      runAgentPhase({
        provider: "command",
        allowUnsafeCommand: true,
        command: executable,
        workspaceRoot: root,
        schemaPath: join(root, "schema.json"),
        prompt: "timeout regression",
        sandboxMode: "workspace-write",
        timeoutMs: 350,
        env: { PATH: root },
      }),
    ).toThrow(/containment_uncertain/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("does not silently claim full containment when a provider child attempts to detach its session", () => {
    const { root, executable } = fakeTimedOutCommandProvider({ detachedChild: true });
    expect(() =>
      runAgentPhase({
        provider: "command",
        allowUnsafeCommand: true,
        command: executable,
        workspaceRoot: root,
        schemaPath: join(root, "schema.json"),
        prompt: "detached timeout regression",
        sandboxMode: "workspace-write",
        timeoutMs: 350,
        env: { PATH: root },
      }),
    ).toThrow(/containment_uncertain/);
  });
});
