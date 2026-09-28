/** Exercises cursor replay without providers or writable personal repositories. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readOperatorEventsAfter, projectOperatorEvents } from "@rae/engine";
import {
  clearOperatorTraceCache,
  operatorTraceMetrics,
} from "../src/run/operator-trace-reader.mjs";
import { createRuntimeStateGuard } from "../src/run/runtime-state-guard.mjs";

const record = (i) =>
  JSON.stringify({
    run_id: "run-test",
    event: "agent_call",
    phase: "arm",
    ts: String(i),
    prompt: "private",
    metadata: { secret: "private" },
  });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "rae-trace-cursor-"));
  execFileSync("git", ["init", "-q", root]);
  const directory = join(root, ".pipeline/runs/run-test");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "trace.jsonl");
  clearOperatorTraceCache();
  operatorTraceMetrics({ reset: true });
  t.after(() => {
    clearOperatorTraceCache();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, path, read: (options) => readOperatorEventsAfter("run-test", root, options) };
}

test("cursor pages retain physical lines, sanitization and complete projection equivalence", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, `${record(1)}\n\n${record(3)}\n`);
  const first = f.read({ limit: 1 });
  assert.equal(first.has_more, true);
  assert.equal(first.next_after, 1);
  const second = f.read({ after: first.next_after, limit: 1 });
  assert.equal(second.events[0].seq, 3);
  assert.equal(second.has_more, false);
  assert.deepEqual([...first.events, ...second.events], projectOperatorEvents("run-test", f.root));
  assert.equal(JSON.stringify(first).includes("private"), false);
  first.events[0].event = "tampered";
  assert.equal(f.read().events[0].event, "agent_call");
  assert.equal(operatorTraceMetrics().records_parsed, 2);
});

test("incomplete UTF-8 lines wait for newline and appended records parse once", (t) => {
  const f = fixture(t);
  const bytes = Buffer.from(`${record("🦊")}\n`);
  writeFileSync(f.path, `${record(0)}\n`);
  f.read();
  const split = bytes.indexOf(Buffer.from("🦊")) + 1;
  appendFileSync(f.path, bytes.subarray(0, split));
  assert.equal(f.read().events.length, 1);
  appendFileSync(f.path, bytes.subarray(split));
  assert.equal(f.read({ after: 1 }).events[0].ts, "🦊");
  assert.equal(operatorTraceMetrics().records_parsed, 2);
});

test("replacement, truncation, and prefix rewrites during growth invalidate cached history", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, `${record(1)}\n${record(2)}\n`);
  f.read();
  writeFileSync(`${f.path}.replacement`, `${record(8)}\n${record(9)}\n`);
  renameSync(`${f.path}.replacement`, f.path);
  assert.equal(f.read().events[0].ts, "8");
  writeFileSync(f.path, `${record(4)}\n`);
  assert.equal(f.read().events.length, 1);
  writeFileSync(f.path, `${record(5)}\n${record(6)}\n`);
  assert.equal(f.read().events[0].ts, "5");
  writeFileSync(f.path, `not json\n${record(6)}\n${record(7)}\n`);
  assert.throws(() => f.read({ after: 999 }), /corrupt trace JSONL at line 1/);
});

test("limits fail even beyond the requested page and missing traces do not create files", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.read({ after: 4 }), { events: [], next_after: 4, has_more: false });
  writeFileSync(f.path, Array.from({ length: 10001 }, (_, i) => `${record(i)}\n`).join(""));
  assert.throws(() => f.read({ limit: 1 }), /MAX_TRACE_EVENTS/);
  assert.throws(() => f.read({ after: -1 }), /invalid operator/);
});

test("cached traces are refused while the workspace is guarded", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, `${record(1)}\n`);
  f.read();
  writeFileSync(join(f.root, ".pipeline/runs/run-test/operator-control.json"), "{}\n");
  const guard = createRuntimeStateGuard(f.root, "run-test", "build");
  t.after(() => rmSync(guard.active, { recursive: true, force: true }));
  assert.throws(() => f.read(), /guarded|active/i);
});
