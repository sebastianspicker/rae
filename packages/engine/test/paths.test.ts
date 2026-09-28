/** Verifies the shared path-containment primitive against escape, traversal, and lookalike cases. */
import assert from "node:assert/strict";
import test from "node:test";
import { contained } from "../src/graph/core.js";
import { isContainedRelative, isWithinRoot } from "../src/primitives/paths.js";

test("isContainedRelative accepts the root itself, sibling names, and nested paths", () => {
  assert.equal(isContainedRelative(""), true);
  assert.equal(isContainedRelative("x"), true);
  assert.equal(isContainedRelative("nested/child"), true);
  assert.equal(isContainedRelative("..x"), true);
});

test("isContainedRelative rejects traversal above the relation's origin", () => {
  assert.equal(isContainedRelative(".."), false);
  assert.equal(isContainedRelative("../x"), false);
  assert.equal(isContainedRelative("../../x"), false);
});

test("isContainedRelative rejects an absolute relation", () => {
  assert.equal(isContainedRelative("/etc/passwd"), false);
});

test("isWithinRoot is inclusive of the root and rejects escapes and lookalike siblings", () => {
  assert.equal(isWithinRoot("/repo", "/repo"), true);
  assert.equal(isWithinRoot("/repo", "/repo/child"), true);
  assert.equal(isWithinRoot("/repo", "/repo/..x"), true);
  assert.equal(isWithinRoot("/repo", "/other"), false);
  assert.equal(isWithinRoot("/repo", "/"), false);
});

test("graph containment is strictly below the root and accepts dot-prefixed entry names", () => {
  assert.equal(contained("/repo/.pipeline/runs/..cache", "/repo/.pipeline/runs"), true);
  assert.equal(contained("/repo/.pipeline/runs/run-1", "/repo/.pipeline/runs"), true);
  assert.equal(contained("/repo/.pipeline/runs", "/repo/.pipeline/runs"), false);
  assert.equal(contained("/repo/.pipeline/other", "/repo/.pipeline/runs"), false);
});
