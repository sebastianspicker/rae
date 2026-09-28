/** Verifies safe PRD branch creation, checkout, and name rejection. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncBranch } from "../src/branch.js";
import { parseArgs } from "../src/config.js";
import { Logger } from "../src/logger.js";
import type { Prd, RuntimePaths } from "../src/types.js";

test("creates a requested branch from main, reuses it, and rejects unsafe names", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-branch-")));
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.email", "ralph-test@example.invalid");
    git("config", "user.name", "Ralph Test");
    writeFileSync(join(root, "tracked.txt"), "baseline\n");
    git("add", "tracked.txt");
    git("commit", "-m", "fixture");
    const paths: RuntimePaths = {
      packageRoot: root,
      repoRoot: root,
      prdFile: join(root, "prd.json"),
      schemaFile: join(root, "prd.schema.json"),
      policyFile: join(root, "INSTRUCTIONS.md"),
      stateDir: join(root, ".runtime"),
      runLog: join(root, ".runtime", "run.log"),
      eventLog: join(root, ".runtime", "events.log"),
    };
    const options = parseArgs(["--sync-branch"]);
    const prd: Prd = {
      branch_name: "ralph/fixture",
      defaults: {
        report_dir: "reports",
        sandbox_by_mode: { audit: "read-only", linting: "read-only", fixing: "workspace-write" },
      },
      stories: [],
    };
    syncBranch(prd, paths, "fixing", options, new Logger(paths, options, false));
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "ralph/fixture");
    git("checkout", "main");
    syncBranch(prd, paths, "fixing", options, new Logger(paths, options, false));
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "ralph/fixture");
    prd.branch_name = "../unsafe";
    assert.throws(
      () => syncBranch(prd, paths, "fixing", options, new Logger(paths, options, false)),
      /Unsafe branch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
