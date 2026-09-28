/** Verifies warning, disabled, and fail-closed security-preflight behavior. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../src/config.js";
import { EXIT, RalphError } from "../src/errors.js";
import { Logger } from "../src/logger.js";
import { securityPreflight } from "../src/preflight.js";
import type { RuntimePaths } from "../src/types.js";

function fixture(): { root: string; paths: RuntimePaths } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-preflight-")));
  mkdirSync(join(root, ".runtime"), { mode: 0o700 });
  return {
    root,
    paths: {
      packageRoot: root,
      repoRoot: root,
      prdFile: join(root, "prd.json"),
      schemaFile: join(root, "prd.schema.json"),
      policyFile: join(root, "INSTRUCTIONS.md"),
      stateDir: join(root, ".runtime"),
      runLog: join(root, ".runtime", "run.log"),
      eventLog: join(root, ".runtime", "events.log"),
    },
  };
}

test("security preflight warns, can be disabled, and uses exit code 6 in strict mode", () => {
  const item = fixture();
  const previous = process.env.RALPH_TEST_API_KEY;
  const write = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr += value.toString();
    return true;
  }) as typeof process.stderr.write;
  process.env.RALPH_TEST_API_KEY = "private-test-value";
  try {
    const warning = parseArgs([]);
    warning.securityPreflight = true;
    warning.securityPreflightFail = false;
    securityPreflight(warning, new Logger(item.paths, warning, true));
    assert.match(stderr, /RALPH_TEST_API_KEY/u);
    assert.doesNotMatch(stderr, /private-test-value/u);

    const disabled = parseArgs([]);
    disabled.securityPreflight = false;
    securityPreflight(disabled, new Logger(item.paths, disabled, true));
    assert.match(readFileSync(item.paths.eventLog, "utf8"), /security_preflight=disabled/u);

    warning.securityPreflightFail = true;
    assert.throws(
      () => securityPreflight(warning, new Logger(item.paths, warning, true)),
      (error: unknown) => error instanceof RalphError && error.exitCode === EXIT.security,
    );
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.RALPH_TEST_API_KEY;
    else process.env.RALPH_TEST_API_KEY = previous;
    rmSync(item.root, { recursive: true, force: true });
  }
});
