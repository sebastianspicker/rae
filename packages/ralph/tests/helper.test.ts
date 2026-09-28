/** Covers TypeScript helper output, confinement, and embedded bootstrap behavior. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  appendProgressEntry,
  archiveState,
  bootstrap,
  generateProgress,
  recordLearningEntry,
  syncAgents,
} from "../src/helper.js";

function samplePrd(): object {
  return {
    project: "Helper Test",
    defaults: {
      report_dir: "audit",
      sandbox_by_mode: { audit: "read-only", linting: "read-only", fixing: "workspace-write" },
    },
    stories: [
      {
        id: "A-1",
        title: "Open",
        priority: 2,
        mode: "audit",
        scope: ["**"],
        acceptance_criteria: ["Created audit/a.md"],
        passes: false,
      },
      {
        id: "F-1",
        title: "Done",
        priority: 1,
        mode: "fixing",
        scope: ["docs/**"],
        acceptance_criteria: ["Created audit/f.md"],
        passes: true,
        steps: [],
      },
    ],
  };
}

test("helpers write progress, learning, sync, and archive artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "ralph-helper-"));
  try {
    writeFileSync(join(root, "prd.json"), `${JSON.stringify(samplePrd())}\n`);
    writeFileSync(join(root, "AGENTS.md"), "# Agent Guide\n");
    generateProgress(join(root, "prd.json"), join(root, "progress.txt"));
    assert.match(readFileSync(join(root, "progress.txt"), "utf8"), /Stories passed: `1\/2`/u);

    recordLearningEntry(root, "F-1", "Keep descriptor-relative writes.", "src/safe-fs.ts");
    syncAgents(root);
    assert.match(
      readFileSync(join(root, "AGENTS.md"), "utf8"),
      /- Note: Keep descriptor-relative writes\./u,
    );

    appendProgressEntry(root, "F-1", "fixing", "Done", "audit/f.md");
    assert.match(readFileSync(join(root, "progress.log.md"), "utf8"), /- Report: audit\/f\.md/u);

    const archived = archiveState(root, join(root, "archive"), "helper test", "verification");
    assert.equal(existsSync(join(archived, "prd.json")), true);
    assert.match(readFileSync(join(archived, "archive.meta"), "utf8"), /reason=verification/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap installs a self-contained Node payload and rejects a symlinked parent", () => {
  const root = mkdtempSync(join(tmpdir(), "ralph-bootstrap-"));
  const outside = mkdtempSync(join(tmpdir(), "ralph-bootstrap-outside-"));
  try {
    const destination = bootstrap(root, false, true);
    assert.equal(existsSync(join(destination, "dist", "src", "cli.js")), true);
    assert.equal(
      existsSync(
        join(
          destination,
          "node_modules",
          "@rae",
          "fs-bridge",
          "build",
          "Release",
          "rae_fs_bridge.node",
        ),
      ),
      true,
    );
    assert.equal(existsSync(join(destination, "ralph.sh")), false);
    assert.equal(existsSync(join(destination, "package.json")), true);
    const manifest = JSON.parse(readFileSync(join(destination, "package.json"), "utf8")) as {
      scripts: { ralph: string; test?: string };
    };
    assert.equal(manifest.scripts.ralph, "node ./dist/src/cli.js");
    assert.match(manifest.scripts.test ?? "", /^node --test/u);
    writeFileSync(
      join(destination, "prd.json"),
      readFileSync(join(destination, "prd.json.example")),
    );
    const embeddedEnv = { ...process.env };
    delete embeddedEnv.NODE_TEST_CONTEXT;
    const embedded = spawnSync("npm", ["test"], {
      cwd: destination,
      encoding: "utf8",
      timeout: 60_000,
      env: embeddedEnv,
    });
    assert.equal(embedded.status, 0, `${embedded.stdout}\n${embedded.stderr}`);
    assert.match(embedded.stdout, /ℹ tests \d+/u);
    assert.match(embedded.stdout, /ℹ fail 0/u);
    const cli = join(destination, "dist", "src", "cli.js");
    const example = readFileSync(join(destination, "prd.json.example"), "utf8");
    const runCli = (
      args: string[],
      additions: NodeJS.ProcessEnv = {},
    ): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...embeddedEnv, ...additions },
      });
    assert.equal(runCli(["--validate-prd"]).status, 0);
    assert.equal(runCli(["--not-a-real-option"]).status, 1);
    writeFileSync(join(destination, "prd.json"), "{\n");
    assert.equal(runCli(["--validate-prd"]).status, 2);
    const unsafeReport = JSON.parse(example) as {
      stories: Array<{ acceptance_criteria: string[] }>;
    };
    unsafeReport.stories[0]!.acceptance_criteria = ["Created audit/not-markdown.txt"];
    writeFileSync(join(destination, "prd.json"), `${JSON.stringify(unsafeReport)}\n`);
    assert.equal(runCli(["--validate-prd"]).status, 3);
    writeFileSync(join(destination, "prd.json"), example);
    assert.equal(runCli(["--no-security-preflight", "1"], { PATH: "/usr/bin:/bin" }).status, 4);
    assert.equal(
      runCli(["--security-preflight", "0"], {
        RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK: "true",
        RALPH_PARITY_API_KEY: "private-test-value",
      }).status,
      6,
    );
    const lock = join(destination, ".runtime", ".run.lock");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`, { mode: 0o600 });
    writeFileSync(join(lock, "token"), "fixture\n", { mode: 0o600 });
    assert.equal(runCli(["--no-security-preflight", "0"]).status, 5);
    rmSync(lock, { recursive: true, force: true });
    assert.equal(existsSync(join(destination, "scripts", "ralph_fs_txn.py")), false);
    assert.throws(() => bootstrap(root), /destination already exists/u);
    rmSync(join(root, ".claude"), { recursive: true, force: true });
    symlinkSync(outside, join(root, ".claude"));
    assert.throws(() => bootstrap(root, true), /must not be a symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("append helpers refuse a symlinked output without reading or replacing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "ralph-helper-link-"));
  const outside = mkdtempSync(join(tmpdir(), "ralph-helper-link-outside-"));
  try {
    const target = join(outside, "sentinel.md");
    writeFileSync(target, "private sentinel\n");
    symlinkSync(target, join(root, "learnings.md"));
    assert.throws(() => recordLearningEntry(root, "F-1", "Must fail closed."));
    assert.equal(readFileSync(target, "utf8"), "private sentinel\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
