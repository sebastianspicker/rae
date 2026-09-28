/** Verifies catalogue filters and evidence markers preserve run-state semantics. */
import assert from "node:assert/strict";
import test from "node:test";
import { runTone } from "../static/js/format.js";
import { evidenceTone } from "../static/js/task-view.js";
import type { OperatorRun } from "../static/js/types.js";

function run(status: string, overrides: Partial<OperatorRun> = {}): OperatorRun {
  return { id: `run-${status}`, status, ...overrides };
}

test("catalogue tones distinguish human holds from timed workflow waits", () => {
  assert.equal(runTone(run("waiting", { needs_human_decision: true })), "blocked");
  assert.equal(runTone(run("waiting", { checkpoints: [{ status: "pending" }] })), "blocked");
  assert.equal(runTone(run("waiting", { needs_human_decision: false })), "active");
  assert.equal(runTone(run("running")), "active");
  assert.equal(runTone(run("completed")), "proof");
});

test("evidence markers distinguish live, held, passed, failed, and neutral runs", () => {
  assert.equal(evidenceTone(run("running"), false), "active");
  assert.equal(evidenceTone(run("stop-requested"), false), "active");
  assert.equal(evidenceTone(run("waiting", { needs_human_decision: true }), false), "pending");
  assert.equal(evidenceTone(run("waiting", { needs_human_decision: false }), false), "active");
  assert.equal(evidenceTone(run("stopped", { controls: { resume: true } }), false), "pending");
  assert.equal(evidenceTone(run("completed"), false), "proof");
  assert.equal(evidenceTone(run("blocked"), false), "error");
  assert.equal(evidenceTone(run("interrupted"), false), "error");
  assert.equal(evidenceTone(run("stopped"), false), "muted");
});
