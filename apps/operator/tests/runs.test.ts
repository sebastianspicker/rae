/** Verifies cheap discovery and selected-run details against disposable durable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { TestContext } from "node:test";
import type { OperatorProject } from "../lib/security.js";
import type { OperatorRun, OperatorEvent } from "../static/js/types.js";
import {
  discoverRuns,
  locateRun,
  paginatedEvents,
  publicRun,
  publicRunSummary,
  RunCatalog,
} from "../lib/runs.js";
import { createDemoTransport } from "../demo/transport.js";

function fixture(t: TestContext): OperatorProject {
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
  return { id: "project-test", root, label: "test" };
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
  assert.equal(detail.resources?.agent_calls, 1);
  assert.equal(detail.gates?.length, 10);
  assert.deepEqual(detail, publicRun(discoverRuns(project)[0]));
  assert.equal(paginatedEvents(locateRun(project, "run-2", { view: "summary" })).events.length, 1);
});

test("summaries distinguish checkpoint holds from timed workflow waits", (t) => {
  const project = fixture(t);
  const controls = [
    {
      runId: "run-1",
      waiting_checkpoint_id: "checkpoint-human-review",
    },
    {
      runId: "run-2",
      waiting_node_id: "wait-for-window",
      waiting_deadline_at: "2026-09-03T00:00:00Z",
    },
  ];
  for (const { runId, ...waiting } of controls) {
    writeFileSync(
      join(project.root, `.pipeline/runs/${runId}/operator-control.json`),
      JSON.stringify({
        schema_version: "1.0.0",
        run_id: runId,
        status: "waiting",
        stop_requested: false,
        updated_at: "2026-09-02T00:00:00Z",
        ...waiting,
      }),
    );
  }
  const summaries = discoverRuns(project, { view: "summary" }).map(publicRunSummary);
  const humanHold = summaries.find((run) => run.id === "run-1");
  const timedWait = summaries.find((run) => run.id === "run-2");
  assert.equal(humanHold?.needs_human_decision, true);
  assert.equal(timedWait?.needs_human_decision, false);
  assert.equal("waiting_checkpoint_id" in (humanHold ?? {}), false);
  assert.equal("waiting_node_id" in (timedWait ?? {}), false);
});

test("unselected corrupt traces do not interfere with summary listing or selected detail", (t) => {
  const project = fixture(t);
  writeFileSync(join(project.root, ".pipeline/runs/run-1/trace.jsonl"), "corrupt\n");
  assert.equal(discoverRuns(project, { view: "summary" }).length, 2);
  assert.equal(locateRun(project, "run-2").resources?.agent_calls, 1);
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
  assert.equal(discoverRuns(project)[0]?.id, "run-1");
});

test("catalog keysets remain stable across external run creation and reject malformed cursors", async (t) => {
  const project = fixture(t);
  const catalog = new RunCatalog();
  const first = await catalog.page(project, { view: "summary", limit: 1 });
  assert.deepEqual(
    first.runs.map((run) => run.id),
    ["run-2"],
  );
  assert.equal(typeof first.next_cursor, "string");
  const added = join(project.root, ".pipeline/runs/run-3");
  mkdirSync(added);
  writeFileSync(
    join(added, "request.json"),
    JSON.stringify({ task: "Task 3", requested_at: "2026-09-03T00:00:00Z" }),
  );
  writeFileSync(join(added, "trace.jsonl"), "");
  const second = await catalog.page(project, {
    view: "summary",
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.deepEqual(
    second.runs.map((run) => run.id),
    ["run-1"],
  );
  await assert.rejects(catalog.page(project, { cursor: "not-a-cursor" }), /invalid run cursor/u);
  catalog.close();
  await assert.rejects(catalog.page(project), /run catalog is closed/u);
});

test("demo summary paging and selected details mirror the live surface", async () => {
  const transport = createDemoTransport();
  const first = (await transport.request("/projects/demo-project/runs?view=summary&limit=1")) as {
    runs: OperatorRun[];
    next_cursor: string;
  };
  assert.equal(first.runs.length, 1);
  assert.equal(first.runs[0].gates, undefined);
  assert.equal(typeof first.next_cursor, "string");
  const second = (await transport.request(
    `/projects/demo-project/runs?view=summary&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
  )) as { runs: OperatorRun[] };
  assert.notEqual(second.runs[0].id, first.runs[0].id);
  const detail = (await transport.request(`/projects/demo-project/runs/${first.runs[0]!.id}`)) as {
    run: OperatorRun;
  };
  assert.ok(detail.run.gates?.length);
  const page = (await transport.request(
    `/projects/demo-project/runs/${first.runs[0]!.id}/events?limit=1`,
  )) as { events: OperatorEvent[]; next_after: number };
  assert.equal(page.events.length, 1);
  const next = (await transport.request(
    `/projects/demo-project/runs/${first.runs[0]!.id}/events?after=${page.next_after}&limit=1`,
  )) as { events: OperatorEvent[] };
  assert.ok(next.events[0]!.seq > page.events[0]!.seq);
});

test("catalog detail work leaves the HTTP event loop responsive and returns worker read counts", async (t) => {
  const project = fixture(t);
  const catalog = new RunCatalog({ measureReads: true });
  t.after(() => catalog.close());
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  t.after(() => clearInterval(timer));
  const page = await catalog.page(project, { limit: 2 });
  assert.equal(page.runs.length, 2);
  assert.ok(ticks > 0);
  const metrics = catalog.takeReadMetrics();
  assert.ok(metrics.bytesRead > 0);
  assert.ok(metrics.parseCalls > 0);
  assert.deepEqual(catalog.takeReadMetrics(), { bytesRead: 0, readCalls: 0, parseCalls: 0 });
  const located = await catalog.locate(project, "run-1");
  assert.equal(located.id, "run-1");
  await assert.rejects(catalog.page(project, { limit: 101 }), /invalid run page limit/);
});

test("catalog bounds pending requests and closes outstanding work", async (t) => {
  const project = fixture(t);
  const catalog = new RunCatalog();
  t.after(() => catalog.close());
  const pending = Promise.allSettled(Array.from({ length: 33 }, () => catalog.page(project)));
  await catalog.close();
  const results = await pending;
  assert.equal(results.filter((result) => result.status === "rejected").length, 33);
  assert.ok(
    results.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof Error &&
        result.reason.message === "run catalog is busy",
    ),
  );
  await assert.rejects(catalog.page(project), /closed/);
});

test("catalog reconciles pipeline state changes even when per-run files are unchanged", async (t) => {
  const project = fixture(t);
  const catalog = new RunCatalog();
  t.after(() => catalog.close());
  const initial = await catalog.page(project, { view: "summary" });
  assert.equal(initial.runs[0]?.current_phase, "plan");
  writeFileSync(
    join(project.root, ".pipeline/pipeline-state.json"),
    JSON.stringify({
      run_id: "run-2",
      current_phase: "build",
      workspace: { primary_repo_root: project.root },
    }),
  );
  const changed = await catalog.page(project, { view: "summary" });
  assert.equal(changed.runs[0]?.current_phase, "build");
});
