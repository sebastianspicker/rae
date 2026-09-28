/** Exercises byte accounting, Unicode diagnostics and early provider exit without external services. */
import assert from "node:assert/strict";
import test from "node:test";
import { boundedProcessFailure } from "../src/agents/agent-provider-runtime.js";
import { runBoundedProcess, REDACTED_TAIL_BYTES } from "../src/agents/bounded-process.js";

for (const channel of ["stdout", "stderr"] as const) {
  test(`${channel} overflow counts UTF-8 bytes and caps decoded diagnostics`, async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: [
        "-e",
        `process.${channel}.write(Buffer.alloc(128 * 1024, 0xff));setInterval(()=>{},1000)`,
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 1024,
    });
    assert.equal(result.termination?.reason, `${channel}_overflow`);
    assert.ok(result[`${channel}Bytes`] > 1024);
    assert.ok(Buffer.byteLength(result[`${channel}Tail`]) <= REDACTED_TAIL_BYTES);
    assert.equal(result.termination?.closeObserved, true);
    assert.equal(result.termination?.containmentUncertain, false);
    const failure = boundedProcessFailure("fixture", 5000, {
      ...result,
      stdoutTail: "TOKEN=x ".repeat(8192),
      stderrTail: "日本語 ".repeat(8192),
    });
    assert.ok(failure);
    assert.equal(failure.stdoutTail.includes("TOKEN=x"), false);
    assert.ok(Buffer.byteLength(failure.stdoutTail) <= REDACTED_TAIL_BYTES);
    assert.ok(Buffer.byteLength(failure.stderrTail) <= REDACTED_TAIL_BYTES);
  });
}

test("Unicode byte limits do not count UTF-16 characters", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('🦊'.repeat(300));setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    stdoutLimitBytes: 1000,
  });
  assert.equal(result.stdoutBytes, 1200);
  assert.equal(result.termination?.reason, "stdout_overflow");
});

test("a provider can close stdin before a large prompt without crashing the supervisor", async () => {
  const result = await runBoundedProcess({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    input: "x".repeat(2 * 1024 * 1024),
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
  });
  assert.equal(result.status, 7);
});

test("an already-cancelled request never spawns a child", async () => {
  const result = await runBoundedProcess({
    command: "/nonexistent-cancelled-provider",
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    signal: AbortSignal.abort(),
  });
  assert.equal(result.pid, undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.termination?.reason, "aborted");
  assert.equal(result.termination?.containmentUncertain, false);
});
