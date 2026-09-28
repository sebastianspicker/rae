/** Verify completed worker results and contained provider cancellation. */
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runAgentPhase } from "../src/agents/agent-executor.js";
import type { ProviderProcessError } from "../src/agents/agent-provider-runtime.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-worker-boundary-")));
  roots.push(root);
  return root;
}

function executable(root: string, name: string, source: string): string {
  const path = resolve(root, name);
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o700);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workflow agent worker boundary", () => {
  it("awaits the provider and emits its completed result", () => {
    const root = temporaryRoot();
    const provider = executable(
      root,
      "provider.mjs",
      "#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{\"value\":42}\\n'));\n",
    );
    const worker = resolve(import.meta.dirname, "../src/cli/workflow-agent-worker.js");
    const request = {
      provider: "command",
      command: provider,
      commandArgs: [],
      phase: "test-node",
      runId: "test-run",
      workspaceRoot: root,
      schemaPath: resolve(root, "schema.json"),
      prompt: "test",
      sandboxMode: "read-only",
      timeoutMs: 2_000,
      allowUnsafeCommand: true,
    };
    const result = spawnSync(process.execPath, [worker], {
      cwd: root,
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).artifact, { value: 42 });
    assert.equal(JSON.parse(result.stdout).provider, "command");
  });

  it("aborts a provider group and waits for termination evidence", async () => {
    const root = temporaryRoot();
    const provider = executable(
      root,
      "stubborn.mjs",
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    const controller = new AbortController();
    const execution = runAgentPhase({
      provider: "command",
      command: provider,
      phase: "test-node",
      runId: "test-run",
      workspaceRoot: root,
      schemaPath: resolve(root, "schema.json"),
      prompt: "test",
      sandboxMode: "read-only",
      timeoutMs: 10_000,
      signal: controller.signal,
      allowUnsafeCommand: true,
    });
    setTimeout(() => controller.abort(), 100);
    let failure: ProviderProcessError | undefined;
    try {
      await execution;
    } catch (error) {
      failure = error as ProviderProcessError;
    }
    assert.equal(failure?.code, "PROCESS_ABORTED");
    assert.equal(failure?.termination.closeObserved, true);
    if (process.platform !== "win32") {
      assert.equal(failure?.termination.groupAbsentObserved, true);
      assert.equal(failure?.termination.containmentUncertain, false);
    }
  });
});
