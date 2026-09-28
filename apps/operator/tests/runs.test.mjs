/** Verifies cheap discovery and selected-run details against disposable durable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  discoverRuns,
  locateRun,
  paginatedEvents,
  publicRun,
  publicRunSummary,
} from "../lib/runs.mjs";
import { createDemoTransport } from "../demo/transport.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rae-run-summary-")));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".pipeline/runs"), { recursive: true });
  writeFileSync(
    join(root, ".pipeline/pipeline-state.json"),
    JSON.stringify({
      run_id: "run-2",
      current_phase: "plan",
      workspace: { primary_repo_root: root },
    }),
  );
  for (let i = 1; i <= 2; i++) {
    const directory = join(root, `.pipeline/runs/run-${i}`);
    mkdirSync(directory);
    writeFileSync(
      join(directory, "request.json"),
      JSON.stringify({ task: `Task ${i}`, requested_at: `2026-09-0${i}T00:00:00Z` }),
    );
    writeFileSync(
      join(directory, "trace.jsonl"),
      `${JSON.stringify({ run_id: `run-${i}`, event: "agent_call", phase: "arm", ts: "2026-09-01" })}\n`,
    );
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { id: "project-test", root };
}

test("summaries exclude expensive evidence and private workspace data; details stay compatible", (t) => {
  const project = fixture(t);
  const summaries = discoverRuns(project, { view: "summary" });
  assert.deepEqual(
    summaries.map((run) => run.id),
    ["run-2", "run-1"],
  );
  const summary = publicRunSummary(summaries[0]);
  for (const field of [
    "state",
    "workspaceRoot",
    "gates",
    "checkpoints",
    "workflow",
    "graph_health",
    "resources",
  ])
    assert.equal(field in summary, false);
  const detail = publicRun(locateRun(project, "run-2"));
  assert.equal(detail.task, summary.task);
  assert.equal(detail.resources.agent_calls, 1);
  assert.equal(detail.gates.length, 10);
  assert.deepEqual(detail, publicRun(discoverRuns(project)[0]));
  assert.equal(paginatedEvents(locateRun(project, "run-2", { view: "summary" })).events.length, 1);
});

test("unselected corrupt traces do not interfere with summary listing or selected detail", (t) => {
  const project = fixture(t);
  writeFileSync(join(project.root, ".pipeline/runs/run-1/trace.jsonl"), "corrupt\n");
  assert.equal(discoverRuns(project, { view: "summary" }).length, 2);
  assert.equal(locateRun(project, "run-2").resources.agent_calls, 1);
});

test("legacy runs without request timestamps retain trace-based pagination order", (t) => {
  const project = fixture(t);
  for (const [id, ts] of [
    ["run-1", "2026-09-06"],
    ["run-2", "2026-09-01"],
  ]) {
    const directory = join(project.root, `.pipeline/runs/${id}`);
    writeFileSync(join(directory, "request.json"), "{}");
    writeFileSync(
      join(directory, "trace.jsonl"),
      `${JSON.stringify({ run_id: id, event: "run_start", phase: "arm", ts })}\n`,
    );
  }
  assert.deepEqual(
    discoverRuns(project, { view: "summary" }).map((run) => run.id),
    ["run-1", "run-2"],
  );
  assert.equal(discoverRuns(project)[0].id, "run-1");
});

test("demo summary paging and selected details mirror the live surface", async () => {
  const transport = createDemoTransport();
  const first = await transport.request("/projects/demo-project/runs?view=summary&limit=1");
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].gates, undefined);
  assert.equal(first.next_cursor, 1);
  const detail = await transport.request(`/projects/demo-project/runs/${first.runs[0].id}`);
  assert.ok(detail.run.gates.length);
  const page = await transport.request(
    `/projects/demo-project/runs/${first.runs[0].id}/events?limit=1`,
  );
  assert.equal(page.events.length, 1);
  const next = await transport.request(
    `/projects/demo-project/runs/${first.runs[0].id}/events?after=${page.next_after}&limit=1`,
  );
  assert.ok(next.events[0].seq > page.events[0].seq);
});
