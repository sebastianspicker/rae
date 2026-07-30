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

function runAutonomous(root, task, allowFailure = false, extraArgs = []) {
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
      ...extraArgs,
    ],
    PACKAGE_ROOT,
    allowFailure,
  );
}

function _pauseBeforeBuild(root) {
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
  expect(readFileSync(join(output.workspace_root, "README.md"), "utf8")).toContain(
    "Implemented value",
  );
}

function assertSuccessfulArtifacts(output) {
  const state = JSON.parse(
    readFileSync(join(output.workspace_root, ".pipeline/pipeline-state.json"), "utf8"),
  );
  expect(state.completed_gates).toHaveLength(10);
  expect(state.completed_gates).toContain("post-build-gate");
  const runDir = join(output.workspace_root, ".pipeline/runs", output.run_id);
  const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8"));
  expect(request.policy.policy_id).toBe("default");
  expect(request.policy.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(request.policy.snapshot.phase_inputs.build).toContain("plan.json");
  expect(JSON.parse(readFileSync(join(runDir, "build.json"), "utf8")).outputs).toEqual([
    "README.md",
    "src/value.txt",
  ]);
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

function _assertPendingMutation(output, runDir, checkpoint) {
  const control = JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8"));
  expect(control.status).toBe("waiting");
  expect(checkpoint.checkpoint_id).toMatch(/^checkpoint-[a-f0-9]{24}$/);
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("original\n");
  expect(readFileSync(join(runDir, "trace.jsonl"), "utf8")).toContain('"run_waiting"');
}

function _approveCheckpoint(output, checkpoint) {
  run(
    process.execPath,
    [
      AUTONOMOUS,
      "resolve-checkpoint",
      "--project-root",
      output.workspace_root,
      "--run-id",
      output.run_id,
      "--checkpoint-id",
      checkpoint.checkpoint_id,
      "--decision",
      "approved",
      "--decision-id",
      "decision_approved_1",
      "--actor",
      "test-operator",
      "--rationale",
      "The owned mutation and verification plan were reviewed.",
      "--json",
    ],
    PACKAGE_ROOT,
  );
}

function _assertApprovedResume(output, runDir) {
  const resumed = resumeBuild(output);
  expect(JSON.parse(resumed.stdout).success).toBe(true);
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("implemented\n");
  const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");
  expect(trace).toContain('"checkpoint_resolved"');
  expect(trace).toContain('"run_resumed"');
}

function _rejectCheckpoint(output, checkpoint) {
  run(
    process.execPath,
    [
      AUTONOMOUS,
      "resolve-checkpoint",
      "--project-root",
      output.workspace_root,
      "--run-id",
      output.run_id,
      "--checkpoint-id",
      checkpoint.checkpoint_id,
      "--decision",
      "rejected",
      "--decision-id",
      "decision_rejected_1",
      "--actor",
      "test-operator",
      "--rationale",
      "The mutation was rejected.",
      "--json",
    ],
    PACKAGE_ROOT,
  );
}

function _assertRejectedCheckpointCannotResume(output) {
  const override = run(
    process.execPath,
    [
      AUTONOMOUS,
      "resume",
      "--project-root",
      output.workspace_root,
      "--run-id",
      output.run_id,
      "--checkpoint-policy",
      "none",
      "--through",
      "build",
      "--json",
    ],
    PACKAGE_ROOT,
    true,
  );
  const ordinary = run(
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
  expect(override.status).toBe(1);
  expect(override.stderr).toContain("checkpoint policy is immutable");
  expect(ordinary.status).toBe(1);
  expect(JSON.parse(ordinary.stdout).error).toContain("cannot resume after checkpoint");
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("original\n");
}

function _plannedFixture(root) {
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
  return JSON.parse(planned.stdout);
}

function resumeBuild(output, allowFailure = false) {
  return run(
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
    allowFailure,
  );
}

function _assertResumeLockBlocks(output, lockPath) {
  writeFileSync(lockPath, '{"pid":999999}\n', "utf8");
  const blocked = resumeBuild(output, true);
  expect(blocked.status).toBe(1);
  expect(blocked.stderr).toContain("is already active");
}

function _assertRestoredAgentConfiguration(output, lockPath) {
  expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe("implemented\n");
  const request = JSON.parse(
    readFileSync(
      join(output.workspace_root, ".pipeline/runs", output.run_id, "request.json"),
      "utf8",
    ),
  );
  expect(request.agent.command).toBe(process.execPath);
  expect(request.agent.command_args).toEqual([FAKE_AGENT]);
  expect(existsSync(lockPath)).toBe(false);
}

function _commitPreflightDrift(workspaceRoot) {
  writeFileSync(join(workspaceRoot, "preflight-drift.txt"), "drift\n", "utf8");
  run("git", ["add", "preflight-drift.txt"], workspaceRoot);
  run(
    "git",
    [
      "-c",
      "user.name=RAE Test",
      "-c",
      "user.email=rae-test@example.invalid",
      "commit",
      "-m",
      "preflight drift",
    ],
    workspaceRoot,
  );
}

// The file exercises many independent ten-phase subprocess runs. Keep the suite
// budget bounded while allowing their cumulative wall time on slower CI hosts.
describe("autonomous coding-agent workflow", { timeout: 120_000 }, () => {
  it("writes code and docs in an isolated worktree and completes every gate", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "Implement the fixture value and document it.");
    const output = JSON.parse(proc.stdout);
    assertSuccessfulWorkspace(output, root);
    assertSuccessfulArtifacts(output);
  });

  it("keeps graph retrieval opt-in and persists bounded phase context", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "Implement the fixture value and document it.", false, [
      "--through",
      "plan",
      "--graph-memory",
      "read",
    ]);
    const output = JSON.parse(proc.stdout);
    const runDir = join(output.workspace_root, ".pipeline", "runs", output.run_id);
    const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8"));
    expect(request.graph_memory).toBe("read");
    expect(existsSync(join(runDir, "graph", "manifest.json"))).toBe(true);
    const context = JSON.parse(
      readFileSync(join(runDir, "graph", "contexts", "plan.json"), "utf8"),
    );
    expect(context.limits).toEqual({ max_depth: 4, max_records: 50 });
    expect(context.records.length).toBeLessThanOrEqual(50);
    expect(
      context.records.every((record) =>
        ["authoritative", "verified-derived"].includes(record.trust_class),
      ),
    ).toBe(true);
  });

  it("records verified completed-run memory and quarantines model proposals", () => {
    const root = createRepository();
    const fakeBin = createFakeCodexBin();
    const proc = run(
      process.execPath,
      [
        AUTONOMOUS,
        "run",
        "--project-root",
        root,
        "--task",
        "Implement the fixture value and document it.",
        "--provider",
        "codex",
        "--legacy-linear",
        "--graph-memory",
        "read-write",
        "--json",
      ],
      PACKAGE_ROOT,
      false,
      { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` },
    );
    const output = JSON.parse(proc.stdout);
    const memoryRoot = join(root, ".git", "rae-memory", "v1");
    const facts = readFileSync(join(memoryRoot, "facts.jsonl"), "utf8");
    const candidates = readFileSync(join(memoryRoot, "candidates.jsonl"), "utf8");
    expect(facts).toContain('"kind":"GateDecision"');
    expect(candidates).toContain('"trust_class":"untrusted"');
    expect(
      readFileSync(
        join(output.workspace_root, ".pipeline", "runs", output.run_id, "request.json"),
        "utf8",
      ),
    ).toContain('"graph_memory": "read-write"');
  });

  it("honors a stop requested by the final provider before publishing completion", () => {
    const root = createRepository();
    const proc = runAutonomous(
      root,
      "Implement the fixture value and document it. STOP_DURING_PROVIDER_FIXTURE",
    );
    const output = JSON.parse(proc.stdout);
    const runDir = join(output.workspace_root, ".pipeline", "runs", output.run_id);
    const control = JSON.parse(readFileSync(join(runDir, "operator-control.json"), "utf8"));
    const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");

    expect(output.status).toBe("stopped-by-operator");
    expect(control.status).toBe("stopped");
    expect(trace).toContain('"run_stopped"');
    expect(trace).not.toContain('"run_completed"');
  });

  it("runs the Codex adapter contract and records command-event evidence", () => {
    const root = createRepository();
    const fakeBin = createFakeCodexBin();
    const proc = run(
      process.execPath,
      [
        AUTONOMOUS,
        "run",
        "--project-root",
        root,
        "--task",
        "Implement the fixture value and document it.",
        "--provider",
        "codex",
        "--legacy-linear",
        "--json",
      ],
      PACKAGE_ROOT,
      false,
      { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` },
    );
    const output = JSON.parse(proc.stdout);
    const runDir = join(output.workspace_root, ".pipeline/runs", output.run_id);
    const trace = readFileSync(join(runDir, "trace.jsonl"), "utf8");

    expect(output.success).toBe(true);
    expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe(
      "implemented\n",
    );
    expect(existsSync(join(runDir, "agent-outputs/build.events.jsonl"))).toBe(true);
    expect(existsSync(join(runDir, "agent-outputs/quality-tests.events.jsonl"))).toBe(true);
    expect(trace).toContain('"command_event_count":1');
    expect(readFileSync(join(runDir, "run-report.md"), "utf8")).toContain(
      "Agent execution evidence",
    );
  });

  it("blocks a build that changes a path outside plan ownership", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "OUT_OF_SCOPE_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.success).toBe(false);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("build gate failed");
    expect(existsSync(join(output.workspace_root, "unowned.txt"))).toBe(true);

    const gate = JSON.parse(
      readFileSync(
        join(output.workspace_root, ".pipeline/runs", output.run_id, "gates/build-gate.json"),
        "utf8",
      ),
    );
    expect(gate.status).toBe("fail");
    const state = JSON.parse(
      readFileSync(join(output.workspace_root, ".pipeline/pipeline-state.json"), "utf8"),
    );
    expect(state.completed_gates).not.toContain("build-gate");
  });

  it("rejects an unowned file hidden through private Git exclude state", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "PRIVATE_EXCLUDE_HIDE_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("Git private exclude or attributes state changed");
    expect(output.changed_files).toContain("unauthorized.txt");
    expect(output.changed_files).toContain("nested/.pipeline/hidden.txt");
    expect(existsSync(join(output.workspace_root, "unauthorized.txt"))).toBe(true);
    expect(existsSync(join(output.workspace_root, "nested/.pipeline/hidden.txt"))).toBe(true);
  });

  it("rejects provider mutation of the approved plan and protected runtime state", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "PIPELINE_PLAN_TAMPER_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("provider modified protected .pipeline state");
    expect(output.error).toContain("plan.json");
    expect(existsSync(join(output.workspace_root, "unowned.txt"))).toBe(true);
    const state = JSON.parse(
      readFileSync(join(output.workspace_root, ".pipeline/pipeline-state.json"), "utf8"),
    );
    expect(state.completed_gates).not.toContain("build-gate");
  });

  it("fails when a provider commits and hides its changes from ownership checks", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "COMMIT_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("prohibited Git-state change after build");
    expect(output.error).toContain("HEAD commit changed");
    expect(output.error).toContain("worktree HEAD reflog changed");
    expect(output.changed_files).toEqual([]);
    expect(run("git", ["status", "--short"], root).stdout).toBe("");
    expect(readFileSync(join(output.workspace_root, "src/value.txt"), "utf8")).toBe(
      "implemented\n",
    );
    expect(
      existsSync(
        join(output.workspace_root, ".pipeline/runs", output.run_id, "gates/build-gate.json"),
      ),
    ).toBe(false);
  });

  it("fails when a provider commits and resets to the original HEAD", () => {
    const root = createRepository();
    const initialHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();
    const proc = runAutonomous(root, "COMMIT_RESET_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("prohibited Git-state change after build");
    expect(output.error).toContain("worktree HEAD reflog changed");
    expect(output.error).not.toContain("HEAD commit changed");
    expect(run("git", ["rev-parse", "HEAD"], output.workspace_root).stdout.trim()).toBe(
      initialHead,
    );
    expect(run("git", ["status", "--short"], output.workspace_root).stdout).toBe("");
  });

  it("fails when a provider changes Git remote configuration", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "REMOTE_MUTATION_FIXTURE", true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("prohibited Git-state change after build");
    expect(output.error).toContain("Git local or worktree configuration changed");
  });

  it("fails when a provider redirects ownership through core.worktree", () => {
    const root = createRepository();
    const proc = runAutonomous(
      root,
      "Implement the fixture value. CORE_WORKTREE_MUTATION_FIXTURE",
      true,
    );
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.error).toMatch(
      /Git (?:top-level identity|local or worktree configuration) changed/,
    );
  });

  it.each([
    "TAG_MUTATION_FIXTURE",
    "OTHER_REF_MUTATION_FIXTURE",
  ])("fails when a provider changes another Git ref: %s", (task) => {
    const root = createRepository();
    const proc = runAutonomous(root, task, true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("prohibited Git-state change after build");
    expect(output.error).toContain("Git refs changed");
  });

  it.each([
    ["STAGE_FIXTURE", "staged content"],
    ["ASSUME_UNCHANGED_FIXTURE", "assume-unchanged"],
    ["SKIP_WORKTREE_FIXTURE", "skip-worktree"],
  ])("fails when a provider creates protected index state: %s (%s)", (task) => {
    const root = createRepository();
    const proc = runAutonomous(root, task, true);
    const output = JSON.parse(proc.stdout);

    expect(proc.status).toBe(1);
    expect(output.status).toBe("blocked");
    expect(output.error).toContain("prohibited Git-state change after build");
    expect(output.error).toContain("Git index state changed");
  });

  it("ignores fsmonitor cache churn while still discovering changed files", () => {
    const root = createRepository();
    const proc = runAutonomous(root, "FSMONITOR_VALID_FIXTURE");
    const output = JSON.parse(proc.stdout);

    expect(output.success).toBe(true);
    expect(output.changed_files).toContain("README.md");
    expect(output.changed_files).toContain("src/value.txt");
  });
});
