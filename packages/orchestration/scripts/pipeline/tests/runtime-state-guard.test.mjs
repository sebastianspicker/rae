/** Verifies external pipeline-state restoration, recovery, and valid operator stop transitions. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeStateGuard,
  ensureRuntimeStateReadable,
  inspectRuntimeStateGuard,
  reconcileRuntimeStateGuard,
  runtimeStateGuardPath,
} from "../lib/runtime-state-guard.mjs";

const roots = [];
const RUN_ID = "guard-run";
const RECOVERY_FIXTURE = fileURLToPath(
  new URL("./fixtures/runtime-guard-recovery.mjs", import.meta.url),
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rae-runtime-guard-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  const runDir = join(root, ".pipeline", "runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(root, ".pipeline", "pipeline-state.json"), '{"run_id":"guard-run"}\n');
  writeFileSync(join(runDir, "request.json"), '{"task":"original"}\n');
  writeFileSync(
    join(runDir, "operator-control.json"),
    `${JSON.stringify({
      schema_version: "1.0.0",
      run_id: RUN_ID,
      status: "running",
      stop_requested: false,
      updated_at: "2026-07-19T10:00:00.000Z",
    })}\n`,
  );
  writeFileSync(join(runDir, "trace.jsonl"), "");
  writeFileSync(join(runDir, "plan.json"), "original bytes\n");
  chmodSync(join(runDir, "plan.json"), 0o640);
  symlinkSync("plan.json", join(runDir, "plan-link"));
  writeFileSync(join(runDir, "autonomous.lock"), `${JSON.stringify({ pid: process.pid })}\n`);
  return { root, runDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const active = runtimeStateGuardPath(root);
      const prefix = `${basename(active)}.claim-`;
      for (const name of readdirSync(dirname(active))) {
        if (name === basename(active) || name.startsWith(prefix)) {
          rmSync(join(dirname(active), name), { recursive: true, force: true });
        }
      }
    } catch (error) {
      if (!/no runner-only location/.test(error.message)) throw error;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function makeGuardStale(root, runDir) {
  createRuntimeStateGuard(root, RUN_ID, "build");
  writeFileSync(join(runDir, "request.json"), '{"task":"poisoned"}\n');
  const guardPath = runtimeStateGuardPath(root);
  const manifestPath = join(guardPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, owner_pid: 999999 })}\n`);
}

async function waitForFile(pathValue) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(pathValue)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${pathValue}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

describe("runtime pipeline-state guard", () => {
  it("keeps an in-place repository under a temp root out of every temp-backed guard", () => {
    const { root } = fixture();
    let guardPath;
    try {
      guardPath = runtimeStateGuardPath(root);
    } catch (error) {
      expect(error.message).toMatch(/no runner-only location/);
      return;
    }
    const tempRoot = realpathSync(tmpdir());
    const relation = relative(tempRoot, guardPath);
    expect(
      relation === "" ||
        (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation)),
    ).toBe(false);
    createRuntimeStateGuard(root, RUN_ID, "build");
    expect(runtimeStateGuardPath(root)).toBe(guardPath);
  });

  it("reports an active guarded phase without reading mutable pipeline state", () => {
    const { root } = fixture();
    createRuntimeStateGuard(root, RUN_ID, "build");
    writeFileSync(join(root, ".pipeline", "pipeline-state.json"), "poisoned\n");

    expect(inspectRuntimeStateGuard(root)).toMatchObject({
      found: true,
      ownerActive: true,
      runId: RUN_ID,
      phase: "build",
    });
    expect(() => ensureRuntimeStateReadable(root, { expectedRunId: RUN_ID })).toThrow(
      /phase build is guarded and may still be active/,
    );
    expect(readFileSync(join(root, ".pipeline", "pipeline-state.json"), "utf8")).toBe(
      "poisoned\n",
    );
  });

  it("restores bytes, modes, deletions, additions, symlinks, and the pipeline root", () => {
    const { root, runDir } = fixture();
    createRuntimeStateGuard(root, RUN_ID);
    rmSync(join(root, ".pipeline"), { recursive: true, force: true });
    mkdirSync(join(root, ".pipeline", "runs", RUN_ID), { recursive: true });
    writeFileSync(join(root, ".pipeline", "pipeline-state.json"), "poisoned\n");
    writeFileSync(join(runDir, "added.json"), "unauthorized\n");

    const result = reconcileRuntimeStateGuard(root, { expectedRunId: RUN_ID });

    expect(result.tampered).toBe(true);
    expect(readFileSync(join(root, ".pipeline", "pipeline-state.json"), "utf8")).toBe(
      '{"run_id":"guard-run"}\n',
    );
    expect(readFileSync(join(runDir, "plan.json"), "utf8")).toBe("original bytes\n");
    expect(lstatSync(join(runDir, "plan.json")).mode & 0o777).toBe(0o640);
    expect(readlinkSync(join(runDir, "plan-link"))).toBe("plan.json");
    expect(existsSync(join(runDir, "added.json"))).toBe(false);
    expect(existsSync(runtimeStateGuardPath(root))).toBe(false);
  });

  it("preserves only a validated stop control and append-only stop trace transition", () => {
    const { root, runDir } = fixture();
    createRuntimeStateGuard(root, RUN_ID);
    writeFileSync(
      join(runDir, "operator-control.json"),
      `${JSON.stringify({
        schema_version: "1.0.0",
        run_id: RUN_ID,
        status: "stop-requested",
        stop_requested: true,
        stop_requested_at: "2026-07-19T10:01:00.000Z",
        updated_at: "2026-07-19T10:01:00.000Z",
      })}\n`,
    );
    writeFileSync(
      join(runDir, "trace.jsonl"),
      `${JSON.stringify({
        event: "run_stop_requested",
        phase: "build",
        run_id: RUN_ID,
        status: "ok",
        ts: "2026-07-19T10:01:00.000Z",
      })}\n`,
    );

    const result = reconcileRuntimeStateGuard(root, { expectedRunId: RUN_ID });

    expect(result).toMatchObject({ tampered: false, concurrentStop: true });
    expect(
      JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8")),
    ).toMatchObject({ status: "stop-requested", stop_requested: true });
    expect(readFileSync(join(runDir, "trace.jsonl"), "utf8")).toContain(
      '"event":"run_stop_requested"',
    );
  });

  it("restores a crash-left guard and removes only the stale workflow lock", () => {
    const { root, runDir } = fixture();
    createRuntimeStateGuard(root, RUN_ID);
    writeFileSync(join(runDir, "request.json"), '{"task":"poisoned"}\n');
    const guardPath = runtimeStateGuardPath(root);
    const manifestPath = join(guardPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, owner_pid: 999999 })}\n`);

    const result = ensureRuntimeStateReadable(root, { expectedRunId: RUN_ID });

    expect(result).toMatchObject({ found: true, restored: true, tampered: false });
    expect(readFileSync(join(runDir, "request.json"), "utf8")).toBe(
      '{"task":"original"}\n',
    );
    expect(existsSync(join(runDir, "autonomous.lock"))).toBe(false);
    expect(existsSync(guardPath)).toBe(false);
  });

  it("returns a failed post-mutation claim for retry by the same live process", () => {
    const { root, runDir } = fixture();
    makeGuardStale(root, runDir);
    expect(() =>
      reconcileRuntimeStateGuard(root, {
        recovery: true,
        expectedRunId: RUN_ID,
        afterPipelineRemoval() {
          const contender = spawnSync(
            process.execPath,
            [RECOVERY_FIXTURE, "recover", root, RUN_ID],
            { encoding: "utf8", timeout: 5_000 },
          );
          expect(contender.status).toBe(2);
          expect(contender.stderr).toContain("E_PIPELINE_GUARD_CLAIMED");
          throw Object.assign(new Error("transient restore failure"), { code: "EIO" });
        },
      }),
    ).toThrow(/transient restore failure/);
    expect(existsSync(join(root, ".pipeline"))).toBe(false);
    expect(inspectRuntimeStateGuard(root)).toMatchObject({ found: true, ownerActive: false });

    expect(
      reconcileRuntimeStateGuard(root, { recovery: true, expectedRunId: RUN_ID }),
    ).toMatchObject({ found: true, restored: true, tampered: false });
    expect(readFileSync(join(runDir, "request.json"), "utf8")).toBe(
      '{"task":"original"}\n',
    );
  });

  it("fails closed while the recorded guard owner may still be active", () => {
    const { root } = fixture();
    createRuntimeStateGuard(root, RUN_ID);
    expect(() => reconcileRuntimeStateGuard(root, { recovery: true })).toThrow(
      "may still be active",
    );
    expect(existsSync(runtimeStateGuardPath(root))).toBe(true);
  });

  it("allows only one delayed recovery claimant across processes", async () => {
    const { root, runDir } = fixture();
    makeGuardStale(root, runDir);
    const ready = join(root, "claim-ready");
    const release = join(root, "claim-release");
    const first = spawn(
      process.execPath,
      [RECOVERY_FIXTURE, "delayed", root, RUN_ID, ready, release],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForFile(ready);
      const second = spawnSync(
        process.execPath,
        [RECOVERY_FIXTURE, "recover", root, RUN_ID],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(second.status).toBe(2);
      expect(second.stderr).toContain("E_PIPELINE_GUARD_CLAIMED");
      expect(readFileSync(join(runDir, "request.json"), "utf8")).toBe(
        '{"task":"poisoned"}\n',
      );
      writeFileSync(release, "release\n");
      expect(await childExit(first)).toMatchObject({ code: 0, signal: null });
      expect(readFileSync(join(runDir, "request.json"), "utf8")).toBe(
        '{"task":"original"}\n',
      );
    } finally {
      if (!existsSync(release)) writeFileSync(release, "release\n");
      if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
    }
  });

  it("reclaims evidence left by an interrupted recovery claimant", async () => {
    const { root, runDir } = fixture();
    makeGuardStale(root, runDir);
    const ready = join(root, "interrupt-ready");
    const release = join(root, "interrupt-release");
    const interrupted = spawn(
      process.execPath,
      [RECOVERY_FIXTURE, "delayed", root, RUN_ID, ready, release],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForFile(ready);
    interrupted.kill("SIGKILL");
    expect((await childExit(interrupted)).signal).toBe("SIGKILL");
    expect(inspectRuntimeStateGuard(root)).toMatchObject({ found: true, ownerActive: false });

    const recovery = spawnSync(
      process.execPath,
      [RECOVERY_FIXTURE, "recover", root, RUN_ID],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(recovery.status).toBe(0);
    expect(readFileSync(join(runDir, "request.json"), "utf8")).toBe(
      '{"task":"original"}\n',
    );
    expect(inspectRuntimeStateGuard(root)).toMatchObject({ found: false });
  });
});
