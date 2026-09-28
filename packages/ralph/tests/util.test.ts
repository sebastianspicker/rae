/** Verifies deterministic shared Ralph utility transformations. */
import assert from "node:assert/strict";
import test from "node:test";
import { isoUtcCompact } from "../src/util.js";

test("isoUtcCompact emits a filesystem-safe UTC timestamp", () => {
  assert.equal(isoUtcCompact(new Date("2024-02-03T04:05:06.789Z")), "20240203-040506Z");
});
