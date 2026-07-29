/**
 * Verifies pipeline initialization creates and validates isolated worktrees without leaking repository state.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveWorkspaceRootForRun } from "../lib/state.mjs";

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
  const prefix = `${field}:`;
  const line = output
    .split("\n")
    .map((candidate) => candidate.trimStart())
    .find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pipeline-init worktree mode", { timeout: 15_000 }, () => {
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
    expect(state.workspace.worktree_root).toBe(join(canonicalRepoRoot, ".worktrees"));
    expect(state.workspace.ownership_marker).toBe("rae-pipeline-worktree-v1");
    expect(state.config.feature_flags.worktree_isolation_v1).toBe(true);
    const tracePath = join(workspaceRoot, ".pipeline", "runs", runId, "trace.jsonl");
    const trace = readFileSync(tracePath, "utf8");
    expect(trace).toContain(`"workspace_mode":"git-worktree"`);
    expect(trace).toContain(`"workspace_root":"${workspaceRoot}"`);
    expect(trace).toContain(`"branch":"${branchName}"`);

    const cleanup = run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT);
    expect(cleanup.status).toBe(0);
    expect(existsSync(workspaceRoot)).toBe(false);

    const cleanupAgain = run(
      "bash",
      [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot],
      REPO_ROOT,
    );
    expect(cleanupAgain.status).toBe(0);
    expect(cleanupAgain.stdout).toContain("already-absent");

    const branchList = run("git", ["branch", "--list", branchName], repoRoot);
    expect(branchList.status).toBe(0);
    expect(branchList.stdout.trim()).toBe("");
  });
});

describe("pipeline-init worktree isolation", () => {
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

    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRootA], REPO_ROOT).status,
    ).toBe(0);
    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRootB], REPO_ROOT).status,
    ).toBe(0);
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

    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status,
    ).toBe(0);
  });
  it("refuses cleanup for an unowned or dirty worktree", () => {
    const repoRoot = makeGitRepo();
    const unowned = join(repoRoot, "unowned");
    mkdirSync(unowned, { recursive: true });
    writeFileSync(join(unowned, "keep.txt"), "keep\n", "utf8");

    const unownedCleanup = run("bash", [PIPELINE_INIT, "--cleanup-worktree", unowned], REPO_ROOT);
    expect(unownedCleanup.status).not.toBe(0);
    expect(existsSync(join(unowned, "keep.txt"))).toBe(true);

    const init = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);
    const workspaceRoot = parseField(init.stdout, "workspace_root");
    writeFileSync(join(workspaceRoot, "pending.txt"), "pending\n", "utf8");

    const dirtyCleanup = run(
      "bash",
      [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot],
      REPO_ROOT,
    );
    expect(dirtyCleanup.status).not.toBe(0);
    expect(dirtyCleanup.stderr).toContain("uncommitted changes");
    expect(existsSync(join(workspaceRoot, "pending.txt"))).toBe(true);
  });

  it("refuses cleanup for tracked changes inside the pipeline namespace", () => {
    const repoRoot = makeGitRepo();
    mkdirSync(join(repoRoot, ".pipeline"), { recursive: true });
    writeFileSync(join(repoRoot, ".pipeline", "tracked.txt"), "original\n", "utf8");
    expect(run("git", ["add", ".pipeline/tracked.txt"], repoRoot).status).toBe(0);
    expect(run("git", ["commit", "-m", "track pipeline fixture"], repoRoot).status).toBe(0);

    const init = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);
    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const trackedPath = join(workspaceRoot, ".pipeline", "tracked.txt");
    writeFileSync(trackedPath, "operator change\n", "utf8");

    const cleanup = run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT);
    expect(cleanup.status).not.toBe(0);
    expect(cleanup.stderr).toContain("uncommitted changes");
    expect(readFileSync(trackedPath, "utf8")).toBe("operator change\n");
  });

  it("refuses cleanup before removing a clean worktree with unmerged commits", () => {
    const repoRoot = makeGitRepo();
    const init = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);

    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const branchName = parseField(init.stdout, "branch");
    writeFileSync(join(workspaceRoot, "committed.txt"), "preserve me\n", "utf8");
    expect(run("git", ["add", "committed.txt"], workspaceRoot).status).toBe(0);
    expect(run("git", ["commit", "-m", "worktree change"], workspaceRoot).status).toBe(0);

    const refused = run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("commits not merged");
    expect(existsSync(workspaceRoot)).toBe(true);
    expect(run("git", ["branch", "--list", branchName], repoRoot).stdout).toContain(branchName);

    expect(run("git", ["merge", "--ff-only", branchName], repoRoot).status).toBe(0);
    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status,
    ).toBe(0);
  });

  it("resolves an isolated run from its primary repository", () => {
    const repoRoot = makeGitRepo();
    const init = run("bash", [PIPELINE_INIT, repoRoot, "--use-worktree"], REPO_ROOT);
    expect(init.status).toBe(0);

    const runId = parseField(init.stdout, "run_id");
    const workspaceRoot = parseField(init.stdout, "workspace_root");

    expect(resolveWorkspaceRootForRun(runId, repoRoot)).toBe(workspaceRoot);
    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status,
    ).toBe(0);
  });

  it("resolves a quoted custom worktree root and writes valid JSON", () => {
    const repoRoot = makeGitRepo();
    const customWorktreeRoot = mkdtempSync(join(tmpdir(), 'pipeline-"worktrees-'));
    tempRoots.push(customWorktreeRoot);

    const init = run(
      "bash",
      [PIPELINE_INIT, repoRoot, "--use-worktree", "--worktree-root", customWorktreeRoot],
      REPO_ROOT,
    );
    expect(init.status).toBe(0);

    const runId = parseField(init.stdout, "run_id");
    const workspaceRoot = parseField(init.stdout, "workspace_root");
    const state = JSON.parse(
      readFileSync(join(workspaceRoot, ".pipeline", "pipeline-state.json"), "utf8"),
    );
    const trace = readFileSync(
      join(workspaceRoot, ".pipeline", "runs", runId, "trace.jsonl"),
      "utf8",
    );

    expect(state.workspace.worktree_root).toBe(realpathSync(customWorktreeRoot));
    expect(JSON.parse(trace).metadata.workspace_root).toBe(workspaceRoot);
    expect(resolveWorkspaceRootForRun(runId, repoRoot)).toBe(workspaceRoot);

    expect(
      run("bash", [PIPELINE_INIT, "--cleanup-worktree", workspaceRoot], REPO_ROOT).status,
    ).toBe(0);
  });
});
