/** Verifies graph-native workflow contracts, scheduling, and private registry behavior. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { loadWorkflow, validateWorkflow, workflowDigest } from "../lib/workflow-contract.mjs";
import { createWorkflowRegistry } from "../lib/workflow-registry.mjs";
import { scheduleWorkflow } from "../lib/workflow-scheduler.mjs";

const defaultPath = resolve(
  import.meta.dirname,
  "../../../workflows/graph-native-default.workflow.json",
);

function defaultWorkflow() {
  return JSON.parse(readFileSync(defaultPath, "utf8"));
}

function temporaryRepository() {
  const root = mkdtempSync(resolve(tmpdir(), "rae-workflow-registry-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "RAE Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "rae@example.invalid"]);
  writeFileSync(resolve(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

describe("workflow v2 contract", () => {
  test("accepts the committed arbitrary graph and has a stable digest", () => {
    const first = loadWorkflow(defaultPath);
    const second = loadWorkflow(defaultPath);
    expect(first.workflow.nodes.length).toBeGreaterThan(10);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
  });

  test.each([
    [
      "unreachable node",
      (workflow) =>
        workflow.nodes.push({ id: "orphan", kind: "agent", access: "read", guidance: "orphan" }),
    ],
    [
      "unbounded cycle",
      (workflow) => workflow.edges.push({ from: "design", to: "requirements", type: "sequence" }),
    ],
    [
      "remote payload reference",
      (workflow) => {
        workflow.payload_contracts.findings.properties.remote = {
          $ref: "https://example.invalid/schema.json",
        };
      },
    ],
    [
      "provider selection",
      (workflow) => {
        workflow.payload_contracts.findings.provider = { type: "string" };
      },
    ],
    [
      "invalid JSON Schema",
      (workflow) => {
        workflow.payload_contracts.findings.type = "not-a-json-schema-type";
      },
    ],
    [
      "unsafe writer path",
      (workflow) => {
        workflow.nodes.find((node) => node.id === "mutation-checkpoint").mutation_checkpoint =
          false;
      },
    ],
    [
      "terminal bypass",
      (workflow) => {
        workflow.edges.push({ from: "design", to: "complete", type: "sequence" });
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const workflow = defaultWorkflow();
    mutate(workflow);
    expect(() => validateWorkflow(workflow)).toThrow(/invalid workflow/);
  });

  test("rejects excessive repeated local references without pattern evaluation", () => {
    const workflow = defaultWorkflow();
    workflow.payload_contracts.findings = {
      $defs: { item: { type: "string" } },
      allOf: Array.from({ length: 33 }, () => ({ $ref: "#/$defs/item" })),
    };
    expect(() => validateWorkflow(workflow)).toThrow(/excessive reference expansion/);
  });
});

describe("workflow v2 scheduler", () => {
  test("caps readers, serializes shared resources, drains readers for writers, and aggregates joins", async () => {
    const workflow = defaultWorkflow();
    let readers = 0;
    let maximumReaders = 0;
    let writers = 0;
    let resourceUsers = 0;
    let maximumResourceUsers = 0;
    let designJoinInputs = 0;
    const seenSessions = new Set();
    const result = await scheduleWorkflow({
      workflow,
      runId: "scheduler-test",
      maxConcurrency: 4,
      execute: async ({ node, sessionId, inputs }) => {
        expect(seenSessions.has(sessionId)).toBe(false);
        seenSessions.add(sessionId);
        if (node.access === "write") {
          expect(readers).toBe(0);
          expect(writers).toBe(0);
          writers++;
        } else {
          expect(writers).toBe(0);
          readers++;
          maximumReaders = Math.max(maximumReaders, readers);
        }
        if (node.resource) {
          resourceUsers++;
          maximumResourceUsers = Math.max(maximumResourceUsers, resourceUsers);
        }
        await new Promise((accept) => setTimeout(accept, 2));
        if (node.resource) resourceUsers--;
        if (node.access === "write") writers--;
        else readers--;
        if (node.id === "design-collection") designJoinInputs = inputs.length;
        return { payload: { status: "passed", findings: [] } };
      },
    });
    expect(result.status).toBe("completed");
    expect(maximumReaders).toBe(4);
    expect(maximumResourceUsers).toBe(1);
    expect(designJoinInputs).toBe(4);
  });

  test("retries with a fresh session and stops at the attempt cap", async () => {
    const workflow = defaultWorkflow();
    const sessions = [];
    await expect(
      scheduleWorkflow({
        workflow,
        runId: "retry-test",
        execute: async ({ node, sessionId }) => {
          if (node.id === "requirements") {
            sessions.push(sessionId);
            throw new Error("fixture failure");
          }
          return { payload: {} };
        },
      }),
    ).rejects.toThrow("fixture failure");
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions).size).toBe(3);
  });

  test("repairs and re-verifies with fresh loop iterations", async () => {
    const workflow = defaultWorkflow();
    let verificationCalls = 0;
    const result = await scheduleWorkflow({
      workflow,
      runId: "repair-test",
      execute: async ({ node, loop_iteration: loopIteration }) => {
        if (node.id === "verification") {
          verificationCalls++;
          return verificationCalls === 1
            ? {
                status: "failed",
                payload: { status: "failed", marker: "first" },
                findings: [{ severity: "blocking", summary: "missing evidence" }],
              }
            : { status: "passed", payload: { status: "passed" } };
        }
        return { payload: { status: "passed", findings: [], loopIteration } };
      },
    });
    expect(result.status).toBe("completed");
    expect(verificationCalls).toBe(2);
    expect(result.completed.get("verification").loop_iteration).toBe(2);
  });

  test("terminates a repeated no-progress repair digest", async () => {
    const workflow = defaultWorkflow();
    const result = await scheduleWorkflow({
      workflow,
      runId: "no-progress-test",
      execute: async ({ node }) =>
        node.id === "verification"
          ? {
              status: "failed",
              payload: { status: "failed" },
              findings: [{ severity: "blocking", summary: "unchanged" }],
            }
          : { payload: { status: "passed", findings: [] } },
    });
    expect(result.status).toBe("repair-exhausted");
    expect(result.reason).toBe("no-progress");
  });

  test("terminates immediately when repair evidence reports budget exhaustion", async () => {
    const workflow = defaultWorkflow();
    const result = await scheduleWorkflow({
      workflow,
      runId: "budget-test",
      execute: async ({ node }) =>
        node.id === "verification"
          ? {
              status: "failed",
              payload: { status: "failed", budget_available: false },
              findings: [{ severity: "blocking", summary: "budget" }],
            }
          : { payload: { status: "passed", findings: [] } },
    });
    expect(result.reason).toBe("budget-exhausted");
  });
});

describe("workflow v2 registry", () => {
  test("uses optimistic revisions and typed digest activation without changing existing runs", () => {
    const root = temporaryRepository();
    const registry = createWorkflowRegistry(root);
    const base = registry.show("graph-native-default");
    const workflow = structuredClone(base.workflow);
    workflow.revision = 2;
    workflow.title = "Candidate revision";
    const record = registry.draft("graph-native-default", {
      expected_revision: 1,
      actor: "maintainer",
      rationale: "test revision",
      workflow,
    });
    expect(record.digest).toBe(workflowDigest(workflow));
    expect(() =>
      registry.draft("graph-native-default", {
        expected_revision: 1,
        actor: "maintainer",
        rationale: "stale",
        workflow,
      }),
    ).toThrow(/conflict/);
    expect(() =>
      registry.activate("graph-native-default", 2, {
        digest: "0".repeat(64),
        actor: "maintainer",
        rationale: "wrong digest",
      }),
    ).toThrow(/digest/);
    const activation = registry.activate("graph-native-default", 2, {
      digest: record.digest,
      actor: "maintainer",
      rationale: "reviewed evidence",
    });
    expect(activation.decision).toBe("activated");
    expect(registry.show("graph-native-default").activation_history).toHaveLength(1);
  });

  test("rejects CLI registry mutations while an autonomous run lock is active", () => {
    const root = temporaryRepository();
    const registry = createWorkflowRegistry(root);
    const base = registry.show("graph-native-default");
    const workflow = structuredClone(base.workflow);
    workflow.revision = 2;
    const runId = "active-registry-test";
    const runDir = resolve(root, ".pipeline", "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(root, ".pipeline", "pipeline-state.json"),
      `${JSON.stringify({ run_id: runId })}\n`,
    );
    writeFileSync(resolve(runDir, "autonomous.lock"), "{}\n");
    expect(() =>
      registry.draft("graph-native-default", {
        expected_revision: 1,
        actor: "maintainer",
        rationale: "must wait",
        workflow,
      }),
    ).toThrow(/active/);
  });
});
