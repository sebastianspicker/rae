/** Verifies command-line parsing rejects unsafe object keys. */
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../lib/argv.mjs";

describe("parseArgs unsafe keys", () => {
  it.each(["__proto__", "constructor", "toString"])("rejects option key %s", (key) => {
    expect(() => parseArgs({ options: {} }, [`--${key}`, "value"])).toThrow(
      "option name is not allowed",
    );
  });

  it("rejects an unsafe remapped output key", () => {
    expect(() =>
      parseArgs({ options: { safe: { type: "string", key: "constructor" } } }, ["--safe", "value"]),
    ).toThrow("option output key is not allowed");
  });

  it("returns a null-prototype record for safe options", () => {
    const parsed = parseArgs({ options: { name: { type: "string" } } }, ["--name", "safe"]);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ name: "safe" });
  });
});
