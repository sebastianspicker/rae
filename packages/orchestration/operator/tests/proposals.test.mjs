/** Verifies workflow proposal field validation keeps its public HTTP contract stable. */
import assert from "node:assert/strict";
import test from "node:test";
import { validateProposalBody, validateProposalFields } from "../lib/proposals.mjs";

test("proposal body shape and allowlist reject untrusted fields with stable errors", () => {
  for (const body of [null, [], "task"]) {
    assert.throws(() => validateProposalBody(body), {
      status: 400,
      message: "proposal body is required",
    });
  }
  assert.throws(() => validateProposalBody({ task: "safe", provider: "remote" }), {
    status: 400,
    message: "unsupported proposal field: provider",
  });
});

test("proposal fields normalize valid input and preserve validation error status", () => {
  assert.deepEqual(validateProposalFields({ task: "  safe task  ", base_revision: "3" }), {
    task: "safe task",
    baseRevision: "3",
    executionProfileId: null,
  });
  assert.throws(() => validateProposalFields({ task: "  " }), {
    status: 400,
    message: "proposal task is required",
  });
  assert.throws(() => validateProposalFields({ task: "x".repeat(32 * 1024 + 1) }), {
    status: 413,
    message: "proposal task exceeds 32768 bytes",
  });
  assert.throws(() => validateProposalFields({ task: "safe", base_revision: "1.5" }), {
    status: 400,
    message: "invalid base_revision",
  });
});
