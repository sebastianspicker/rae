/**
 * Exercises Codex event streams, redaction, usage, and timeout containment.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentPhase } from "../lib/agent-executor.mjs";
import {
  cleanupTempRoots,
  fakeCodexRuntime,
  fakeTimedOutCommandProvider,
} from "./agent-executor-test-fixtures.mjs";

afterEach(() => {
  cleanupTempRoots();
});

describe("agentDoctor", () => {
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

  it("preserves the first command working-directory field after redaction", () => {
    const externalCwd = join(tmpdir(), "rae-external-command-cwd");
    const { root } = fakeCodexRuntime([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          cwd: externalCwd,
          working_directory: ".",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          cwd: null,
          working_directory: ".",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          cwd: 0,
          working_directory: ".",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test",
          working_directory: "",
          exit_code: 0,
        },
        cwd: ".",
      },
      {
        type: "item.completed",
        item: { type: "command_execution", command: "npm test", exit_code: 0 },
        cwd: ".",
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

    expect(result.commandEvents.slice(-5).map((event) => event.working_directory)).toEqual([
      null,
      null,
      null,
      null,
      ".",
    ]);
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
