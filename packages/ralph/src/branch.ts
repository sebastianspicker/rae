/** Synchronizes fixing runs to the optional PRD branch without shell evaluation. */
import { execFileSync } from "node:child_process";
import { EXIT, RalphError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { CliOptions, Mode, Prd, RuntimePaths } from "./types.js";

export function syncBranch(
  prd: Prd,
  paths: RuntimePaths,
  mode: Mode,
  options: CliOptions,
  logger: Logger,
): void {
  if (mode !== "fixing") {
    logger.event("INFO", `branch_sync_skipped mode=${mode}`);
    return;
  }
  if (!options.syncBranch) return;
  const target = prd.branch_name ?? prd.branchName;
  if (!target) {
    logger.event("INFO", "branch_sync_requested_but_no_prd_branch");
    return;
  }
  if (target.startsWith("-") || target.includes("..") || /[\r\n]/u.test(target))
    throw new RalphError("Unsafe branch name from PRD", EXIT.general);
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", paths.repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("rev-parse", "--is-inside-work-tree");
  } catch {
    throw new RalphError("Branch sync requested outside git worktree", EXIT.general);
  }
  if (git("rev-parse", "--abbrev-ref", "HEAD") === target) return;
  let exists = false;
  try {
    git("show-ref", "--verify", `refs/heads/${target}`);
    exists = true;
  } catch {
    /* absent local branch */
  }
  if (exists) {
    try {
      git("checkout", target);
    } catch {
      throw new RalphError(`Failed to checkout branch from PRD: ${target}`, EXIT.general);
    }
    logger.event("INFO", `branch_sync_checked_out_existing branch=${target}`);
    return;
  }
  let base = "";
  for (const candidate of ["main", "master"]) {
    try {
      git("show-ref", "--verify", `refs/heads/${candidate}`);
      base = candidate;
      break;
    } catch {
      /* try the next conventional branch */
    }
  }
  try {
    git("checkout", "-b", target, ...(base ? [base] : []));
  } catch {
    throw new RalphError(`Failed to create branch from PRD: ${target}`, EXIT.general);
  }
  logger.event("INFO", `branch_sync_created branch=${target}${base ? ` base=${base}` : ""}`);
}
