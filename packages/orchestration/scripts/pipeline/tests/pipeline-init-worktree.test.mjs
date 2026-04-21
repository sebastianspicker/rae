import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const PIPELINE_INIT = join(REPO_ROOT, "scripts/pipeline-init.sh");
const tempRoots = [];

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
  });
}

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "pipeline-init-worktree-"));
  tempRoots.push(root);

  expect(run("git", ["init"], root).status).toBe(0);
  expect(run("git", ["config", "user.name", "Test User"], root).status).toBe(0);
  expect(run("git", ["config", "user.email", "test@example.invalid"], root).status).toBe(0);
  writeFileSync(join(root, "README.md"), "# test\n", "utf8");
  expect(run("git", ["add", "README.md"], root).status).toBe(0);
  expect(run("git", ["commit", "-m", "init"], root).status).toBe(0);

  return root;
}

function parseField(output, field) {
  const match = output.match(new RegExp(`${field}:\\s+(.+)`));
  return match ? match[1].trim() : "";
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pipeline-init worktree mode", () => {
  it("creates an isolated worktree with workspace metadata and cleans it up idempotently", () => {
    const repoRoot = makeGitRepo();
    const canonicalRepoRoot = realpathSync(repoRoot);

    const init = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);

    const runId = parseField(init.stdout, "run_id");
    const workspaceMode = parseField(init.stdout, "workspace_mode");
    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const branchName = parseField(init.stdout, "branch");

    expect(runId).toBeTruthy();
    expect(workspaceMode).toBe("git-worktree");
    expect(workspaceRoot).toContain("/.worktrees/");
    expect(branchName).toContain(runId);

    const statePath = join(workspaceRoot, ".pipeline", "pipeline-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.workspace.mode).toBe("git-worktree");
    expect(state.workspace.root).toBe(workspaceRoot);
    expect(state.workspace.primary_repo_root).toBe(canonicalRepoRoot);
    expect(state.workspace.branch).toBe(branchName);
    expect(state.workspace.worktree_path).toBe(workspaceRoot);
    expect(state.config.feature_flags.worktree_isolation_v1).toBe(true);
    const tracePath = join(workspaceRoot, ".pipeline", "runs", runId, "trace.jsonl");
    const trace = readFileSync(tracePath, "utf8");
    expect(trace).toContain(`"workspace_mode":"git-worktree"`);
    expect(trace).toContain(`"workspace_root":"${workspaceRoot}"`);
    expect(trace).toContain(`"branch":"${branchName}"`);

    const cleanup = run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT);
    expect(cleanup.status).toBe(0);
    expect(existsSync(workspaceRoot)).toBe(false);

    const cleanupAgain = run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT);
    expect(cleanupAgain.status).toBe(0);
    expect(cleanupAgain.stdout).toContain("already-absent");

    const branchList = run("git", ["branch", "--list", branchName], repoRoot);
    expect(branchList.status).toBe(0);
    expect(branchList.stdout.trim()).toBe("");
  });

  it("creates two isolated runs without branch or workspace ambiguity", () => {
    const repoRoot = makeGitRepo();

    const initA = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    const initB = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(initA.status).toBe(0);
    expect(initB.status).toBe(0);

    const runIdA = parseField(initA.stdout, "run_id");
    const runIdB = parseField(initB.stdout, "run_id");
    const workspaceRootA = parseField(initA.stdout, "workspace_root");
    const workspaceRootB = parseField(initB.stdout, "workspace_root");
    const branchA = parseField(initA.stdout, "branch");
    const branchB = parseField(initB.stdout, "branch");

    expect(runIdA).not.toBe(runIdB);
    expect(workspaceRootA).not.toBe(workspaceRootB);
    expect(branchA).not.toBe(branchB);
    expect(existsSync(join(workspaceRootA, ".pipeline", "pipeline-state.json"))).toBe(true);
    expect(existsSync(join(workspaceRootB, ".pipeline", "pipeline-state.json"))).toBe(true);
    expect(existsSync(join(repoRoot, ".pipeline", "pipeline-state.json"))).toBe(false);

    const branchList = run("git", ["branch", "--list", branchA, branchB], repoRoot);
    expect(branchList.status).toBe(0);
    expect(branchList.stdout).toContain(branchA);
    expect(branchList.stdout).toContain(branchB);

    expect(run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRootA], REPO_ROOT).status).toBe(
      0,
    );
    expect(run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRootB], REPO_ROOT).status).toBe(
      0,
    );
    expect(existsSync(workspaceRootA)).toBe(false);
    expect(existsSync(workspaceRootB)).toBe(false);
  });

  it("normalizes a nested project root to the git toplevel for worktree mode", () => {
    const repoRoot = makeGitRepo();
    const canonicalRepoRoot = realpathSync(repoRoot);
    const nestedRoot = join(repoRoot, "packages", "orchestration");
    mkdirSync(nestedRoot, { recursive: true });

    const init = run("bash", [PIPELINE_INIT, nestedRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);

    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const statePath = join(workspaceRoot, ".pipeline", "pipeline-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));

    expect(state.workspace.mode).toBe("git-worktree");
    expect(state.workspace.primary_repo_root).toBe(canonicalRepoRoot);
    expect(state.workspace.root).toBe(workspaceRoot);
    expect(workspaceRoot).toContain(`${canonicalRepoRoot}/.worktrees/`);
    expect(existsSync(join(nestedRoot, ".pipeline", "pipeline-state.json"))).toBe(false);

    expect(run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status).toBe(
      0,
    );
  });

  it("resumes run commands against the isolated worktree from the primary repo", () => {
    const init = run("bash", [PIPELINE_INIT, REPO_ROOT, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);

    const runId = parseField(init.stdout, "run_id");
    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const runnerPath = join(REPO_ROOT, "scripts", "pipeline", "runner.mjs");

    const record = run(
      "node",
      [runnerPath, "record-review-state", "--run-id", runId, "--state", "explain", "--status", "completed"],
      REPO_ROOT,
    );
    expect(record.status).toBe(0);
    expect(existsSync(join(workspaceRoot, ".pipeline", "runs", runId, "review-loop.json"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, ".pipeline", "runs", runId, "review-loop.json"))).toBe(false);

    expect(run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status).toBe(0);
  });
});
