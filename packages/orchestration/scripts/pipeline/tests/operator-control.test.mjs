/** Verifies durable stop and checkpoint records remain atomic and attributable. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {
  checkpointPolicy,
  createCheckpoint,
  getCheckpointPath,
  listCheckpoints,
  readOperatorControl,
  requestStop,
  resolveCheckpoint,
  setRunStatus,
} from "../lib/operator-control.mjs";

const roots = [];
const packageRoot = resolve(import.meta.dirname, "../../..");

function controlSchemaValidator() {
  const schema = JSON.parse(
    readFileSync(resolve(packageRoot, "contracts/artifacts/operator-control.schema.json"), "utf8"),
  );
  return new Ajv2020({ allErrors: false, strict: false, validateFormats: false }).compile(schema);
}

function root() {
  const value = mkdtempSync(join(tmpdir(), "rae operator control "));
  roots.push(value);
  return value;
}
afterEach(() => {
  roots.splice(0).forEach((value) => {
    rmSync(value, { recursive: true, force: true });
  });
});

describe("operator control records", () => {
  it("defaults legacy requests to no checkpoint policy", () => {
    expect(checkpointPolicy()).toBe("none");
    expect(() => checkpointPolicy("unsafe")).toThrow(/checkpoint_policy/);
  });

  it("creates deterministic checkpoints and accepts only idempotent decisions", () => {
    const workspace = root();
    const first = createCheckpoint(
      "run-1",
      { phase: "build", purpose: "mutation", message: "approve" },
      workspace,
    );
    const again = createCheckpoint(
      "run-1",
      { phase: "build", purpose: "mutation", message: "ignored" },
      workspace,
    );
    expect(again).toEqual(first);
    expect(first.checkpoint_id).toMatch(/^checkpoint-[a-f0-9]{24}$/);
    expect(first.request_key).toMatch(/^[a-f0-9]{64}$/);
    expect(listCheckpoints("run-1", workspace)).toEqual([first]);
    const decision = {
      phase: "build",
      purpose: "mutation",
      status: "approved",
      decisionId: "decision-1",
      actor: "local-operator",
      rationale: "Plan ownership and tests were reviewed.",
    };
    const approved = resolveCheckpoint("run-1", decision, workspace);
    expect(approved.status).toBe("approved");
    expect(approved.decision.actor).toBe("local-operator");
    expect(resolveCheckpoint("run-1", decision, workspace)).toEqual(approved);
    expect(() =>
      resolveCheckpoint(
        "run-1",
        { ...decision, status: "rejected", decisionId: "decision-2" },
        workspace,
      ),
    ).toThrow(/conflicting terminal decision/);
  });

  it("persists phase-boundary stop requests without process control", () => {
    const workspace = root();
    expect(readOperatorControl("run-2", workspace).status).toBe("running");
    setRunStatus("run-2", "running", workspace);
    expect(requestStop("run-2", workspace)).toMatchObject({
      status: "stop-requested",
      stop_requested: true,
    });
    expect(setRunStatus("run-2", "running", workspace, { stop_requested: false })).toMatchObject({
      status: "stop-requested",
      stop_requested: true,
    });
    expect(setRunStatus("run-2", "completed", workspace, { stop_requested: false })).toMatchObject({
      status: "stop-requested",
      stop_requested: true,
    });
  });

  it("fails closed while another process owns the control lock", () => {
    const workspace = root();
    const runDir = join(workspace, ".pipeline", "runs", "run-locked");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "operator-control.json.lock"), "", { mode: 0o600 });
    expect(() => setRunStatus("run-locked", "running", workspace)).toThrow(
      /operator control is being updated/,
    );
  });

  it("does not partially commit a checkpoint while control is locked", () => {
    const workspace = root();
    const checkpoint = createCheckpoint(
      "run-atomic",
      { phase: "build", purpose: "mutation", message: "approve" },
      workspace,
    );
    setRunStatus("run-atomic", "waiting", workspace, {
      waiting_checkpoint_id: checkpoint.checkpoint_id,
    });
    const runDir = join(workspace, ".pipeline", "runs", "run-atomic");
    const controlLock = join(runDir, "operator-control.json.lock");
    writeFileSync(controlLock, "", { mode: 0o600 });
    const decision = {
      phase: "build",
      purpose: "mutation",
      status: "rejected",
      decisionId: "decision-atomic",
      actor: "local-operator",
      rationale: "The diff does not match the approved scope.",
    };
    expect(() => resolveCheckpoint("run-atomic", decision, workspace)).toThrow(
      /operator control is being updated/,
    );
    expect(listCheckpoints("run-atomic", workspace)[0].status).toBe("pending");
    rmSync(controlLock);

    expect(resolveCheckpoint("run-atomic", decision, workspace).status).toBe("rejected");
    expect(readOperatorControl("run-atomic", workspace)).toMatchObject({
      status: "blocked",
      waiting_checkpoint_id: null,
    });
  });

  it("repairs control state on an idempotent retry after a terminal checkpoint write", () => {
    const workspace = root();
    const checkpoint = createCheckpoint(
      "run-repair",
      { phase: "build", purpose: "mutation", message: "approve" },
      workspace,
    );
    setRunStatus("run-repair", "waiting", workspace, {
      waiting_checkpoint_id: checkpoint.checkpoint_id,
    });
    const decision = {
      phase: "build",
      purpose: "mutation",
      status: "escalated",
      decisionId: "decision-repair",
      actor: "local-operator",
      rationale: "A maintainer must inspect the unexpected ownership change.",
    };
    const resolvedAt = new Date().toISOString();
    writeFileSync(
      getCheckpointPath("run-repair", "build", "mutation", workspace),
      `${JSON.stringify({
        ...checkpoint,
        status: "escalated",
        decision: {
          decision_id: decision.decisionId,
          outcome: decision.status,
          actor: decision.actor,
          at: resolvedAt,
          rationale: decision.rationale,
        },
        resolved_at: resolvedAt,
      })}\n`,
      "utf8",
    );

    expect(resolveCheckpoint("run-repair", decision, workspace).status).toBe("escalated");
    expect(readOperatorControl("run-repair", workspace).status).toBe("blocked");
  });

  it("persists interrupted state that conforms to the published control schema", () => {
    const workspace = root();
    const interrupted = setRunStatus("run-interrupted", "interrupted", workspace, {
      interrupted_at: new Date().toISOString(),
    });
    const validateSchema = controlSchemaValidator();
    expect(validateSchema(interrupted)).toBe(true);
    expect(validateSchema({ ...interrupted, undeclared: true })).toBe(false);
  });
});
