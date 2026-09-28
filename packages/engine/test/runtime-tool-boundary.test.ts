/** Verifies runtime tools resolve both current and persisted schema references. */
import assert from "node:assert/strict";
import test from "node:test";
import { runQualityGate } from "../src/run/gates.js";
import { currentSchemaReference } from "../src/primitives/schema-reference.js";
import { TRACE_SCHEMA_REFERENCE } from "../src/run/trace.js";

const BRIEF = {
  requirements: [{ id: "req-1", description: "Preserve evidence", priority: "must" }],
  constraints: [],
  non_goals: [],
  style: { tone: "concise" },
  key_concepts: [],
  decisions: [],
  open_questions: [],
};

test("runtime tools execute through package exports against versioned contracts", () => {
  const result = runQualityGate({
    artifact: BRIEF,
    artifact_ref: "brief.json",
    schema_ref: "packages/contracts/v1/schemas/artifacts/brief.schema.json",
    phase: "arm",
    criteria: [],
  });
  assert.equal(result.status, "pass");
});

test("persisted legacy contract references migrate only when a versioned schema exists", () => {
  assert.equal(
    currentSchemaReference("contracts/artifacts/brief.schema.json"),
    "packages/contracts/v1/schemas/artifacts/brief.schema.json",
  );
  assert.equal(
    currentSchemaReference("contracts/custom.schema.json"),
    "contracts/custom.schema.json",
  );
});

test("new trace-tool inputs use the versioned contract path", () => {
  assert.equal(
    TRACE_SCHEMA_REFERENCE,
    "packages/contracts/v1/schemas/artifacts/execution-trace.schema.json",
  );
});
