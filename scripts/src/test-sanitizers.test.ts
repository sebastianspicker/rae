/** Sanitized reports retain stable finding identities while discarding free-form content. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeCodacy, sanitizeCodeql } from "./sanitize-reports.js";
import { renderSvg, wrapLines } from "./generate-docs-screenshots.js";
import { validateTerminalSvg } from "./validate-assets.js";
test("Codacy projection removes free-form and workstation fields", () => {
  const marker = "MUST_NOT_SURVIVE_SANITIZATION";
  const result = sanitizeCodacy({
    metadata: { startedAt: "now", repositoryRoot: "/private/worktree" },
    toolResults: [{ toolId: "Example", status: "success", message: marker }],
    issues: [
      {
        toolId: "Example",
        patternId: "RULE",
        filePath: "src/a.ts",
        line: 1,
        column: 1,
        severity: "High",
        category: "Security",
        lineContent: marker,
        message: marker,
      },
    ],
    errors: [{ toolId: "Example", filePath: "src/a.ts", phase: "parse", message: marker }],
    unknown: marker,
  });
  assert.doesNotMatch(
    JSON.stringify(result),
    /MUST_NOT_SURVIVE_SANITIZATION|lineContent|repositoryRoot|message|unknown/,
  );
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.issues, [
    {
      toolId: "Example",
      patternId: "RULE",
      filePath: "src/a.ts",
      line: 1,
      column: 1,
      endColumn: null,
      severity: "High",
      category: "Security",
    },
  ]);
});
test("CodeQL projection retains locations and rule identity only", () => {
  const results = sanitizeCodeql([
    {
      runs: [
        {
          results: [
            {
              ruleId: "js/fixture",
              level: "error",
              message: { text: "private content" },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/a.ts" },
                    region: { startLine: 2, startColumn: 3, snippet: { text: "private content" } },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(results, [
    {
      ruleId: "js/fixture",
      level: "error",
      locations: [{ artifactUri: "src/a.ts", startLine: 2, startColumn: 3 }],
    },
  ]);
  assert.throws(() => sanitizeCodacy([]), /object/);
  assert.throws(() => sanitizeCodeql({}), /array/);
});
test("terminal SVG rendering escapes output and preserves empty and wrapped lines", () => {
  const output = 'Help <command> & "quoted"\n\n' + "word ".repeat(40);
  const svg = renderSvg({ title: "RAE & CLI", prompt: "$ npm run rae -- --help" }, output);
  validateTerminalSvg(svg, "fixture.svg");
  assert.ok(svg.includes("Help &lt;command&gt; &amp; &quot;quoted&quot;"));
  assert.ok(wrapLines(output).includes(""));
  assert.ok(wrapLines(output).length > 3);
});
