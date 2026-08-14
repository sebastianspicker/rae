/** Characterizes local v2.2 context bounds and durable wait signal semantics. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { validateWorkflow, workflowDigest } from "../lib/workflow-contract.mjs";
import {
  assembleWorkflowContextV22,
  ContextOverflowError,
  DEFAULT_CONTEXT_CAP_BYTES,
} from "../lib/workflow-context-v22.mjs";
import { scheduleWorkflowV22 } from "../lib/workflow-scheduler-v22.mjs";
import {
  earliestUnconsumedSignal,
  initialWorkflowV22State,
  recordWorkflowV22Signal,
  reduceWorkflowV22,
} from "../lib/workflow-v22-reducer.mjs";

function workflow22() {
  return {
    schema_version: "2.2.0",
    workflow_id: "wait-test",
    revision: 1,
    entry_node: "start",
    terminal_node: "complete",
    signal_contracts: {
      operator_confirmation: {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: { decision: { enum: ["approve", "reject"] } },
      },
    },
    budgets: { max_context_bytes: 16384 },
    nodes: [
      { id: "start", kind: "agent", access: "read", guidance: "start" },
      {
        id: "approval",
        kind: "wait",
        access: "control",
        guidance: "wait for local confirmation",
        wait: {
          timeout_seconds: 60,
          signals: ["approve", "reject"],
          signal_contract: "operator_confirmation",
        },
      },
      { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ],
    edges: [
      { from: "start", to: "approval", type: "sequence" },
      { from: "approval", to: "verify", type: "condition", condition: "success" },
      { from: "approval", to: "verify", type: "condition", condition: "failure" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ],
  };
}

describe("workflow v2.2 contracts", () => {
  test("uses the deterministic 128 KiB default and rejects invalid wait bounds", () => {
    expect(DEFAULT_CONTEXT_CAP_BYTES).toBe(128 * 1024);
    expect(validateWorkflow(workflow22()).schema_version).toBe("2.2.0");
    const invalid = workflow22();
    invalid.nodes[1].wait.timeout_seconds = 59;
    expect(() => validateWorkflow(invalid)).toThrow(/must be >= 60/);
    const missingSignalContract = workflow22();
    missingSignalContract.nodes[1].wait.signal_contract = "missing";
    expect(() => validateWorkflow(missingSignalContract)).toThrow(
      "invalid workflow: wait approval references unknown signal contract missing",
    );
  });

  test("uses immutable refs instead of partial objects and fails closed when refs exceed the cap", () => {
    const small = assembleWorkflowContextV22({
      capBytes: 16384,
      inputs: [
        {
          edge: { type: "artifact" },
          envelope: {
            node_id: "source",
            instance_id: "source",
            attempt: 1,
            output_digest: "a".repeat(64),
            payload: { body: "x".repeat(20000) },
          },
        },
      ],
    });
    expect(small.manifest.inline_artifacts.map(({ source }) => source)).toEqual([
      "task",
      "node-guidance",
      "mapped-item",
    ]);
    expect(small.manifest.artifact_refs).toHaveLength(1);
    expect(() =>
      assembleWorkflowContextV22({
        capBytes: 16384,
        inputs: Array.from({ length: 160 }, (_, index) => ({
          edge: { type: "artifact", artifact: "x".repeat(120) },
          envelope: {
            node_id: `source-${index}`,
            instance_id: `source-${index}`,
            attempt: 1,
            output_digest: "a".repeat(64),
            payload: { body: "x".repeat(20000) },
          },
        })),
      }),
    ).toThrow(ContextOverflowError);
  });

  test("orders mandatory and admitted optional context while accounting for policy denial", () => {
    const input = {
      edge: { type: "artifact" },
      envelope: {
        node_id: "source",
        instance_id: "source",
        attempt: 1,
        output_digest: "a".repeat(64),
        status: "passed",
        payload: { answer: 1 },
        findings: [{ severity: "low" }],
        evidence_refs: ["evidence.json"],
        changed_paths: ["src/a.mjs"],
        command_evidence: [{ command: "test" }],
        resource_usage: { ms: 1 },
      },
    };
    const assembled = assembleWorkflowContextV22({
      capBytes: 16384,
      task: "task",
      node: { id: "node", guidance: "guidance", context: { include_operational_evidence: true } },
      item: { id: "mapped" },
      inputs: [input],
      verifiedGraphRecords: [{ id: "graph", trust_class: "verified" }],
      admittedMemory: [{ id: "memory", trust_class: "admitted" }],
      contextPolicy: {
        optional_budget_bytes: 4096,
        allow_operational_evidence: true,
        allow_verified_graph: true,
        allow_admitted_memory: true,
      },
    });
    expect(assembled.prompt_context.items.map(({ source }) => source)).toEqual([
      "task",
      "node-guidance",
      "mapped-item",
      "predecessor",
      "operational",
      "verified-graph",
      "admitted-memory",
    ]);
    expect(assembled.manifest.included).toHaveLength(7);
    const denied = assembleWorkflowContextV22({
      capBytes: 16384,
      node: { id: "node", guidance: "guidance", context: { include_operational_evidence: true } },
      inputs: [input],
      verifiedGraphRecords: [{ id: "graph" }],
      admittedMemory: [{ id: "memory" }],
    });
    expect(denied.manifest.omitted.map(({ reason }) => reason)).toEqual([
      "policy-denied",
      "policy-denied",
      "policy-denied",
    ]);
  });

  test("fails mandatory context before an executor can run", async () => {
    const workflow = workflow22();
    const calls = [];
    await expect(
      scheduleWorkflowV22({
        workflow,
        runId: "overflow-run",
        runDir: mkdtempSync(resolve(tmpdir(), "rae-v22-overflow-")),
        task: "x".repeat(20000),
        execute: async () => calls.push("called"),
      }),
    ).rejects.toThrow(ContextOverflowError);
    expect(calls).toEqual([]);
  });
});

describe("workflow v2.2 wait reducer", () => {
  test("is idempotent and consumes the earliest accepted signal transactionally", () => {
    const state = initialWorkflowV22State({ runId: "run", workflowDigest: "a".repeat(64) });
    const opened = reduceWorkflowV22(state, {
      type: "wait-open",
      node_id: "approval",
      deadline_at: "2026-01-01T00:01:00.000Z",
      accepted_signals: ["approve"],
    });
    const late = reduceWorkflowV22(opened, {
      type: "signal-recorded",
      signal_id: "late",
      node_id: "approval",
      signal: "approve",
      idempotency_key: "late",
      occurred_at: "2026-01-01T00:02:00.000Z",
    });
    const early = reduceWorkflowV22(late, {
      type: "signal-recorded",
      signal_id: "early",
      node_id: "approval",
      signal: "approve",
      idempotency_key: "early",
      occurred_at: "2026-01-01T00:00:10.000Z",
    });
    const replayed = reduceWorkflowV22(early, {
      type: "signal-recorded",
      signal_id: "early",
      node_id: "approval",
      signal: "approve",
      idempotency_key: "early",
      occurred_at: "2026-01-01T00:00:10.000Z",
    });
    expect(replayed.signals).toHaveLength(2);
    expect(earliestUnconsumedSignal(replayed, "approval", ["approve"]).signal_id).toBe("early");
    const consumed = reduceWorkflowV22(replayed, {
      type: "wait-consume",
      node_id: "approval",
      signal_id: "early",
    });
    expect(
      earliestUnconsumedSignal(consumed, "approval", ["approve"], "2026-01-01T00:01:00.000Z"),
    ).toBeNull();
  });

  test("waits without invoking a provider, resumes from a local signal, and routes a timeout as failure", async () => {
    const workflow = workflow22();
    const runDir = mkdtempSync(resolve(tmpdir(), "rae-v22-wait-"));
    const calls = [];
    const execute = async ({ node }) => {
      calls.push(node.id);
      return { payload: { status: "passed" } };
    };
    const first = await scheduleWorkflowV22({
      workflow,
      runId: "wait-run",
      runDir,
      execute,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(first.status).toBe("waiting");
    expect(calls).toEqual(["start"]);
    recordWorkflowV22Signal({
      runDir,
      runId: "wait-run",
      workflowDigest: workflowDigest(workflow),
      nodeId: "approval",
      signal: "approve",
      idempotencyKey: "operator-1",
      now: "2026-01-01T00:00:01.000Z",
    });
    const resumed = await scheduleWorkflowV22({
      workflow,
      runId: "wait-run",
      runDir,
      execute,
      resumeEnvelopes: [...first.completed.values()],
      now: () => "2026-01-01T00:00:02.000Z",
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.completed.get("approval").payload.signal).toBe("approve");

    const timeoutDir = mkdtempSync(resolve(tmpdir(), "rae-v22-timeout-"));
    const waiting = await scheduleWorkflowV22({
      workflow,
      runId: "timeout-run",
      runDir: timeoutDir,
      execute,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const timedOut = await scheduleWorkflowV22({
      workflow,
      runId: "timeout-run",
      runDir: timeoutDir,
      execute,
      resumeEnvelopes: [...waiting.completed.values()],
      now: () => "2026-01-01T00:01:01.000Z",
    });
    expect(timedOut.status).toBe("completed");
    expect(timedOut.completed.get("approval").status).toBe("failed");
  });

  test("records a local agent signal idempotently and resumes the waiting run", async () => {
    const workflow = workflow22();
    const runDir = mkdtempSync(resolve(tmpdir(), "rae-v22-resume-"));
    const execute = async () => ({ payload: { status: "passed" } });
    const first = await scheduleWorkflowV22({
      workflow,
      runId: "signal-run",
      runDir,
      execute,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(first.status).toBe("waiting");
    const signalInput = {
      runDir,
      runId: "signal-run",
      workflowDigest: workflowDigest(workflow),
      nodeId: "approval",
      signal: "approve",
      idempotencyKey: "operator-1",
      payload: { decision: "approve" },
      now: "2026-01-01T00:00:01.000Z",
    };
    expect(recordWorkflowV22Signal(signalInput).signals).toHaveLength(1);
    expect(recordWorkflowV22Signal(signalInput).signals).toHaveLength(1);
    const resumed = await scheduleWorkflowV22({
      workflow,
      runId: "signal-run",
      runDir,
      execute,
      resumeEnvelopes: [...first.completed.values()],
      now: () => "2026-01-01T00:00:02.000Z",
    });
    expect(resumed.status).toBe("completed");
    const waitState = JSON.parse(
      readFileSync(resolve(runDir, "workflow", "wait-state.json"), "utf8"),
    );
    expect(waitState.consumed_signal_ids).toHaveLength(1);
  });
});

describe("workflow v2.2 scheduling bounds", () => {
  test("persists each retry attempt and resumes a failed attempt at the next number", async () => {
    const workflow = workflow22();
    workflow.nodes = [
      { id: "start", kind: "agent", access: "read", guidance: "start", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ];
    workflow.edges = [{ from: "start", to: "complete", type: "condition", condition: "success" }];
    workflow.terminal_node = "complete";
    workflow.budgets.max_attempts_per_node = 2;
    const runDir = mkdtempSync(resolve(tmpdir(), "rae-v22-retry-"));
    const seen = [];
    const result = await scheduleWorkflowV22({
      workflow,
      runId: "retry-run",
      runDir,
      execute: async ({ node, attempt }) => {
        seen.push(`${node.id}:${attempt}`);
        if (node.id === "start" && attempt === 1) throw new Error("transient");
        return { payload: { status: "passed" } };
      },
    });
    expect(result.status).toBe("completed");
    expect(seen).toContain("start:1");
    expect(seen).toContain("start:2");
    expect(
      readFileSync(resolve(runDir, "workflow", "attempts", "start", "start.1.json"), "utf8"),
    ).toContain('"status": "failed"');
    expect(
      readFileSync(resolve(runDir, "workflow", "attempts", "start", "start.2.json"), "utf8"),
    ).toContain('"status": "passed"');
  });

  test("reconstructs a persisted retry transition after interruption", async () => {
    const workflow = workflow22();
    workflow.nodes = [
      { id: "start", kind: "agent", access: "read", guidance: "start", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ];
    workflow.edges = [{ from: "start", to: "complete", type: "condition", condition: "success" }];
    workflow.budgets.max_attempts_per_node = 2;
    const runDir = mkdtempSync(resolve(tmpdir(), "rae-v22-resume-retry-"));
    await expect(
      scheduleWorkflowV22({
        workflow,
        runId: "resume-retry-run",
        runDir,
        execute: async () => {
          throw new Error("interruptible failure");
        },
        onEvent: ({ event }) => {
          if (event === "node_instance_retrying") throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    const failed = JSON.parse(
      readFileSync(resolve(runDir, "workflow", "attempts", "start", "start.1.json"), "utf8"),
    );
    const resumedAttempts = [];
    const resumed = await scheduleWorkflowV22({
      workflow,
      runId: "resume-retry-run",
      runDir,
      resumeEnvelopes: [failed],
      execute: async ({ attempt }) => {
        resumedAttempts.push(attempt);
        return { payload: { status: "passed" } };
      },
    });
    expect(resumed.status).toBe("completed");
    expect(resumedAttempts).toContain(2);
  });

  test("runs at most four readers concurrently and drains them before a writer", async () => {
    const workflow = workflow22();
    workflow.nodes = [
      { id: "entry", kind: "agent", access: "read", guidance: "entry" },
      { id: "plan", kind: "agent", access: "read", guidance: "plan", ownership_plan: true },
      {
        id: "checkpoint",
        kind: "checkpoint",
        access: "control",
        guidance: "checkpoint",
        mutation_checkpoint: true,
      },
      { id: "reader", kind: "agent", access: "read", guidance: "reader" },
      { id: "writer", kind: "agent", access: "write", guidance: "writer" },
      { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ];
    workflow.entry_node = "entry";
    workflow.edges = [
      { from: "entry", to: "plan", type: "sequence" },
      { from: "plan", to: "checkpoint", type: "sequence" },
      { from: "checkpoint", to: "reader", type: "sequence" },
      { from: "checkpoint", to: "writer", type: "sequence" },
      { from: "reader", to: "verify", type: "artifact" },
      { from: "writer", to: "verify", type: "artifact" },
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ];
    const timeline = [];
    await scheduleWorkflowV22({
      workflow,
      runId: "isolation-run",
      runDir: mkdtempSync(resolve(tmpdir(), "rae-v22-isolation-")),
      execute: async ({ node }) => {
        timeline.push(`start:${node.id}`);
        if (["reader", "writer"].includes(node.id))
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        timeline.push(`end:${node.id}`);
        return { payload: { status: "passed" } };
      },
    });
    expect(timeline.indexOf("end:writer")).toBeLessThan(timeline.indexOf("start:reader"));
  });

  test("limits a ready reader fan-out to four concurrent executions", async () => {
    const readers = ["one", "two", "three", "four", "five"];
    const workflow = workflow22();
    workflow.nodes = [
      { id: "entry", kind: "agent", access: "read", guidance: "entry" },
      ...readers.map((id) => ({ id, kind: "agent", access: "read", guidance: id })),
      { id: "verify", kind: "gate", access: "control", guidance: "verify", verification: true },
      { id: "complete", kind: "terminal", access: "control", guidance: "complete" },
    ];
    workflow.entry_node = "entry";
    workflow.edges = [
      ...readers.map((to) => ({ from: "entry", to, type: "sequence" })),
      ...readers.map((from) => ({ from, to: "verify", type: "artifact" })),
      { from: "verify", to: "complete", type: "condition", condition: "success" },
    ];
    let active = 0;
    let maximum = 0;
    await scheduleWorkflowV22({
      workflow,
      runId: "reader-limit-run",
      runDir: mkdtempSync(resolve(tmpdir(), "rae-v22-readers-")),
      execute: async ({ node }) => {
        if (readers.includes(node.id)) {
          active++;
          maximum = Math.max(maximum, active);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          active--;
        }
        return { payload: { status: "passed" } };
      },
    });
    expect(maximum).toBe(4);
  });
});
