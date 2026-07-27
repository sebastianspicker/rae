/**
 * Exercises autonomous workflow safety checks for locks, workspace ownership, and evidence before phases advance.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");
const AUTONOMOUS = join(PACKAGE_ROOT, "scripts/pipeline/autonomous.mjs");
const FAKE_AGENT = join(import.meta.dirname, "fixtures/fake-agent.mjs");
const tempRoots = [];

function run(command, args, cwd, allowFailure = false, env = process.env) {
  const proc = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!allowFailure && proc.status !== 0) {
    throw new Error(`${command} failed (${proc.status}):\n${proc.stderr}\n${proc.stdout}`);
  }
  return proc;
}

function createFakeCodexBin() {
  const root = mkdtempSync(join(tmpdir(), "rae fake codex "));
  tempRoots.push(root);
  const executable = join(root, "codex");
  writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      "const value = (flag) => args[args.indexOf(flag) + 1];",
      'const prompt = fs.readFileSync(0, "utf8");',
      "const phase = prompt.match(/^Phase: (.+)$/m)?.[1];",
      "const runId = prompt.match(/^Run: (.+)$/m)?.[1];",
      'const workspaceRoot = value("-C");',
      "const request = {",
      '  protocol_version: "rae-agent-v1",',
      "  phase,",
      "  run_id: runId,",
      "  workspace_root: workspaceRoot,",
      '  schema_path: value("--output-schema"),',
      '  sandbox_mode: value("-s"),',
      "  prompt,",
      "};",
      `const agent = spawnSync(process.execPath, [${JSON.stringify(FAKE_AGENT)}], { input: JSON.stringify(request), encoding: "utf8" });`,
      "if (agent.status !== 0) { process.stderr.write(agent.stderr); process.exit(agent.status ?? 1); }",
      'fs.writeFileSync(value("--output-last-message"), agent.stdout, "utf8");',
      'const evidenceCommand = phase === "quality-tests" ? "npm test" : "git diff --check";',
      'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: evidenceCommand, cwd: ".", exit_code: 0 } }) + "\\n");',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(executable, 0o755);
  return root;
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "rae autonomous test "));
  tempRoots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".pipeline/\n", "utf8");
  writeFileSync(join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(join(root, "src/value.txt"), "original\n", "utf8");
  run("git", ["init", "-b", "main"], root);
  run("git", ["add", "."], root);
  run(
    "git",
    [
      "-c",
      "user.name=RAE Test",
      "-c",
      "user.email=rae-test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    root,
  );
  return root;
}

function runAutonomous(root, task, allowFailure = false) {
  return run(
    process.execPath,
    [
      AUTONOMOUS,
      "run",
      "--project-root",
      root,
      "--task",
      task,
      "--provider",
      "command",
      "--agent-command",
      process.execPath,
      "--agent-arg",
      FAKE_AGENT,
      "--allow-unsafe-command-provider",
      "--timeout-seconds",
      "30",
      "--json",
    ],
    PACKAGE_ROOT,
    allowFailure,
  );
}

function pauseBeforeBuild(root) {
  const paused = run(
    process.execPath,
    [
      AUTONOMOUS,
      "run",
      "--project-root",
      root,
      "--task",
      "Implement the fixture value and document it.",
      "--through",
      "build",
      "--checkpoint-policy",
      "before-mutation",
      "--provider",
      "command",
      "--agent-command",
      process.execPath,
      "--agent-arg",
      FAKE_AGENT,
      "--allow-unsafe-command-provider",
      "--json",
    ],
    PACKAGE_ROOT,
  );
  const output = JSON.parse(paused.stdout);
  const runDir = join(output.workspace_root, ".pipeline", "runs", output.run_id);
  const control = JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8"));
  const checkpointPath = join(runDir, "checkpoints", `${control.waiting_checkpoint_id}.json`);
  return {
    output,
    runDir,
    checkpointPath,
    checkpoint: JSON.parse(readFileSync(checkpointPath, "utf8")),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertSuccessfulWorkspace(output, root) {
  expect(output.success).toBe(true);
  expect(output.status).toBe("implemented-awaiting-human-release-review");
  expect(output.workspace_root).not.toBe(root);
  expect(output.workspace_root).toContain(join(root, ".git", "rae-worktrees"));
  expect(output.cleanup_command).toContain("pipeline-init.sh");
  expect(output.cleanup_command).toContain(output.workspace_root);
  expect(run("git", ["status", "--short"], root).stdout).toBe("");
  expect(readFileSync(join(root, "src/value.txt"), "utf8")).toBe("original\n");
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("implemented\n");
  expect(readFileSync(join(output.workspace_root, "README.md"), "utf8")).toContain("Implemented value");
}

function assertSuccessfulArtifacts(output) {
  const state = JSON.parse(readFileSync(join(output.workspace_root, ".pipeline/pipeline-state.json"), "utf8"));
  expect(state.completed_gates).toHaveLength(10);
  expect(state.completed_gates).toContain("post-build-gate");
  const runDir = join(output.workspace_root, ".pipeline/runs", output.run_id);
  const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8"));
  expect(request.policy.policy_id).toBe("default");
  expect(request.policy.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(request.policy.snapshot.phase_inputs.build).toContain("plan.json");
  expect(JSON.parse(readFileSync(join(runDir, "build.json"), "utf8")).outputs).toEqual(["README.md", "src/value.txt"]);
  assertQualityArtifacts(runDir);
}

function assertQualityArtifacts(runDir) {
  const testsReport = JSON.parse(readFileSync(join(runDir, "quality-reports/tests.json"), "utf8"));
  expect(testsReport.evidence_bundle.status).toBe("complete");
  expect(testsReport.coverage_ledger).toBeDefined();
  expect(testsReport.qc_summary).toBeDefined();
  const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");
  expect(trace.match(/"event":"agent_call"/g)).toHaveLength(10);
  expect(trace).toContain('"event":"run_end"');
  expect(existsSync(join(runDir, "run-report.md"))).toBe(true);
  const docs = JSON.parse(readFileSync(join(runDir, "documentation-report.json"), "utf8"));
  expect(docs.status).toBe("updated");
  expect(docs.changed_files).toContain("README.md");
}

function assertPendingMutation(output, runDir, checkpoint) {
  const control = JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8"));
  expect(control.status).toBe("waiting");
  expect(checkpoint.checkpoint_id).toMatch(/^checkpoint-[a-f0-9]{24}$/);
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("original\n");
  expect(readFileSync(join(runDir, "trace.jsonl"), "utf8")).toContain('"run_waiting"');
}

function approveCheckpoint(output, checkpoint) {
  run(process.execPath, [AUTONOMOUS, "resolve-checkpoint", "--project-root", output.workspace_root, "--run-id", output.run_id, "--checkpoint-id", checkpoint.checkpoint_id, "--decision", "approved", "--decision-id", "decision_approved_1", "--actor", "test-operator", "--rationale", "The owned mutation and verification plan were reviewed.", "--json"], PACKAGE_ROOT);
}

function assertApprovedResume(output, runDir) {
  const resumed = resumeBuild(output);
  expect(JSON.parse(resumed.stdout).success).toBe(true);
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("implemented\n");
  const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");
  expect(trace).toContain('"checkpoint_resolved"');
  expect(trace).toContain('"run_resumed"');
}

function rejectCheckpoint(output, checkpoint) {
  run(process.execPath, [AUTONOMOUS, "resolve-checkpoint", "--project-root", output.workspace_root, "--run-id", output.run_id, "--checkpoint-id", checkpoint.checkpoint_id, "--decision", "rejected", "--decision-id", "decision_rejected_1", "--actor", "test-operator", "--rationale", "The mutation was rejected.", "--json"], PACKAGE_ROOT);
}

function assertRejectedCheckpointCannotResume(output) {
  const override = run(process.execPath, [AUTONOMOUS, "resume", "--project-root", output.workspace_root, "--run-id", output.run_id, "--checkpoint-policy", "none", "--through", "build", "--json"], PACKAGE_ROOT, true);
  const ordinary = run(process.execPath, [AUTONOMOUS, "resume", "--project-root", output.workspace_root, "--run-id", output.run_id, "--through", "build", "--json"], PACKAGE_ROOT, true);
  expect(override.status).toBe(1);
  expect(override.stderr).toContain("checkpoint policy is immutable");
  expect(ordinary.status).toBe(1);
  expect(JSON.parse(ordinary.stdout).error).toContain("cannot resume after checkpoint");
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("original\n");
}

function plannedFixture(root) {
  const planned = run(process.execPath, [AUTONOMOUS, "run", "--project-root", root, "--task", "Implement the fixture value and document it.", "--through", "plan", "--provider", "command", "--agent-command", process.execPath, "--agent-arg", FAKE_AGENT, "--allow-unsafe-command-provider", "--json"], PACKAGE_ROOT);
  return JSON.parse(planned.stdout);
}

function resumeBuild(output, allowFailure = false) {
  return run(process.execPath, [AUTONOMOUS, "resume", "--project-root", output.workspace_root, "--run-id", output.run_id, "--through", "build", "--provider", "command", "--agent-command", process.execPath, "--agent-arg", FAKE_AGENT, "--allow-unsafe-command-provider", "--json"], PACKAGE_ROOT, allowFailure);
}

function assertResumeLockBlocks(output, lockPath) {
  writeFileSync(lockPath, '{"pid":999999}\n', "utf8");
  const blocked = resumeBuild(output, true);
  expect(blocked.status).toBe(1);
  expect(blocked.stderr).toContain("is already active");
}

function assertRestoredAgentConfiguration(output, lockPath) {
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("implemented\n");
  const request = JSON.parse(readFileSync(join(output.workspace_root, ".pipeline/runs", output.run_id, "request.json"), "utf8"));
  expect(request.agent.command).toBe(process.execPath);
  expect(request.agent.command_args).toEqual([FAKE_AGENT]);
  expect(existsSync(lockPath)).toBe(false);
}

function commitPreflightDrift(workspaceRoot) {
  writeFileSync(join(workspaceRoot, "preflight-drift.txt"), "drift\n", "utf8");
  run("git", ["add", "preflight-drift.txt"], workspaceRoot);
  run("git", ["-c", "user.name=RAE Test", "-c", "user.email=rae-test@example.invalid", "commit", "-m", "preflight drift"], workspaceRoot);
}

// The file exercises many independent ten-phase subprocess runs. Keep the suite
// budget bounded while allowing their cumulative wall time on slower CI hosts.
describe("autonomous coding-agent workflow", { timeout: 120_000 }, () => {
  it("requires and accepts fresh command-provider authorization when resuming", () => {
    const root = createRepository();
    const planOutput = plannedFixture(root);
    const lockPath = join(planOutput.workspace_root, ".pipeline/runs", planOutput.run_id, "autonomous.lock");
    assertResumeLockBlocks(planOutput, lockPath);
    unlinkSync(lockPath);
    run("git", ["branch", "unrelated-progress"], root);
    run("git", ["update-ref", "refs/remotes/origin/unrelated-progress", "HEAD"], root);
    const requestPath = join(planOutput.workspace_root, ".pipeline/runs", planOutput.run_id, "request.json");
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    writeFileSync(requestPath, `${JSON.stringify({ ...request, agent: { ...request.agent, command: "/poison/provider", command_args: ["poison.mjs"], allow_unsafe_command_provider: true } })}\n`, "utf8");
    const missingFreshOptIn = run(process.execPath, [AUTONOMOUS, "resume", "--project-root", planOutput.workspace_root, "--run-id", planOutput.run_id, "--through", "build", "--provider", "command", "--agent-command", process.execPath, "--agent-arg", FAKE_AGENT, "--json"], PACKAGE_ROOT, true);
    expect(missingFreshOptIn.status).toBe(1);
    expect(missingFreshOptIn.stderr).toContain("requires --allow-unsafe-command-provider");
    const resumedOutput = JSON.parse(resumeBuild(planOutput).stdout);
    assertRestoredAgentConfiguration(resumedOutput, lockPath);
  });

  it("rejects a sensitive shared ref added while a run is paused", () => {
    const root = createRepository();
    const planned = run(
      process.execPath,
      [
        AUTONOMOUS,
        "run",
        "--project-root",
        root,
        "--task",
        "Implement the fixture value and document it.",
        "--through",
        "plan",
        "--provider",
        "command",
        "--agent-command",
        process.execPath,
        "--agent-arg",
        FAKE_AGENT,
        "--allow-unsafe-command-provider",
        "--json",
      ],
      PACKAGE_ROOT,
    );
    const output = JSON.parse(planned.stdout);
    const head = run("git", ["rev-parse", "HEAD"], root).stdout.trim();
    const tree = run("git", ["rev-parse", "HEAD^{tree}"], root).stdout.trim();
    const replacement = run("git", ["commit-tree", tree, "-m", "replacement"], root).stdout.trim();
    run("git", ["update-ref", `refs/replace/${head}`, replacement], root);

    const resumed = run(
      process.execPath,
      [
        AUTONOMOUS,
        "resume",
        "--project-root",
        output.workspace_root,
        "--run-id",
        output.run_id,
        "--through",
        "build",
        "--json",
      ],
      PACKAGE_ROOT,
      true,
    );
    const resumedOutput = JSON.parse(resumed.stdout);
    expect(resumed.status).toBe(1);
    expect(resumedOutput.error).toContain("Git refs changed");
  });

  it("rejects run-branch drift before invoking a resumed provider", () => {
    const root = createRepository();
    const planOutput = plannedFixture(root);
    commitPreflightDrift(planOutput.workspace_root);
    const resumed = resumeBuild(planOutput, true);
    const output = JSON.parse(resumed.stdout);
    expect(resumed.status).toBe(1);
    expect(output.error).toContain("prohibited Git-state change after resume preflight");
    expect(readFileSync(join(planOutput.workspace_root, "src/value.txt"), "utf8")).toBe("original\n");
  });

  it("rejects the command provider without its explicit unsafe opt-in", () => {
    const root = createRepository();
    const proc = run(
      process.execPath,
      [
        AUTONOMOUS,
        "run",
        "--project-root",
        root,
        "--task",
        "Do not run this fixture.",
        "--provider",
        "command",
        "--agent-command",
        process.execPath,
        "--agent-arg",
        FAKE_AGENT,
        "--json",
      ],
      PACKAGE_ROOT,
      true,
    );

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("requires --allow-unsafe-command-provider");
    expect(existsSync(join(root, ".pipeline"))).toBe(false);
  });

  it("never reports the unsandboxed command provider as doctor-safe", () => {
    const proc = run(
      process.execPath,
      [
        AUTONOMOUS,
        "doctor",
        "--provider",
        "command",
        "--agent-command",
        process.execPath,
        "--allow-unsafe-command-provider",
      ],
      PACKAGE_ROOT,
      true,
    );
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.success).toBe(false);
    expect(output.available).toBe(true);
    expect(output.sandbox_enforced).toBe(false);
  });

  it("rejects a traversal run id from persisted resume state", () => {
    const root = createRepository();
    mkdirSync(join(root, ".pipeline/runs"), { recursive: true });
    writeFileSync(
      join(root, ".pipeline/pipeline-state.json"),
      `${JSON.stringify({ run_id: "../../escape" })}\n`,
      "utf8",
    );
    const proc = run(
      process.execPath,
      [AUTONOMOUS, "resume", "--project-root", root, "--run-id", "../../escape", "--json"],
      PACKAGE_ROOT,
      true,
    );

    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("must not contain path separators");
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});
