#!/usr/bin/env node
/** Coordinates deterministic child-process runtime-guard recovery tests. */
import { existsSync, writeFileSync } from "node:fs";
import { reconcileRuntimeStateGuard } from "../../lib/runtime-state-guard.mjs";

const [mode, workspaceRoot, runId, readyPath, releasePath] = process.argv.slice(2);
if (!mode || !workspaceRoot || !runId) {
  throw new Error("usage: runtime-guard-recovery.mjs <recover|delayed> <workspace> <run-id> [ready] [release]");
}

function waitForRelease() {
  if (!readyPath || !releasePath) throw new Error("delayed recovery requires ready and release paths");
  writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + 10_000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting to release guard claimant");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

try {
  const result = reconcileRuntimeStateGuard(workspaceRoot, {
    recovery: true,
    expectedRunId: runId,
    ...(mode === "delayed" ? { afterClaim: waitForRelease } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
  process.exitCode = 2;
}
