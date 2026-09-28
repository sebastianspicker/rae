/** Runs one bounded provider attempt and persists a story through its transaction. */
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { EXIT, RalphError } from "./errors.js";
import { createdLine, extractReportPath, pathMatchesScope } from "./prd.js";
import { appendRelative, atomicWriteRelative, readRelative } from "./safe-fs.js";
import { buildPrompt } from "./prompt.js";
import { syncAgents } from "./helper.js";
import { clearFailure, markPassed } from "./state.js";
import {
  beginTransaction,
  prepareTransaction,
  promoteTransaction,
  recoverTransaction,
  transactionDiff,
  verifyTransaction,
} from "./transaction.js";
import {
  ABORT_EXIT,
  CONTAINMENT_EXIT,
  OVERFLOW_EXIT,
  REPORT_LIMIT,
  RAW_LIMIT,
  supervise,
} from "./supervisor.js";
import { safeRelativePath } from "./util.js";
import type { CliOptions, Mode, Prd, RuntimePaths, Story } from "./types.js";
import type { Logger } from "./logger.js";

const ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

function codexExecutable(repoRoot: string): string {
  let candidate: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, "codex");
    try {
      accessSync(path, constants.X_OK);
      candidate = path;
      break;
    } catch {
      /* continue */
    }
  }
  if (!candidate) throw new RalphError("Missing required command: codex", EXIT.tool);
  const real = realpathSync.native(candidate);
  const stat = statSync(real);
  if (!stat.isFile() || stat.nlink !== 1)
    throw new RalphError("Codex executable must be a regular non-linked file", EXIT.security);
  if (real === repoRoot || real.startsWith(`${repoRoot}/`))
    throw new RalphError("Codex executable must be outside the target repository", EXIT.security);
  return real;
}

function sanitizedEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PWD: cwd, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "codex_cli_rs" };
  for (const name of ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function redact(text: string): string {
  return text
    .replace(
      /((?:[A-Za-z_][A-Za-z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[:=]\s*["':]?)[^\s"'}{,]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:--?(?:token|secret|password|api-key|api_key|access-key|access_key|private-key|private_key))(?:\s+|=))\S+/giu,
      "$1[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/giu, "$1[REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/gu, "[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/gu, "[REDACTED]");
}

function reportContract(report: string, storyId: string, options: CliOptions): number {
  if (storyId === "MODEL_PREFLIGHT" || !options.search || !options.requireExternalReferences)
    return 0;
  if (!/^##\s+External References\s*$/mu.test(report)) return 41;
  if (!/\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/\S+|www\.\S+/u.test(report)) return 42;
  if (!/20\d{2}-\d{2}-\d{2}/u.test(report)) return 43;
  return 0;
}

async function runCodex(
  paths: RuntimePaths,
  storyId: string,
  prompt: string,
  toolRoot: string,
  mode: Mode,
  sandbox: string,
  options: CliOptions,
  logger: Logger,
): Promise<{ code: number; report: string }> {
  const executable = codexExecutable(paths.repoRoot);
  let lastCode = 1;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.signal?.aborted) return { code: ABORT_EXIT, report: "" };
    const temporary = mkdtempSync(join(paths.stateDir, `.codex-${storyId}-`));
    const raw = join(temporary, "raw.log");
    const report = join(temporary, "last-message.md");
    const args = [
      "-a",
      "never",
      ...(mode === "fixing" ? ["-c", "sandbox_workspace_write.writable_roots=[]"] : []),
      ...(options.search ? ["--search"] : []),
      "exec",
      "-C",
      toolRoot,
      "-s",
      sandbox,
      ...(options.model ? ["-m", options.model] : []),
      ...(options.reasoningEffort
        ? ["-c", `model_reasoning_effort="${options.reasoningEffort}"`]
        : []),
      "--output-last-message",
      report,
    ];
    try {
      lastCode = await supervise({
        command: executable,
        args,
        cwd: toolRoot,
        env: sanitizedEnv(toolRoot),
        input: Buffer.from(prompt),
        timeoutSeconds: options.timeoutSeconds,
        rawOutput: raw,
        report,
        rawLimit: RAW_LIMIT,
        reportLimit: REPORT_LIMIT,
        signal: options.signal,
      });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw new RalphError(
        `Could not launch Codex: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.tool,
      );
    }
    if (lastCode === CONTAINMENT_EXIT) {
      logger.event("ERROR", `story=${storyId} codex_containment_uncertain attempt=${attempt}`);
      return { code: lastCode, report: "" };
    }
    if (lastCode === ABORT_EXIT) {
      rmSync(temporary, { recursive: true, force: true });
      return { code: lastCode, report: "" };
    }
    let rawText: string, reportText: string;
    try {
      rawText = readRelative(temporary, "raw.log", RAW_LIMIT).toString("utf8");
      reportText = lastCode === 0 ? readOptionalReport(temporary) : "";
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw new RalphError(
        `Unsafe provider output: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.tool,
      );
    }
    if (lastCode === 0 && reportText.length)
      lastCode = reportContract(reportText, storyId, options);
    else if (lastCode === 0) lastCode = 44;
    const runLog = relative(paths.repoRoot, paths.runLog).split("\\").join("/");
    if (lastCode === 0) {
      if (options.captureToolOutput) appendRelative(paths.repoRoot, runLog, redact(rawText));
      rmSync(temporary, { recursive: true, force: true });
      return { code: 0, report: reportText };
    }
    appendRelative(paths.repoRoot, runLog, redact(rawText));
    if (lastCode === 124)
      logger.event("WARN", `story=${storyId} codex_deadline_exceeded attempt=${attempt}`);
    if (lastCode === OVERFLOW_EXIT)
      logger.event("WARN", `story=${storyId} codex_output_overflow attempt=${attempt}`);
    if (attempt === options.maxAttempts && rawText)
      process.stderr.write(
        `[ralph] codex failure excerpt (redacted):\n${redact(rawText).split("\n").slice(-25).join("\n")}\n`,
      );
    rmSync(temporary, { recursive: true, force: true });
    if (attempt < options.maxAttempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { code: lastCode, report: "" };
}

function readOptionalReport(directory: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      readRelative(directory, "last-message.md", REPORT_LIMIT),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function packagePrefix(paths: RuntimePaths): string {
  const value = relative(paths.repoRoot, paths.packageRoot).split("\\").join("/");
  return value ? `${safeRelativePath(value)}/` : "";
}

function signature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "__missing__";
  }
}

export async function modelPreflight(
  paths: RuntimePaths,
  options: CliOptions,
  mode: Mode,
  sandbox: string,
  logger: Logger,
): Promise<void> {
  if (!options.modelPreflight) return;
  const result = await runCodex(
    paths,
    "MODEL_PREFLIGHT",
    "Reply with exactly:\nMODEL_PREFLIGHT_OK\n",
    paths.repoRoot,
    mode,
    sandbox,
    options,
    logger,
  );
  if (result.code === CONTAINMENT_EXIT)
    throw new RalphError(
      "Model preflight containment is uncertain; recovery evidence is retained",
      EXIT.scope,
    );
  if (result.code !== 0 || result.report.trim() !== "MODEL_PREFLIGHT_OK")
    throw new RalphError(
      `Model preflight check failed (model=${options.model ?? ""} rc=${result.code})`,
      EXIT.tool,
    );
  logger.event("INFO", `model_preflight_ok tool=codex model=${options.model ?? ""}`);
}

export async function processStory(
  paths: RuntimePaths,
  prd: Prd,
  story: Story,
  mode: Mode,
  sandbox: string,
  options: CliOptions,
  logger: Logger,
): Promise<number> {
  const reportPath = extractReportPath(createdLine(story), prd, paths, options.strictReportDir);
  if (options.action === "dry-run") {
    logger.log(`dry-run: would execute story=${story.id} mode=${mode} (tool not invoked)`);
    logger.log(`dry-run: would persist report=${reportPath} for ${story.id}`);
    return 0;
  }
  let transaction: ReturnType<typeof beginTransaction> | undefined;
  let toolRoot = paths.repoRoot;
  let learningBefore = "__missing__";
  try {
    if (mode === "fixing") {
      transaction = beginTransaction(paths);
      toolRoot = transaction.workspace;
      if (options.requireLearningEntry)
        learningBefore = signature(join(toolRoot, packagePrefix(paths), "learnings.md"));
      logger.event("INFO", `fixing_transaction_started story=${story.id}`);
    }
    const prompt = buildPrompt(paths, story, mode, reportPath, sandbox, options, toolRoot);
    logger.event("STORY_START", `id=${story.id} mode=${mode} report=${reportPath}`);
    logger.log(`story=${story.id} mode=${mode}`);
    const result = await runCodex(
      paths,
      story.id,
      prompt,
      toolRoot,
      mode,
      sandbox,
      options,
      logger,
    );
    if (result.code === CONTAINMENT_EXIT) {
      // Keep the isolated workspace and journal for explicit recovery after containment is resolved.
      transaction = undefined;
      return result.code;
    }
    if (mode === "fixing" && transaction) {
      const prefix = packagePrefix(paths);
      const violations = transactionDiff(paths, transaction.journalPath).filter(
        (path) => path === `${prefix}prd.json` || !pathMatchesScope(story, path),
      );
      if (violations.length)
        throw new RalphError(
          `Story ${story.id} modified files outside scope:\n${violations.map((path) => `- ${path}`).join("\n")}\nThe isolated workspace was discarded; the live repository was not changed`,
          EXIT.scope,
        );
    }
    if (result.code !== 0) {
      if (transaction) {
        recoverTransaction(paths);
        transaction = undefined;
      }
      return result.code;
    }
    if (
      mode === "fixing" &&
      options.requireLearningEntry &&
      signature(join(toolRoot, packagePrefix(paths), "learnings.md")) === learningBefore
    )
      throw new RalphError(
        `fixing story ${story.id} requires at least one new learnings.md entry`,
        EXIT.tool,
      );
    atomicWriteRelative(toolRoot, reportPath, result.report);
    markPassed(paths, prd, story.id, reportPath, toolRoot);
    if (transaction) {
      prepareTransaction(paths, transaction.journalPath);
      const drift = verifyTransaction(paths, transaction.journalPath);
      if (drift.length)
        throw new RalphError(
          `Live repository drift detected before promoting story ${story.id}: ${drift.join(", ")}`,
          EXIT.scope,
        );
      promoteTransaction(paths, transaction.journalPath);
      transaction = undefined;
      logger.event("INFO", `fixing_transaction_committed story=${story.id}`);
    }
    clearFailure(paths, story.id);
    if (options.autoSyncAgents && mode === "fixing") {
      const agentsPath = `${packagePrefix(paths)}AGENTS.md`;
      if (pathMatchesScope(story, agentsPath)) {
        try {
          syncAgents(paths.packageRoot);
          logger.event("INFO", "agents_synced_from_learnings");
        } catch {
          logger.event("WARN", "agents_sync_from_learnings_failed");
        }
      } else
        logger.event(
          "WARN",
          `agents_sync_skipped_out_of_scope story=${story.id} path=${agentsPath}`,
        );
    }
    logger.event("STORY_COMPLETE", `id=${story.id} report=${reportPath}`);
    return 0;
  } catch (error) {
    if (transaction) {
      try {
        recoverTransaction(paths);
      } catch {
        /* Retain private journal for the next run. */
      }
    }
    throw error;
  }
}
