#!/usr/bin/env node
/** Implements Ralph's command-line lifecycle and stable exit-code contract. */
import { accessSync, existsSync, readFileSync, constants } from "node:fs";
import { join, relative } from "node:path";
import { syncBranch } from "./branch.js";
import { EXIT, RalphError, errorMessage } from "./errors.js";
import { assertNodeVersion, parseArgs, resolvePaths, USAGE, VERSION } from "./config.js";
import { Logger } from "./logger.js";
import { archiveState } from "./helper.js";
import { RunLock, lockState } from "./lock.js";
import { applyDefaults, loadPrd, openStories } from "./prd.js";
import {
  aggregateReports,
  appendProgress,
  clearFailure,
  exportState,
  importState,
  incrementFailure,
  resetSkipped,
  resetStory,
  skipStory,
  writeProgress,
} from "./state.js";
import { modelPreflight, processStory } from "./runner.js";
import { CONTAINMENT_EXIT } from "./supervisor.js";
import { securityPreflight } from "./preflight.js";
import { recoverTransaction } from "./transaction.js";
import { appendRelative, atomicWriteRelative } from "./safe-fs.js";
import type { CliOptions, Mode, Prd, RuntimePaths, Story } from "./types.js";

function ensureRuntimeFiles(paths: RuntimePaths): void {
  for (const path of [paths.runLog, paths.eventLog])
    appendRelative(paths.repoRoot, relative(paths.repoRoot, path).split("\\").join("/"), "");
}

function status(paths: RuntimePaths, prd: Prd, mode: Mode, options: CliOptions): void {
  const passed = prd.stories.filter((story) => story.passes).length;
  const skipped = prd.stories.filter((story) => story.skipped).length;
  const remaining = prd.stories.length - passed - skipped;
  const open = openStories(prd, mode);
  const next = open[0];
  const lock = lockState(paths);
  if (options.statusFormat === "json") {
    process.stdout.write(
      `${JSON.stringify({ command: "status", mode, stories: { total: prd.stories.length, passed, skipped, remaining_total: remaining, remaining_mode: open.length }, next: { id: next?.id ?? null, priority: next?.priority ?? null }, lock })}\n`,
    );
  } else if (options.statusFormat === "compact")
    process.stdout.write(
      `mode=${mode} stories=${prd.stories.length}/${passed}/${skipped}/${remaining} next=${next?.id ?? "(none)"} lock=${lock.held ? "held" : "not_held"}\n`,
    );
  else
    process.stdout.write(
      `Mode: ${mode}\nStories: ${prd.stories.length} total, ${passed} passed, ${skipped} skipped, ${remaining} remaining\nOpen in mode (${mode}): ${open.length}\nNext: ${next ? `${next.id} (priority ${next.priority})` : "(none)"}\nLock: ${lock.status}\n`,
    );
}

function listStories(prd: Prd, mode: Mode, options: CliOptions): void {
  const stories = openStories(prd, mode);
  if (options.listFormat === "json")
    process.stdout.write(
      `${JSON.stringify(stories.map(({ id, priority, mode: storyMode, title }) => ({ id, priority, mode: storyMode, title })))}\n`,
    );
  else
    for (const story of stories)
      process.stdout.write(
        options.listFormat === "ids"
          ? `${story.id}\n`
          : options.listFormat === "id+title"
            ? `${story.id}\t${story.title}\n`
            : `${story.id}\tpriority=${story.priority}\tmode=${story.mode}\t${story.title}\n`,
      );
}

function codexStatus(): "found" | "missing" {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    try {
      accessSync(join(directory, "codex"), constants.X_OK);
      return "found";
    } catch {
      /* keep searching */
    }
  }
  return "missing";
}

function validateConfig(paths: RuntimePaths, prd: Prd, mode: Mode, options: CliOptions): void {
  const tool = codexStatus();
  const lock = lockState(paths);
  if (options.outputFormat === "json")
    process.stdout.write(
      `${JSON.stringify({ command: "validate-config", ok: true, mode, checks: { prd: "ok", jq: "ok", mktemp: "ok", python: "ok", node: "ok", fs_bridge: "ok", tool, lock: lock.held ? "held" : "not_held" } })}\n`,
    );
  else
    process.stderr.write(
      `[ralph] Checklist: PRD ok, Node ok, fs bridge ok, codex ${tool}, lock ${lock.held ? "held" : "not held"}\n`,
    );
  void prd;
}

function doctor(paths: RuntimePaths, prd: Prd, mode: Mode, options: CliOptions): void {
  const lock = lockState(paths);
  const reportDir = prd.defaults.report_dir;
  const ready =
    Boolean(reportDir) && !reportDir.startsWith("/") && !reportDir.split("/").includes("..");
  const result = {
    command: "doctor",
    mode,
    paths: {
      repo_root: paths.repoRoot,
      package_root: paths.packageRoot,
      script_dir: paths.packageRoot,
      prd_file: paths.prdFile,
      state_dir: paths.stateDir,
    },
    dependencies: {
      tool: codexStatus(),
      python: "not-required",
      jq: "not-required",
      mktemp: "not-required",
      node: process.versions.node,
      fs_bridge: "found",
    },
    lock,
    strict_report_dir: {
      enabled: options.strictReportDir,
      default_report_dir: reportDir || null,
      ready,
      reason: ready ? null : "defaults.report_dir is unsafe",
    },
  };
  if (options.outputFormat === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
  else
    process.stdout.write(
      `Doctor Report\nMode: ${mode}\nRepo root: ${paths.repoRoot}\nPackage root: ${paths.packageRoot}\nPRD file: ${paths.prdFile}\nState dir: ${paths.stateDir}\nDependencies: codex=${result.dependencies.tool} node=${process.versions.node} fs_bridge=found\nLock: ${lock.status}\nStrict report dir: ${options.strictReportDir ? (ready ? `enabled (ready, defaults.report_dir=${reportDir})` : "enabled (not ready)") : "disabled"}\n`,
    );
}

function maybeAutoArchive(
  prd: Prd,
  paths: RuntimePaths,
  mode: Mode,
  options: CliOptions,
  logger: Logger,
): void {
  if (mode !== "fixing") {
    logger.event("INFO", `auto_archive_skipped mode=${mode}`);
    return;
  }
  const current = prd.project || "unknown-project";
  const tracking = join(paths.stateDir, ".last-project");
  let previous = "";
  try {
    previous = readFileSync(tracking, "utf8").trim();
  } catch {
    /* first run */
  }
  if (options.autoArchive && previous && previous !== current) {
    archiveState(
      paths.packageRoot,
      join(paths.packageRoot, "archive"),
      previous,
      `auto-archive on project change (${previous} -> ${current})`,
    );
    logger.event("INFO", `auto_archive_on_project_change previous=${previous} current=${current}`);
  }
  const relativeTracking = relative(paths.repoRoot, tracking).split("\\").join("/");
  atomicWriteRelative(paths.repoRoot, relativeTracking, `${current}\n`);
}

function readonlyAction(action: CliOptions["action"]): boolean {
  return action === "check" || action === "doctor";
}

interface CommandContext {
  options: CliOptions;
  paths: RuntimePaths;
  logger: Logger;
  prd: Prd;
  mode: Mode;
  sandbox: string;
  maximum: number;
}
function commandContext(argv: string[]): CommandContext {
  const options = parseArgs(argv);
  const paths = resolvePaths(readonlyAction(options.action));
  if (!readonlyAction(options.action)) ensureRuntimeFiles(paths);
  const logger = new Logger(paths, options, !readonlyAction(options.action));
  const prd = loadPrd(paths);
  const defaults = applyDefaults(prd, options);
  options.mode = defaults.mode;
  options.model = defaults.model;
  options.reasoningEffort = defaults.reasoningEffort;
  const mode = defaults.mode;
  const sandbox = prd.defaults.sandbox_by_mode[mode];
  if (sandbox !== (mode === "fixing" ? "workspace-write" : "read-only"))
    throw new RalphError(`Invalid sandbox_by_mode mapping for mode=${mode}`, EXIT.prd);
  const configured = options.maxStoriesExplicit ? options.maxStories : defaults.maxStories;
  const maximum =
    configured === "all_open" || configured === undefined
      ? openStories(prd, mode).length
      : configured;
  return { options, paths, logger, prd, mode, sandbox, maximum };
}
function queryCommand({ options, paths, logger, prd, mode }: CommandContext): boolean {
  switch (options.action) {
    case "validate-prd":
      logger.log("PRD validation passed.");
      break;
    case "status":
      status(paths, prd, mode, options);
      break;
    case "list-stories":
      listStories(prd, mode, options);
      break;
    case "validate-config":
      validateConfig(paths, prd, mode, options);
      break;
    case "check":
      validateConfig(paths, prd, mode, options);
      status(paths, prd, mode, options);
      break;
    case "doctor":
      doctor(paths, prd, mode, options);
      break;
    case "aggregate-reports": {
      const output = aggregateReports(paths, prd);
      logger.log(
        output ? `Wrote report summary to ${output}` : "No report directory; skipping aggregation.",
      );
      break;
    }
    case "export-state":
      process.stdout.write(`${JSON.stringify(exportState(prd))}\n`);
      break;
    default:
      return false;
  }
  return true;
}
function stateCommand({ options, paths, logger, prd }: CommandContext): boolean {
  switch (options.action) {
    case "import-state":
      importState(paths, prd, options.actionValue ?? "");
      logger.log(`Imported story state from ${options.actionValue ?? ""}`);
      break;
    case "reset-story":
      resetStory(paths, prd, options.actionValue ?? "");
      logger.log(`Story ${options.actionValue ?? ""} has been reset.`);
      break;
    case "retry-failed": {
      const count = resetSkipped(paths, prd);
      logger.log(count ? `Reset ${count} skipped stories for retry.` : "No skipped stories found.");
      break;
    }
    default:
      return false;
  }
  return true;
}
function refreshProgress({ options, paths, logger, prd }: CommandContext): void {
  const path = join(paths.packageRoot, "progress.txt");
  if (!options.autoProgressRefresh || !existsSync(path)) return;
  try {
    writeProgress(paths, prd);
    logger.event("INFO", `progress_snapshot_refreshed path=${path}`);
  } catch {
    logger.event("WARN", `progress_snapshot_refresh_failed path=${path}`);
  }
}
function completeStory(context: CommandContext, story: Story): void {
  refreshProgress(context);
  const { options, paths, mode, logger } = context;
  if (!options.autoProgressLog) return;
  try {
    appendProgress(paths, story, mode, story.report_path ?? "");
    logger.event("INFO", `progress_log_appended story=${story.id}`);
  } catch {
    logger.event("WARN", `progress_log_append_failed story=${story.id}`);
  }
}
function failedStory(context: CommandContext, story: Story, code: number): void {
  const { options, paths, logger, mode, prd } = context;
  logger.event("STORY_FAIL", `id=${story.id} mode=${mode} rc=${code}`);
  if (code === CONTAINMENT_EXIT)
    throw new RalphError(
      "Provider containment is uncertain; further stories are stopped and recovery evidence is retained",
      EXIT.scope,
    );
  if (options.skipAfterFailures <= 0)
    throw new RalphError(
      `Codex exec failed for story ${story.id} (rc=${code}, see ${paths.runLog} for redacted details)`,
      EXIT.tool,
    );
  const failures = incrementFailure(paths, story.id);
  if (failures < options.skipAfterFailures)
    throw new RalphError(
      `Codex exec failed for story ${story.id} (rc=${code}, failure_count=${failures} skip_after=${options.skipAfterFailures})`,
      EXIT.tool,
    );
  const reason = `Skipped after ${failures} failed runs (last_rc=${code})`;
  skipStory(paths, prd, story.id, reason);
  clearFailure(paths, story.id);
  refreshProgress(context);
  logger.event("STORY_SKIPPED", `id=${story.id} reason=${reason}`);
  logger.log(`story=${story.id} skipped after repeated failures (count=${failures} rc=${code})`);
}
async function executeStory(context: CommandContext, story: Story): Promise<number> {
  const { paths, prd, mode, sandbox, options, logger } = context;
  try {
    return await processStory(paths, prd, story, mode, sandbox, options, logger);
  } catch (error) {
    if (error instanceof RalphError && error.exitCode !== EXIT.tool) throw error;
    return EXIT.tool;
  }
}
function summarize(
  context: CommandContext,
  processed: number,
  passed: number,
  started: number,
): void {
  const { prd, mode, logger } = context;
  const remaining = openStories(prd, mode).length;
  const elapsed = Math.floor((Date.now() - started) / 1000);
  logger.log(
    `summary processed=${processed} passed=${passed} remaining=${remaining} mode=${mode} tool=codex elapsed=${elapsed}s`,
  );
  logger.event(
    "RUN_END",
    `processed=${processed} passed=${passed} remaining=${remaining} mode=${mode} tool=codex elapsed_seconds=${elapsed}`,
  );
  if (remaining === 0) {
    process.stdout.write("<promise>COMPLETE</promise>\n");
    logger.log("All stories complete.");
  }
}
async function runStories(context: CommandContext): Promise<void> {
  const { options, paths, logger, prd, mode, sandbox, maximum } = context;
  recoverTransaction(paths);
  securityPreflight(options, logger);
  maybeAutoArchive(prd, paths, mode, options, logger);
  syncBranch(prd, paths, mode, options, logger);
  if (maximum > 0) await modelPreflight(paths, options, mode, sandbox, logger);
  if (options.signal?.aborted) return;
  logger.log(`start mode=${mode} tool=codex max_stories=${maximum} sandbox=${sandbox}`);
  logger.event(
    "RUN_START",
    `mode=${mode} tool=codex max_stories=${maximum} sandbox=${sandbox} search=${options.search}`,
  );
  const started = Date.now();
  let processed = 0,
    passed = 0;
  while (processed < maximum) {
    const story = openStories(prd, mode)[0];
    if (!story) break;
    processed++;
    logger.log(`Processing story ${processed}/${maximum} (${story.id})`);
    const code = await executeStory(context, story);
    if (options.signal?.aborted && code !== CONTAINMENT_EXIT) return;
    if (code !== 0) failedStory(context, story, code);
    else if (options.action !== "dry-run") {
      passed++;
      completeStory(context, story);
    }
    if (options.action === "dry-run") break;
  }
  summarize(context, processed, passed, started);
}
async function runLocked(context: CommandContext): Promise<number> {
  const { paths, options } = context;
  const lock = new RunLock(paths, options.staleLockSeconds);
  lock.acquire();
  const cancellation = new AbortController();
  options.signal = cancellation.signal;
  let interruption = 0;
  const interrupt = (): void => {
    interruption ||= 130;
    cancellation.abort();
  };
  const terminate = (): void => {
    interruption ||= 143;
    cancellation.abort();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    if (stateCommand(context)) return 0;
    await runStories(context);
    return interruption;
  } catch (error) {
    if (interruption && !(error instanceof RalphError && error.exitCode === EXIT.scope))
      return interruption;
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    lock.release();
  }
}
async function runMain(argv: string[]): Promise<number> {
  assertNodeVersion();
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("--version")) {
    process.stdout.write(`ralph ${VERSION}\n`);
    return 0;
  }
  const context = commandContext(argv);
  return queryCommand(context) ? 0 : runLocked(context);
}

runMain(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const exit = error instanceof RalphError ? error.exitCode : EXIT.general;
    process.stderr.write(`[ralph][ERROR] ${errorMessage(error)}\n`);
    process.exitCode = exit;
  });
