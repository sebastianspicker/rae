/** Verifies persisted failure, skip/reset, progress, and report-summary state. */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  aggregateReports,
  clearFailure,
  incrementFailure,
  resetSkipped,
  skipStory,
} from "../src/state.js";
import type { Prd, RuntimePaths } from "../src/types.js";

function fixture(): { root: string; paths: RuntimePaths; prd: Prd } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-state-persist-")));
  const stateDir = join(root, ".runtime");
  mkdirSync(stateDir, { mode: 0o700 });
  const paths: RuntimePaths = {
    packageRoot: root,
    repoRoot: root,
    prdFile: join(root, "prd.json"),
    schemaFile: join(root, "prd.schema.json"),
    policyFile: join(root, "INSTRUCTIONS.md"),
    stateDir,
    runLog: join(stateDir, "run.log"),
    eventLog: join(stateDir, "events.log"),
  };
  const prd: Prd = {
    project: "state",
    defaults: {
      report_dir: "reports",
      sandbox_by_mode: { audit: "read-only", linting: "read-only", fixing: "workspace-write" },
    },
    stories: [
      {
        id: "A-1",
        title: "State",
        priority: 1,
        mode: "audit",
        scope: ["**"],
        acceptance_criteria: ["Created reports/A-1.md"],
        passes: false,
      },
    ],
  };
  writeFileSync(paths.prdFile, `${JSON.stringify(prd, null, 2)}\n`);
  return { root, paths, prd };
}

test("uses the legacy failure-state filename and clears it after skip reset", () => {
  const item = fixture();
  try {
    assert.equal(incrementFailure(item.paths, "A-1"), 1);
    assert.equal(incrementFailure(item.paths, "A-1"), 2);
    assert.equal(
      readFileSync(join(item.paths.stateDir, ".story-failures.tsv"), "utf8"),
      "A-1\t2\n",
    );
    clearFailure(item.paths, "A-1");
    assert.equal(readFileSync(join(item.paths.stateDir, ".story-failures.tsv"), "utf8"), "");
    skipStory(item.paths, item.prd, "A-1", "test skip");
    assert.equal(item.prd.stories[0]?.skipped, true);
    assert.equal(resetSkipped(item.paths, item.prd), 1);
    assert.equal(item.prd.stories[0]?.skipped, false);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});

test("aggregates reports deterministically and rejects a symlinked report root", () => {
  const item = fixture();
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-state-report-outside-")));
  try {
    mkdirSync(join(item.root, "reports"));
    writeFileSync(join(item.root, "reports", "b.md"), "B\n");
    writeFileSync(join(item.root, "reports", "a.md"), "A\n");
    const output = aggregateReports(item.paths, item.prd);
    assert.ok(output);
    assert.match(readFileSync(output, "utf8"), /\[a\.md\]\(a\.md\)[\s\S]*\[b\.md\]\(b\.md\)/u);
    rmSync(join(item.root, "reports"), { recursive: true });
    symlinkSync(outside, join(item.root, "reports"));
    assert.throws(() => aggregateReports(item.paths, item.prd), /canonical directory/u);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
