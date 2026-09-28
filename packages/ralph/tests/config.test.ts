/** Characterizes Ralph's CLI and environment configuration compatibility. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs, validateRuntimeState } from "../src/config.js";
import { RalphError } from "../src/errors.js";

const ENVIRONMENT_KEYS = [
  "MODE",
  "RALPH_SEARCH_ENABLED_BY_DEFAULT",
  "RALPH_MODEL",
  "RALPH_REASONING_EFFORT",
  "RALPH_TIMEOUT_SECONDS",
  "RALPH_MAX_ATTEMPTS_PER_STORY",
  "RALPH_SKIP_AFTER_FAILURES",
  "RALPH_CAPTURE_TOOL_OUTPUT",
  "RALPH_REQUIRE_EXTERNAL_REFERENCES_ON_SEARCH",
  "RALPH_MODEL_PREFLIGHT",
  "RALPH_AUTO_ARCHIVE_ON_PROJECT_CHANGE",
  "RALPH_REQUIRE_LEARNING_ENTRY_FOR_FIXING",
  "RALPH_SYNC_BRANCH_FROM_PRD",
  "RALPH_AUTO_PROGRESS_LOG_APPEND",
  "RALPH_AUTO_SYNC_AGENTS_FROM_LEARNINGS",
  "RALPH_SECURITY_PREFLIGHT",
  "RALPH_SECURITY_PREFLIGHT_FAIL_ON_RISK",
  "RALPH_STALE_LOCK_NO_PID_SECONDS",
  "RALPH_STRICT_REPORT_DIR",
  "RALPH_AUTO_PROGRESS_REFRESH",
  "RALPH_VERBOSITY",
  "RALPH_OUTPUT_FORMAT",
  "RALPH_STATUS_FORMAT",
  "RALPH_LIST_STORIES_FORMAT",
] as const;

function withCleanEnvironment<T>(run: () => T): T {
  const previous = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parses the legacy option matrix and JSON format defaults", () =>
  withCleanEnvironment(() => {
    const options = parseArgs([
      "all_open",
      "--mode",
      "fixing",
      "--search",
      "--model",
      "gpt-test",
      "--reasoning-effort",
      "high",
      "--timeout-seconds",
      "17",
      "--model-preflight",
      "--no-security-preflight",
      "--auto-archive",
      "--require-learning-entry",
      "--sync-branch",
      "--no-strict-report-dir",
      "--json",
      "--status-format",
      "compact",
      "--list-stories",
      "--list-stories-format=id+title",
      "--no-color",
    ]);
    assert.equal(options.maxStories, "all_open");
    assert.equal(options.maxStoriesExplicit, true);
    assert.equal(options.mode, "fixing");
    assert.equal(options.search, true);
    assert.equal(options.model, "gpt-test");
    assert.equal(options.reasoningEffort, "high");
    assert.equal(options.timeoutSeconds, 17);
    assert.equal(options.modelPreflight, true);
    assert.equal(options.securityPreflight, false);
    assert.equal(options.autoArchive, true);
    assert.equal(options.requireLearningEntry, true);
    assert.equal(options.syncBranch, true);
    assert.equal(options.strictReportDir, false);
    assert.equal(options.outputFormat, "json");
    assert.equal(options.statusFormat, "compact");
    assert.equal(options.listFormat, "id+title");
    assert.equal(options.action, "list-stories");
    assert.equal(options.noColor, true);
  }));

test("honors environment defaults and lets CLI flags override booleans", () =>
  withCleanEnvironment(() => {
    process.env.MODE = "linting";
    process.env.RALPH_SEARCH_ENABLED_BY_DEFAULT = "true";
    process.env.RALPH_MAX_ATTEMPTS_PER_STORY = "3";
    process.env.RALPH_SKIP_AFTER_FAILURES = "2";
    process.env.RALPH_CAPTURE_TOOL_OUTPUT = "true";
    process.env.RALPH_OUTPUT_FORMAT = "json";
    const options = parseArgs(["0", "--no-search", "--dry-run"]);
    assert.equal(options.mode, "linting");
    assert.equal(options.search, false);
    assert.equal(options.maxAttempts, 3);
    assert.equal(options.skipAfterFailures, 2);
    assert.equal(options.captureToolOutput, true);
    assert.equal(options.maxStories, 0);
    assert.equal(options.action, "dry-run");
    assert.equal(options.statusFormat, "json");
    assert.equal(options.listFormat, "json");
  }));

test("rejects malformed values, duplicate counts, and unknown options", () =>
  withCleanEnvironment(() => {
    process.env.RALPH_SECURITY_PREFLIGHT = "sometimes";
    assert.throws(
      () => parseArgs([]),
      (error: unknown) =>
        error instanceof RalphError && /must be true or false/u.test(error.message),
    );
    delete process.env.RALPH_SECURITY_PREFLIGHT;
    assert.throws(() => parseArgs(["--timeout-seconds", "0"]), /positive integer/u);
    assert.throws(() => parseArgs(["1", "2"]), /Only one positional/u);
    assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/u);
  }));

test("keeps read-only checks side-effect free and rejects a symlinked runtime directory", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-config-root-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-config-outside-")));
  const state = join(root, ".runtime");
  try {
    validateRuntimeState(root, state, true);
    assert.equal(existsSync(state), false);
    symlinkSync(outside, state);
    assert.throws(() => validateRuntimeState(root, state, true), /canonical|outside/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
