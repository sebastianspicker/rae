/** Verifies command-line parsing rejects unsafe object keys. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/primitives/argv.js";

for (const key of ["__proto__", "constructor", "toString"]) {
  test(`parseArgs unsafe keys rejects option key ${key}`, () => {
    assert.throws(
      () => parseArgs({ options: {} }, [`--${key}`, "value"]),
      /option name is not allowed/,
    );
  });
}

test("parseArgs unsafe keys rejects an unsafe remapped output key", () => {
  assert.throws(
    () =>
      parseArgs({ options: { safe: { type: "string", key: "constructor" } } }, ["--safe", "value"]),
    /option output key is not allowed/,
  );
});

test("parseArgs unsafe keys returns a null-prototype record for safe options", () => {
  const parsed = parseArgs({ options: { name: { type: "string" } } }, ["--name", "safe"]);
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { name: "safe" });
});
