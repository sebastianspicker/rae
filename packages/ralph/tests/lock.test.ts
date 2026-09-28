/** Verifies authenticated lock ownership, stale recovery, and symlink refusal. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT, RalphError } from "../src/errors.js";
import { lockState, RunLock } from "../src/lock.js";
import type { RuntimePaths } from "../src/types.js";

function fixture(): { root: string; paths: RuntimePaths } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-lock-")));
  const stateDir = join(root, ".runtime");
  mkdirSync(stateDir, { mode: 0o700 });
  return {
    root,
    paths: {
      packageRoot: root,
      repoRoot: root,
      prdFile: join(root, "prd.json"),
      schemaFile: join(root, "prd.schema.json"),
      policyFile: join(root, "INSTRUCTIONS.md"),
      stateDir,
      runLog: join(stateDir, "run.log"),
      eventLog: join(stateDir, "events.log"),
    },
  };
}

test("rejects a live lock and removes only an authenticated owned lock", () => {
  const item = fixture();
  try {
    const first = new RunLock(item.paths, 30);
    first.acquire();
    assert.equal(lockState(item.paths).pid, process.pid);
    assert.throws(
      () => new RunLock(item.paths, 30).acquire(),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.lock,
    );
    first.release();
    assert.equal(lockState(item.paths).held, false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("reclaims an old pid-less lock and fails closed on a symlinked lock", () => {
  const item = fixture();
  const outside = mkdtempSync(join(tmpdir(), "ralph-lock-outside-"));
  try {
    const directory = join(item.paths.stateDir, ".run.lock");
    mkdirSync(directory, { mode: 0o700 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(directory, old, old);
    const lock = new RunLock(item.paths, 30);
    lock.acquire();
    lock.release();

    symlinkSync(outside, directory);
    assert.throws(
      () => new RunLock(item.paths, 0).acquire(),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.lock,
    );
    writeFileSync(join(outside, "sentinel"), "untouched\n");
    assert.equal(lockState(item.paths).held, true);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
