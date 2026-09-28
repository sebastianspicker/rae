#!/usr/bin/env node
/** Creates and safely cleans pipeline-owned worktrees using fd-relative state writes. */
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, readSync, realpathSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { openDirectoryAt, openFileAt, openParent, openRoot, renameAt } from "@rae/fs-bridge";

const PHASE_ORDER = [
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "release-readiness",
] as const;

interface InitOptions {
  projectRoot: string;
  useWorktree: boolean;
  worktreeRoot: string | null;
  branchPrefix: string;
  cleanupTarget: string | null;
}

interface OwnershipState {
  workspace?: {
    primary_repo_root?: string;
    worktree_root?: string;
    worktree_path?: string;
    ownership_marker?: string;
    branch?: string;
  };
}

interface ValidatedOwnership {
  primary_repo_root: string;
  worktree_root: string;
  worktree_path: string;
  ownership_marker: "rae-pipeline-worktree-v1";
  branch: string;
}

function usage(): string {
  return `Usage: rae-pipeline-init [project-root] [--use-worktree] [--worktree-root <path>] [--branch-prefix <prefix>]
       rae-pipeline-init --cleanup-worktree <path>

Options:
  --use-worktree            Create a dedicated git worktree for the run.
  --worktree-root <path>    Parent directory for worktrees. Default: <git-root>/.worktrees
  --branch-prefix <prefix>  Branch prefix for isolated worktrees. Default: pipeline
  --cleanup-worktree <path> Remove a clean, pipeline-owned worktree and its branch. Idempotent.
  -h, --help                Show this help.\n`;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`missing value for ${option}`);
  return value;
}

function parseArguments(args: string[]): InitOptions {
  const options: InitOptions = {
    projectRoot: ".",
    useWorktree: false,
    worktreeRoot: null,
    branchPrefix: "pipeline",
    cleanupTarget: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--use-worktree") options.useWorktree = true;
    else if (argument === "--worktree-root")
      options.worktreeRoot = requiredValue(args, index++, argument);
    else if (argument === "--branch-prefix")
      options.branchPrefix = requiredValue(args, index++, argument);
    else if (argument === "--cleanup-worktree")
      options.cleanupTarget = requiredValue(args, index++, argument);
    else if (argument === "-h" || argument === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    else options.projectRoot = argument;
  }
  return options;
}

function git(root: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readDescriptor(descriptor: number): string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) break;
    bytes += count;
    if (bytes > 1024 * 1024) throw new Error("Pipeline ownership state exceeds byte limit");
    chunks.push(chunk.subarray(0, count));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function readOwnershipState(worktree: string): OwnershipState {
  const root = openRoot(worktree);
  let pipeline = -1;
  let state = -1;
  try {
    pipeline = openDirectoryAt(root, ".pipeline");
    state = openFileAt(pipeline, "pipeline-state.json", "read");
    const parsed: unknown = JSON.parse(readDescriptor(state));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("pipeline ownership state must be an object");
    }
    return parsed as OwnershipState;
  } finally {
    if (state >= 0) closeSync(state);
    if (pipeline >= 0) closeSync(pipeline);
    closeSync(root);
  }
}

function assertOwnedCleanup(worktree: string, state: OwnershipState): ValidatedOwnership {
  const workspace = state.workspace;
  if (workspace?.ownership_marker !== "rae-pipeline-worktree-v1") {
    throw new Error("refusing cleanup: worktree is not marked as pipeline-owned");
  }
  const primary = workspace.primary_repo_root;
  const root = workspace.worktree_root;
  const declared = workspace.worktree_path;
  const branch = workspace.branch;
  if (!primary || !root || !declared || !branch) {
    throw new Error("refusing cleanup: incomplete pipeline ownership state");
  }
  const canonical: ValidatedOwnership = {
    primary_repo_root: realpathSync(primary),
    worktree_root: realpathSync(root),
    worktree_path: realpathSync(declared),
    ownership_marker: workspace.ownership_marker,
    branch,
  };
  if (canonical.worktree_path !== worktree) {
    throw new Error("refusing cleanup: target does not match owned worktree path");
  }
  const inside = relative(canonical.worktree_root, worktree);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("refusing cleanup: target is outside owned worktree root");
  }
  return canonical;
}

function assertCleanOwnedWorktree(worktree: string): void {
  if (
    !gitSucceeds(worktree, ["diff", "--quiet", "--ignore-submodules", "--", "."]) ||
    !gitSucceeds(worktree, ["diff", "--cached", "--quiet", "--ignore-submodules", "--", "."])
  ) {
    throw new Error("refusing cleanup: owned worktree has uncommitted changes");
  }
  const untracked = [
    git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
    git(worktree, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
  ]
    .join("")
    .split("\0")
    .filter(Boolean);
  const unsafe = untracked.find(
    (entry) => entry !== ".pipeline/pipeline-state.json" && !entry.startsWith(".pipeline/runs/"),
  );
  if (unsafe)
    throw new Error(`refusing cleanup: owned worktree has uncommitted changes at: ${unsafe}`);
}

function cleanupWorktree(target: string): void {
  let worktree: string;
  try {
    worktree = realpathSync(resolve(target));
  } catch {
    process.stdout.write(
      `Worktree cleanup:\n  worktree_path: ${resolve(target)}\n  status:        already-absent\n`,
    );
    return;
  }
  const workspace = assertOwnedCleanup(worktree, readOwnershipState(worktree));
  const primary = workspace.primary_repo_root;
  const registered = git(primary, ["worktree", "list", "--porcelain"])
    .split("\n")
    .includes(`worktree ${worktree}`);
  if (!registered)
    throw new Error("refusing cleanup: target is not registered by the primary repository");
  if (git(worktree, ["branch", "--show-current"], true) !== workspace.branch) {
    throw new Error("refusing cleanup: branch ownership does not match");
  }
  assertCleanOwnedWorktree(worktree);
  git(primary, ["merge-base", "--is-ancestor", `refs/heads/${workspace.branch}`, "HEAD"]);
  git(primary, ["worktree", "remove", "--force", worktree]);
  git(primary, ["branch", "-d", "--", workspace.branch]);
  process.stdout.write(
    `Worktree cleanup:\n  worktree_path: ${worktree}\n  branch:        ${workspace.branch}\n  status:        removed\n`,
  );
}

function writeAll(descriptor: number, body: string): void {
  const bytes = Buffer.from(body);
  let offset = 0;
  while (offset < bytes.length)
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  fsyncSync(descriptor);
}

function atomicWriteAt(root: number, path: string, body: string): void {
  const parent = openParent(root, path, true);
  const temporary = `.${parent.name.toString("hex")}.${randomUUID()}.tmp`;
  let descriptor = -1;
  try {
    descriptor = openFileAt(parent.fd, temporary, "create");
    writeAll(descriptor, body);
    closeSync(descriptor);
    descriptor = -1;
    renameAt(parent.fd, temporary, parent.fd, parent.name, false);
    fsyncSync(parent.fd);
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    closeSync(parent.fd);
  }
}

function pipelineState(
  runId: string,
  createdAt: string,
  workspace: Record<string, unknown>,
  useWorktree: boolean,
): Record<string, unknown> {
  return {
    run_id: runId,
    created_at: createdAt,
    current_phase: "arm",
    workspace,
    phase_order: PHASE_ORDER,
    completed_gates: [],
    artifacts: {
      brief: null,
      design: null,
      review: null,
      review_loop: null,
      plan: null,
      build: null,
      post_build: null,
      release_readiness: null,
      progress_summary: null,
      drift_reports: [],
      quality_reports: [],
    },
    config: {
      cognitive_tiers: {
        arm: "high_reasoning",
        design: "balanced",
        adversarial_review_lead: "high_reasoning",
        adversarial_review_reviewers: "fast",
        plan: "balanced",
        pmatch_extractors: "fast",
        pmatch_adjudicator: "balanced",
        build_lead: "balanced",
        build_worker: "fast",
        quality_static: "fast",
        quality_tests: "fast",
        post_build: "fast",
        release_readiness: "high_reasoning",
      },
      activity_assignments: Object.fromEntries(
        [
          ["arm_briefing", "high_reasoning", "brief-architect"],
          ["design_synthesis", "balanced", "design-synthesizer"],
          ["adversarial_review_lead", "high_reasoning", "review-lead"],
          ["plan_synthesis", "balanced", "plan-synthesizer"],
          ["pmatch_adjudicator", "balanced", "drift-adjudicator"],
          ["build_worker", "fast", "build-worker"],
          ["quality_static", "fast", "quality-static"],
          ["quality_tests_case", "fast", "quality-tests"],
          ["post_build", "fast", "post-build"],
          ["release_readiness", "high_reasoning", "release-readiness"],
        ].map(([name, tier, model]) => [
          name,
          { tier, model_hint: model, runtime_name: "default", runtime_version: "v1" },
        ]),
      ),
      post_build: [
        "denoise",
        "quality-frontend",
        "quality-backend",
        "quality-docs",
        "security-review",
      ],
      context_budgets: {
        design: 24000,
        "adversarial-review": 18000,
        plan: 16000,
        pmatch: 12000,
        build_lead: 10000,
        build_worker: 8000,
      },
      feature_flags: {
        trace_v1: true,
        context_budget_v1: true,
        traceability_v1: true,
        worktree_isolation_v1: useWorktree,
        activity_routing_v1: true,
      },
    },
  };
}

function initialize(options: InitOptions): void {
  let projectRoot = realpathSync(resolve(options.projectRoot));
  let workspaceRoot = projectRoot;
  let primaryRoot = projectRoot;
  let mode = "main-repo";
  let branch = git(projectRoot, ["branch", "--show-current"], true);
  let worktreeRoot: string | null = null;
  const runId = randomUUID().toLowerCase();
  if (options.useWorktree) {
    const gitRoot = git(projectRoot, ["rev-parse", "--show-toplevel"], true);
    if (!gitRoot) throw new Error("--use-worktree requires a git repository");
    primaryRoot = realpathSync(gitRoot);
    worktreeRoot = resolve(options.worktreeRoot ?? resolve(primaryRoot, ".worktrees"));
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
    worktreeRoot = realpathSync(worktreeRoot);
    branch = `${options.branchPrefix}/${runId}`;
    workspaceRoot = resolve(worktreeRoot, runId);
    git(primaryRoot, ["worktree", "add", "-b", branch, workspaceRoot, "HEAD"]);
    projectRoot = primaryRoot;
    mode = "git-worktree";
  }
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const root = openRoot(workspaceRoot);
  let pipeline = -1;
  try {
    pipeline = openDirectoryAt(root, ".pipeline", true);
    for (const suffix of ["drift-reports", "quality-reports", "gates"]) {
      const parent = openParent(pipeline, `runs/${runId}/${suffix}`, true);
      closeSync(openDirectoryAt(parent.fd, parent.name, true));
      closeSync(parent.fd);
    }
    const runDirectory = `.pipeline/runs/${runId}`;
    const workspace = {
      mode,
      root: workspaceRoot,
      primary_repo_root: primaryRoot,
      branch,
      worktree_path: options.useWorktree ? workspaceRoot : null,
      worktree_root: worktreeRoot,
      ownership_marker: options.useWorktree ? "rae-pipeline-worktree-v1" : null,
      cleanup_command: options.useWorktree
        ? `node ${process.argv[1]} --cleanup-worktree ${JSON.stringify(workspaceRoot)}`
        : null,
    };
    atomicWriteAt(
      root,
      `${runDirectory}/trace.jsonl`,
      `${JSON.stringify({
        ts: createdAt,
        run_id: runId,
        event: "run_start",
        phase: "arm",
        status: "ok",
        metadata: {
          source: "pipeline-init",
          workspace_mode: mode,
          workspace_root: workspaceRoot,
          primary_repo_root: primaryRoot,
          branch,
        },
      })}\n`,
    );
    atomicWriteAt(
      root,
      ".pipeline/pipeline-state.json",
      `${JSON.stringify(pipelineState(runId, createdAt, workspace, options.useWorktree), null, 2)}\n`,
    );
    process.stdout.write(
      `Pipeline initialized:\n  run_id:         ${runId}\n  workspace_mode: ${mode}\n  workspace_root: ${workspaceRoot}\n  primary_root:   ${projectRoot}\n  branch:         ${branch}\n  run_dir:        ${resolve(workspaceRoot, runDirectory)}\n  trace:          ${resolve(workspaceRoot, runDirectory, "trace.jsonl")}\n  state:          ${resolve(workspaceRoot, ".pipeline/pipeline-state.json")}\n\nNext step:\n  ${options.useWorktree ? `cd ${JSON.stringify(workspaceRoot)} && ` : ""}rae-pipeline run-stage --run-id ${runId} --phase arm\n`,
    );
  } finally {
    if (pipeline >= 0) closeSync(pipeline);
    closeSync(root);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.cleanupTarget) cleanupWorktree(options.cleanupTarget);
  else initialize(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}
