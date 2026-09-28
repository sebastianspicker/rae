/** Parses Ralph CLI policy and resolves package and repository locations. */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { RalphError } from "./errors.js";
import { boolEnv, canonicalDirectory, isWithin, uintEnv } from "./util.js";
import { MODES, type CliOptions, type Mode, type RuntimePaths } from "./types.js";

export const VERSION = "0.4.0";

export const USAGE = `Usage: ralph [N] [OPTIONS]

Process up to N stories for the active mode using Codex CLI.

Arguments:
  N                          Maximum stories; omitted processes the configured default

Options:
  --mode <mode>              audit|linting|fixing
  --search | --no-search     Enable or disable Codex web search
  --model <model>            Override model id
  --reasoning-effort <lvl>   low|medium|high
  --timeout-seconds <secs>   Positive per-story timeout
  --model-preflight | --no-model-preflight
  --security-preflight | --no-security-preflight
  --auto-archive | --no-auto-archive
  --require-learning-entry | --no-require-learning-entry
  --sync-branch | --no-sync-branch
  --strict-report-dir | --no-strict-report-dir
  --validate-prd             Validate PRD and exit
  --validate-config          Validate runtime configuration and exit
  --check                    Read-only configuration and status check
  --doctor                   Read-only diagnostics
  --status                   Show story and lock state
  --list-stories             List open stories
  --list-stories-format <f>  full|ids|id+title|json
  --status-format <f>        full|compact|json
  --json                     Machine-readable command output
  --dry-run [N]              Preview story runs without invoking Codex
  --aggregate-reports        Generate report summary
  --export-state             Export fingerprinted story state
  --import-state <file>      Import fingerprinted story state
  --reset-story <id>         Reset one story
  --retry-failed             Reset all skipped stories
  -q, --quiet | -v, --verbose
  --no-color                 Disable color
  --version                  Print version
  -h, --help                 Show help
`;

function mode(value: string): Mode {
  if (!MODES.includes(value as Mode))
    throw new RalphError("MODE must be one of: audit | linting | fixing");
  return value as Mode;
}

function enumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new RalphError(`${label} must be ${allowed.join("|")}`);
  return value as T;
}

function environmentOptions(): CliOptions {
  const envMode = process.env.MODE ? mode(process.env.MODE) : undefined;
  return {
    mode: envMode,
    maxStoriesExplicit: false,
    search: boolEnv("RALPH_SEARCH_ENABLED_BY_DEFAULT", false),
    model: process.env.RALPH_MODEL || undefined,
    reasoningEffort: process.env.RALPH_REASONING_EFFORT
      ? enumValue(
          process.env.RALPH_REASONING_EFFORT,
          ["low", "medium", "high"] as const,
          "RALPH_REASONING_EFFORT",
        )
      : undefined,
    timeoutSeconds: uintEnv("RALPH_TIMEOUT_SECONDS", 900, 1),
    maxAttempts: uintEnv("RALPH_MAX_ATTEMPTS_PER_STORY", 1, 1),
    skipAfterFailures: uintEnv("RALPH_SKIP_AFTER_FAILURES", 0),
    captureToolOutput: boolEnv("RALPH_CAPTURE_TOOL_OUTPUT", false),
    requireExternalReferences: boolEnv("RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH", true),
    modelPreflight: boolEnv("RALPH_MODEL_PREFLIGHT", false),
    autoArchive: boolEnv("RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE", false),
    requireLearningEntry: boolEnv("RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING", false),
    syncBranch: boolEnv("RALPH_SYNC_BRANCH_FROM_PRD", false),
    autoProgressLog: boolEnv("RALPH_AUTO_PROGRESS_LOG_APPEND", true),
    autoSyncAgents: boolEnv("RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS", false),
    securityPreflight: boolEnv("RALPH_SECURITY_PREFLIGHT", true),
    securityPreflightFail: boolEnv("RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK", false),
    staleLockSeconds: uintEnv("RALPH_STALE_LOCK_NO_PID_SECONDS", 30),
    strictReportDir: boolEnv("RALPH_STRICT_REPORT_DIR", true),
    autoProgressRefresh: boolEnv("RALPH_AUTO_PROGRESS_REFRESH", true),
    verbosity: enumValue(
      process.env.RALPH_VERBOSITY || "normal",
      ["normal", "quiet", "verbose"] as const,
      "RALPH_VERBOSITY",
    ),
    outputFormat: enumValue(
      process.env.RALPH_OUTPUT_FORMAT || "text",
      ["text", "json"] as const,
      "RALPH_OUTPUT_FORMAT",
    ),
    statusFormat: enumValue(
      process.env.RALPH_STATUS_FORMAT || "full",
      ["full", "compact", "json"] as const,
      "RALPH_STATUS_FORMAT",
    ),
    listFormat: enumValue(
      process.env.RALPH_LIST_STORIES_FORMAT || "full",
      ["full", "ids", "id+title", "json"] as const,
      "RALPH_LIST_STORIES_FORMAT",
    ),
    action: "run",
    noColor: false,
  };
}

interface ParseState {
  options: CliOptions;
  statusExplicit: boolean;
  listExplicit: boolean;
}
type ValueHandler = (state: ParseState, value: string) => void;
const BOOLEAN_FLAGS = new Map<
  string,
  keyof Pick<
    CliOptions,
    | "search"
    | "modelPreflight"
    | "securityPreflight"
    | "autoArchive"
    | "requireLearningEntry"
    | "syncBranch"
    | "strictReportDir"
  >
>([
  ["search", "search"],
  ["model-preflight", "modelPreflight"],
  ["security-preflight", "securityPreflight"],
  ["auto-archive", "autoArchive"],
  ["require-learning-entry", "requireLearningEntry"],
  ["sync-branch", "syncBranch"],
  ["strict-report-dir", "strictReportDir"],
]);
const ACTION_FLAGS = new Map<string, CliOptions["action"]>([
  ["--validate-prd", "validate-prd"],
  ["--validate-config", "validate-config"],
  ["--check", "check"],
  ["--doctor", "doctor"],
  ["--status", "status"],
  ["--list-stories", "list-stories"],
  ["--aggregate-reports", "aggregate-reports"],
  ["--export-state", "export-state"],
  ["--retry-failed", "retry-failed"],
  ["--dry-run", "dry-run"],
]);
const VALUE_FLAGS = new Map<string, ValueHandler>([
  [
    "--mode",
    ({ options }, value) => {
      options.mode = mode(value);
    },
  ],
  [
    "--model",
    ({ options }, value) => {
      options.model = value;
    },
  ],
  [
    "--reasoning-effort",
    ({ options }, value) => {
      options.reasoningEffort = enumValue(
        value,
        ["low", "medium", "high"] as const,
        "Reasoning effort",
      );
    },
  ],
  [
    "--timeout-seconds",
    ({ options }, value) => {
      options.timeoutSeconds = positive(value, "--timeout-seconds");
    },
  ],
  [
    "--import-state",
    ({ options }, value) => {
      options.action = "import-state";
      options.actionValue = value;
    },
  ],
  [
    "--reset-story",
    ({ options }, value) => {
      options.action = "reset-story";
      options.actionValue = value;
    },
  ],
  [
    "--status-format",
    (state, value) => {
      state.options.statusFormat = enumValue(
        value,
        ["full", "compact", "json"],
        "RALPH_STATUS_FORMAT",
      );
      state.statusExplicit = true;
    },
  ],
  [
    "--list-stories-format",
    (state, value) => {
      state.options.listFormat = enumValue(
        value,
        ["full", "ids", "id+title", "json"],
        "RALPH_LIST_STORIES_FORMAT",
      );
      state.listExplicit = true;
    },
  ],
]);
function applyFlag(options: CliOptions, argument: string): boolean {
  const negative = argument.startsWith("--no-");
  const booleanKey = BOOLEAN_FLAGS.get(argument.slice(negative ? 5 : 2));
  if (argument.startsWith("--") && booleanKey) {
    options[booleanKey] = !negative;
    return true;
  }
  const action = ACTION_FLAGS.get(argument);
  if (action) {
    options.action = action;
    return true;
  }
  switch (argument) {
    case "-q":
    case "--quiet":
      options.verbosity = "quiet";
      return true;
    case "-v":
    case "--verbose":
      options.verbosity = "verbose";
      return true;
    case "--no-color":
      options.noColor = true;
      return true;
    case "--json":
      options.outputFormat = "json";
      return true;
    default:
      return false;
  }
}
function applyInlineValue(state: ParseState, argument: string): boolean {
  const separator = argument.indexOf("=");
  if (separator < 0) return false;
  const flag = argument.slice(0, separator);
  if (!["--status-format", "--list-stories-format", "--reset-story"].includes(flag)) return false;
  const handler = VALUE_FLAGS.get(flag);
  if (!handler) return false;
  handler(state, argument.slice(separator + 1));
  return true;
}
function applyStoryCount(options: CliOptions, argument: string): void {
  if (!/^\d+$/.test(argument) && argument !== "all_open")
    throw new RalphError(`Unknown argument: ${argument}`);
  if (options.maxStoriesExplicit) throw new RalphError("Only one positional N argument is allowed");
  options.maxStories = argument === "all_open" ? argument : Number(argument);
  options.maxStoriesExplicit = true;
}
export function parseArgs(argv: string[]): CliOptions {
  const state: ParseState = {
    options: environmentOptions(),
    statusExplicit: false,
    listExplicit: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (applyFlag(state.options, argument)) continue;
    const handler = VALUE_FLAGS.get(argument);
    if (handler) {
      const value = argv[++index];
      if (value === undefined) throw new RalphError(`${argument} requires a value`);
      handler(state, value);
    } else if (!applyInlineValue(state, argument)) applyStoryCount(state.options, argument);
  }
  if (state.options.outputFormat === "json") {
    if (!state.statusExplicit) state.options.statusFormat = "json";
    if (!state.listExplicit) state.options.listFormat = "json";
  }
  return state.options;
}

function positive(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value)))
    throw new RalphError(`${label} must be a positive integer`);
  return Number(value);
}

function packageRootFromModule(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

export function resolvePaths(readonly: boolean): RuntimePaths {
  const packageRoot = packageRootFromModule();
  let repoRoot: string;
  if (process.env.RALPH_REPO_ROOT) {
    repoRoot = canonicalDirectory(resolve(process.env.RALPH_REPO_ROOT), "repository root");
  } else if (
    existsSync(join(process.cwd(), "prd.json")) &&
    existsSync(join(process.cwd(), "INSTRUCTIONS.md"))
  ) {
    repoRoot = realpathSync.native(process.cwd());
  } else if (
    basename(packageRoot) === "ralph-audit" &&
    basename(dirname(packageRoot)) === ".claude" &&
    existsSync(join(packageRoot, "prd.json")) &&
    existsSync(join(packageRoot, "INSTRUCTIONS.md"))
  ) {
    repoRoot = realpathSync.native(resolve(packageRoot, "../.."));
  } else {
    try {
      repoRoot = realpathSync.native(
        execFileSync("git", ["-C", packageRoot, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
        }).trim(),
      );
    } catch {
      if (
        existsSync(join(packageRoot, "prd.json")) &&
        existsSync(join(packageRoot, "INSTRUCTIONS.md"))
      )
        repoRoot = realpathSync.native(packageRoot);
      else
        throw new RalphError("Could not resolve repository root. Set RALPH_REPO_ROOT explicitly.");
    }
  }
  const stateDir = join(packageRoot, ".runtime");
  validateRuntimeState(repoRoot, stateDir, readonly);
  return {
    packageRoot,
    repoRoot,
    prdFile: join(packageRoot, "prd.json"),
    schemaFile: join(packageRoot, "prd.schema.json"),
    policyFile: join(packageRoot, "INSTRUCTIONS.md"),
    stateDir,
    runLog: join(stateDir, "run.log"),
    eventLog: join(stateDir, "events.log"),
  };
}

export function validateRuntimeState(repoRoot: string, stateDir: string, readonly: boolean): void {
  if (!readonly) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(stateDir)) {
    const real = canonicalDirectory(stateDir, "runtime state directory");
    if (!isWithin(repoRoot, real) || real === repoRoot)
      throw new RalphError(
        `Runtime state directory resolves outside repository: ${stateDir} -> ${real}`,
      );
  }
}

export function assertNodeVersion(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new RalphError(`Node.js >=24 is required (found ${process.versions.node})`);
}
