/** Verifies direct Node entrypoints enforce the repository runtime range. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSupportedNodeRuntime, nodeVersionSupported } from "../../lib/node-runtime.mjs";

describe("direct Node runtime guard", () => {
  it.each([
    ["18.20.8", false],
    ["20.18.3", false],
    ["20.19.0", true],
    ["21.7.3", false],
    ["22.11.0", false],
    ["22.12.0", true],
    ["23.11.1", false],
    ["24.0.0", true],
    ["26.5.0", true],
  ])("classifies Node %s", (version, supported) => {
    expect(nodeVersionSupported(version)).toBe(supported);
  });

  it("rejects unsupported direct-entrypoint runtimes with the package range", () => {
    expect(() => assertSupportedNodeRuntime("18.20.8")).toThrow(
      />=20\.19\.0 <21 \|\| >=22\.12\.0 <23 \|\| >=24\.0\.0/,
    );
  });

  it("guards aggregate and drift direct entrypoints before parsing CLI input", () => {
    for (const entrypoint of ["aggregate.mjs", "drift-benchmark.mjs"]) {
      const source = readFileSync(resolve(import.meta.dirname, "../../eval", entrypoint), "utf8");
      expect(source).toMatch(
        /import \{ assertSupportedNodeRuntime \} from "\.\.\/lib\/node-runtime\.mjs"/,
      );
      expect(source.indexOf("assertSupportedNodeRuntime();")).toBeLessThan(
        source.indexOf("function parseArgs"),
      );
    }
  });
});
