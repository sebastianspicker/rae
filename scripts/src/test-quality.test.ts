/** Purpose: preserve fail-closed analyzer coverage and executable TypeScript function limits. */
import assert from "node:assert/strict";
import test from "node:test";
import { assertInspection, assertCompleteAnalysis } from "./codacy-local.js";
import { measureFunctions, complexityViolations } from "./check-complexity.js";
const tools = [
  { toolId: "Hadolint", version: "2.14.0", status: "success" },
  { toolId: "markdownlint", status: "success" },
  { toolId: "Trivy", version: "0.72.0", status: "success" },
  { toolId: "Semgrep", version: "1.25.0", status: "success" },
  { toolId: "jackson", status: "success" },
];
test("quality inspection and reports reject partial, malformed and mismatched tools", () => {
  assertInspection({ errors: [], capability: { unavailable: [], ready: tools } });
  assert.equal(assertCompleteAnalysis({ errors: [], issues: [1, 2], toolResults: tools }), 2);
  assert.throws(
    () => assertInspection({ errors: [], capability: { unavailable: [], ready: tools.slice(1) } }),
    /unavailable/,
  );
  assert.throws(
    () =>
      assertInspection({
        errors: [],
        capability: {
          unavailable: [],
          ready: tools.map((tool) => ({ ...tool, version: "0.0.0" })),
        },
      }),
    /must be/,
  );
  assert.throws(
    () => assertCompleteAnalysis({ errors: [], issues: [], toolResults: tools.slice(1) }),
    /partial/,
  );
  assert.throws(() => assertCompleteAnalysis({ issues: [], toolResults: tools }), /array/);
});
test("complexity isolates nested functions, ignores comments and counts logical branches", () => {
  const result = measureFunctions(
    "example.ts",
    `function outer(a: boolean, b: boolean) {\n// if while && ignored\n if (a && b) return 1;\n const inner = () => a ? 1 : 2;\n return inner();\n}`,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0]?.complexity, 3);
  assert.equal(result[0]?.codeLines, 5);
  assert.equal(result[0]?.parameters, 2);
  assert.equal(result[1]?.complexity, 2);
  assert.deepEqual(complexityViolations(result), []);
  assert.equal(
    complexityViolations([
      { file: "f.ts", line: 1, name: "f", complexity: 13, codeLines: 1, parameters: 0 },
    ]).length,
    1,
  );
});
