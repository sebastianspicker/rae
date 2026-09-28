/** Keeps browser task validation consistent with the UTF-8 HTTP request bound. */
import assert from "node:assert/strict";
import test from "node:test";
import { validateTask } from "../static/js/task-input.js";

test("task validation counts UTF-8 bytes, preserving exact ASCII and Unicode limits", () => {
  assert.match(validateTask(" \n\t") ?? "", /Describe/);
  assert.equal(validateTask("x".repeat(32768)), null);
  assert.match(validateTask("x".repeat(32769)) ?? "", /32 KiB/);
  assert.equal(validateTask("🧪".repeat(8192)), null);
  assert.match(validateTask("🧪".repeat(8193)) ?? "", /32 KiB/);
});
