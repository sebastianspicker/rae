/** Measures equivalent historical-run and trace workloads in disposable repositories. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { discoverRuns, projectRunDetails, publicRun } from "../../apps/operator/lib/runs.mjs";
import {
  projectOperatorEvents,
  readOperatorEventsAfter,
  ensureRuntimeStateReadable,
} from "@rae/engine";

const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rae-optimization-bench-")));
const readFile = fs.readFileSync;
const parse = JSON.parse;
let counters;
fs.readFileSync = (...args) => {
  const value = readFile(...args);
  if (counters) {
    counters.read_calls++;
    counters.bytes_read += Buffer.byteLength(value);
  }
  return value;
};
JSON.parse = (...args) => {
  if (counters) counters.parse_calls++;
  return parse(...args);
};
syncBuiltinESMExports();
function measure(label, size, operation, prepare = () => {}) {
  const runs = [];
  let result;
  for (let iteration = 0; iteration < 3; iteration++) {
    prepare();
    counters = { bytes_read: 0, read_calls: 0, parse_calls: 0 };
    const memory = process.memoryUsage().rss;
    const start = performance.now();
    result = operation();
    runs.push({
      elapsed_ms: performance.now() - start,
      rss_delta_bytes: process.memoryUsage().rss - memory,
      ...counters,
    });
    counters = null;
  }
  console.log(JSON.stringify({ workload: label, size, repetitions: runs }));
  return result;
}
try {
  execFileSync("git", ["init", "-q", root]);
  const runsRoot = join(root, ".pipeline/runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.writeFileSync(
    join(root, ".pipeline/pipeline-state.json"),
    JSON.stringify({
      run_id: "run-0",
      current_phase: "arm",
      workspace: { primary_repo_root: root },
    }),
  );
  const event = (i, runId = "run-0") => ({
    run_id: runId,
    event: "agent_call",
    phase: "arm",
    ts: new Date(1800000000000 + i).toISOString(),
  });
  for (const size of process.env.RAE_BENCH_SCOPE === "trace" ? [] : [100, 1000]) {
    for (let i = 0; i < size; i++) {
      const directory = join(runsRoot, `run-${i}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        join(directory, "request.json"),
        JSON.stringify({
          task: `Fixture ${i}`,
          requested_at: new Date(1800000000000 + i).toISOString(),
        }),
      );
      fs.writeFileSync(join(directory, "trace.jsonl"), `${JSON.stringify(event(i, `run-${i}`))}\n`);
    }
    const project = { id: "fixture-project", root };
    const baseline = measure("run-list-full-before-pagination", size, () =>
      discoverRuns(project)
        .slice(0, 1)
        .map((run) => publicRun(run)),
    );
    const optimized = measure("run-list-summary-then-selected-detail", size, () =>
      discoverRuns(project, { view: "summary" })
        .slice(0, 1)
        .map((run) => publicRun(projectRunDetails(project, run))),
    );
    assert.deepEqual(optimized, baseline);
  }
  fs.mkdirSync(join(runsRoot, "run-0"), { recursive: true });
  for (const size of [1000, 10000]) {
    fs.writeFileSync(
      join(runsRoot, "run-0/trace.jsonl"),
      Array.from({ length: size }, (_, i) => `${JSON.stringify(event(i))}\n`).join(""),
    );
    const baseline = measure("trace-full-replay-pages", size, () => {
      const all = [];
      for (let after = 0; after < size; after += 200) {
        ensureRuntimeStateReadable(root, { expectedRunId: "run-0" });
        all.push(
          ...projectOperatorEvents("run-0", root)
            .filter((item) => item.seq > after)
            .slice(0, 200),
        );
        ensureRuntimeStateReadable(root, { expectedRunId: "run-0" });
      }
      return all;
    });
    const optimized = measure(
      "trace-cursor-pages",
      size,
      () => {
        const all = [];
        for (let after = 0; after < size; after += 200)
          all.push(...readOperatorEventsAfter("run-0", root, { after, limit: 200 }).events);
        return all;
      },
      () => {
        // Replace the file before each measured cold replay without exposing cache controls.
        const tracePath = join(runsRoot, "run-0/trace.jsonl");
        fs.writeFileSync(`${tracePath}.next`, fs.readFileSync(tracePath));
        fs.renameSync(`${tracePath}.next`, tracePath);
      },
    );
    assert.deepEqual(optimized, baseline);
  }
} finally {
  counters = null;
  fs.readFileSync = readFile;
  JSON.parse = parse;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
