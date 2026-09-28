/** Characterizes Ralph's PRD, prompt, state, scope, and CLI compatibility contracts. */
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { EXIT, RalphError } from "../src/errors.js";
import { bootstrap } from "../src/helper.js";
import { buildPrompt } from "../src/prompt.js";
import { loadPrd, pathMatchesScope } from "../src/prd.js";
import { exportState, fingerprints, importState } from "../src/state.js";
import type { CliOptions, Prd, RuntimePaths, Story } from "../src/types.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function paths(root: string): RuntimePaths {
  return {
    packageRoot: root,
    repoRoot: root,
    prdFile: join(root, "prd.json"),
    schemaFile: join(root, "prd.schema.json"),
    policyFile: join(root, "INSTRUCTIONS.md"),
    stateDir: join(root, ".runtime"),
    runLog: join(root, ".runtime", "run.log"),
    eventLog: join(root, ".runtime", "events.log"),
  };
}

function options(): CliOptions {
  return {
    maxStoriesExplicit: false,
    search: false,
    timeoutSeconds: 900,
    maxAttempts: 1,
    skipAfterFailures: 0,
    captureToolOutput: false,
    requireExternalReferences: true,
    modelPreflight: false,
    autoArchive: false,
    requireLearningEntry: false,
    syncBranch: false,
    autoProgressLog: true,
    autoSyncAgents: false,
    securityPreflight: true,
    securityPreflightFail: false,
    staleLockSeconds: 30,
    strictReportDir: true,
    autoProgressRefresh: true,
    verbosity: "normal",
    outputFormat: "text",
    statusFormat: "full",
    listFormat: "full",
    action: "run",
    noColor: false,
  };
}

test("validates format-aware PRDs and rejects hidden control text", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-contract-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-contract-outside-")));
  const fixturePaths = paths(root);
  try {
    writeFileSync(fixturePaths.schemaFile, readFileSync(join(packageRoot, "prd.schema.json")));
    writeFileSync(fixturePaths.policyFile, "# Policy\n");
    writeFileSync(fixturePaths.prdFile, readFileSync(join(packageRoot, "prd.json.example")));
    assert.ok(loadPrd(fixturePaths).stories.length > 0);
    const value = JSON.parse(readFileSync(fixturePaths.prdFile, "utf8")) as Prd;
    value.project = `unsafe\u202Ename`;
    writeFileSync(fixturePaths.prdFile, `${JSON.stringify(value)}\n`);
    assert.throws(
      () => loadPrd(fixturePaths),
      (error) =>
        error instanceof RalphError &&
        error.exitCode === EXIT.prd &&
        /hidden control/u.test(error.message),
    );
    writeFileSync(
      fixturePaths.prdFile,
      JSON.stringify(value).replaceAll(String.fromCodePoint(0x202e), "\\u202e"),
    );
    assert.throws(() => loadPrd(fixturePaths), /hidden control/u);
    value.project = "visible-name";
    value.stories[0].notes = String.fromCodePoint(1);
    writeFileSync(fixturePaths.prdFile, JSON.stringify(value));
    assert.throws(() => loadPrd(fixturePaths), /hidden control/u);
    writeFileSync(fixturePaths.prdFile, Buffer.from([0xff]));
    assert.throws(
      () => loadPrd(fixturePaths),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.prd,
    );
    writeFileSync(fixturePaths.prdFile, readFileSync(join(packageRoot, "prd.json.example")));
    rmSync(fixturePaths.policyFile);
    symlinkSync(join(packageRoot, "INSTRUCTIONS.md"), fixturePaths.policyFile);
    assert.throws(
      () => loadPrd(fixturePaths),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.prd,
    );
    rmSync(fixturePaths.policyFile);
    writeFileSync(fixturePaths.policyFile, "# Policy\n");
    symlinkSync(outside, join(root, ".claude"));
    assert.throws(
      () => loadPrd(fixturePaths),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.scope,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("preserves ordered scope negation and structured prompt steps", () => {
  const story: Story = {
    id: "FIX-1",
    title: "Bounded fix",
    priority: 1,
    mode: "fixing",
    scope: ["docs/**", "!docs/private/**"],
    acceptance_criteria: ["Created audit/FIX-1.md"],
    passes: false,
    steps: [
      {
        id: "S1",
        title: "Inspect",
        actions: ["Read source"],
        expected_evidence: ["Source path"],
        done_when: ["Evidence captured"],
      },
    ],
  };
  assert.equal(pathMatchesScope(story, "docs/public/a.md"), true);
  assert.equal(pathMatchesScope(story, "docs/private/a.md"), false);
  const prompt = buildPrompt(
    paths(packageRoot),
    story,
    "fixing",
    "audit/FIX-1.md",
    "workspace-write",
    options(),
    packageRoot,
  );
  assert.match(prompt, /Step 1 \[S1\]: Inspect/u);
  assert.match(prompt, /action: Read source/u);
  assert.doesNotMatch(prompt, /\[object Object\]/u);
});

test("imports only state whose project and story definitions still match", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-state-")));
  const fixturePaths = paths(root);
  try {
    writeFileSync(fixturePaths.schemaFile, readFileSync(join(packageRoot, "prd.schema.json")));
    writeFileSync(fixturePaths.policyFile, "# Policy\n");
    writeFileSync(fixturePaths.prdFile, readFileSync(join(packageRoot, "prd.json.example")));
    const prd = loadPrd(fixturePaths);
    assert.deepEqual(fingerprints(prd), {
      project: "a479e0f9e1585692f9727d4087ba1cf0eadcb5da872f19abdf3285bf309f2c06",
      ids: "40739944d0f5508958c45ab9091e291087a222d66fe6519db5c7b9e89c5e1b3f",
      definitions: "c2154080ee7c0f951830317c843bda39251f7eaa4f5fb2f012cd7c910d5efb61",
    });
    const state = exportState(prd) as {
      stories: Array<{ passes: boolean; report_path: string; completed_at: string }>;
    };
    state.stories[0]!.passes = true;
    state.stories[0]!.report_path = ".claude/ralph-audit/audit/restored.md";
    state.stories[0]!.completed_at = "2026-01-01T00:00:00Z";
    const stateFile = join(root, "state.json");
    writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    assert.equal(importState(fixturePaths, prd, stateFile).stories[0]?.passes, true);
    const changed = loadPrd(fixturePaths);
    changed.stories[0]!.title = "Changed definition";
    assert.throws(
      () => importState(fixturePaths, changed, stateFile),
      /fingerprints do not match/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiled CLI keeps help, version, JSON query, config, and general-error behavior", (t) => {
  // Never depend on the source checkout's untracked prd.json: from source, bootstrap a disposable
  // installation with the example PRD; an embedded test run already is such an installation.
  const packageName = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;
  let installation = packageRoot;
  if (packageName !== "ralph-audit") {
    const target = realpathSync(mkdtempSync(join(tmpdir(), "ralph-cli-contract-")));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    assert.equal(spawnSync("git", ["init", "-q", target]).status, 0);
    installation = bootstrap(target);
    copyFileSync(join(installation, "prd.json.example"), join(installation, "prd.json"));
  }
  const cli = join(installation, "dist", "src", "cli.js");
  // Run from the target repository as users do; a cwd holding prd.json would select standalone mode.
  const cwd = resolve(installation, "../..");
  const help = spawnSync(process.execPath, [cli, "--help"], { cwd, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: ralph/u);
  const version = spawnSync(process.execPath, [cli, "--version"], { cwd, encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^ralph 0\.4\.0$/mu);
  const status = spawnSync(process.execPath, [cli, "--json", "--status"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).command, "status");
  const stories = spawnSync(process.execPath, [cli, "--json", "--list-stories"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(stories.status, 0, stories.stderr);
  assert.equal(Array.isArray(JSON.parse(stories.stdout)), true);
  const config = spawnSync(process.execPath, [cli, "--json", "--validate-config"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(config.status, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).checks.fs_bridge, "ok");
  const invalid = spawnSync(process.execPath, [cli, "--not-a-real-option"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(invalid.status, EXIT.general);
});
