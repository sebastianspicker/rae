/** Locks the committed workflow bytes to their canonical schema and digest contract. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflow, validateWorkflow, workflowDigest } from "../src/public/index.mjs";

const defaultWorkflowPath = resolve(import.meta.dirname, "../../../workflows/graph-native-default.workflow.json");
const DEFAULT_WORKFLOW_BYTES_DIGEST = "bfd7f4829380a7c10dc9ab26cfd6e8c61ff2e92d1c3c6e754a1438f6e3557ba2";
const DEFAULT_WORKFLOW_DIGEST = "94caf7365384eb9a90d15dd05022deed304e6f3f389ced6ce49f066397b7f7f9";

test("the canonical default workflow resolves through its versioned schema", () => {
  const bytes = readFileSync(defaultWorkflowPath);
  const source = JSON.parse(bytes);
  const resolved = loadWorkflow(defaultWorkflowPath);

  assert.deepEqual(resolved.workflow, validateWorkflow(source));
  assert.equal(resolved.digest, DEFAULT_WORKFLOW_DIGEST);
  assert.equal(workflowDigest(source), DEFAULT_WORKFLOW_DIGEST);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), DEFAULT_WORKFLOW_BYTES_DIGEST);
  assert.equal(resolved.workflow.schema_version, "2.0.0");
});

test("schema resolution still rejects a workflow outside its immutable contract", () => {
  const source = JSON.parse(readFileSync(defaultWorkflowPath, "utf8"));
  assert.throws(
    () => validateWorkflow({ ...source, unapproved_runtime_switch: true }),
    /invalid workflow:/,
  );
});
