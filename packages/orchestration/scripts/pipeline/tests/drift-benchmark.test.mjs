/** Validates drift benchmark fixture-key hardening and the stable report contract. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../../..");
const benchmark = resolve(packageRoot, "scripts/eval/drift-benchmark.mjs");
const casesDir = resolve(packageRoot, "docs/eval/drift_goldset/cases");
const MODES = ["heuristic", "dual-extractor"];
const TAXONOMY = ["interface", "invariant", "security", "performance", "docs"];

function writeFakeNode(
  output = '{"success":true,"data":{"claims":[{"claim_type":"security","verification_status":"violated"}]}}',
) {
  const binDir = mkdtempSync(join(tmpdir(), "rae-drift-node-"));
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`, "utf8");
  chmodSync(nodePath, 0o755);
  return binDir;
}

function runBenchmark({ env = process.env, output } = {}) {
  return spawnSync(
    process.execPath,
    [
      benchmark,
      "--root",
      packageRoot,
      "--output",
      output,
      "--precision-min",
      "0",
      "--recall-min",
      "0",
      "--f1-min",
      "0",
    ],
    { cwd: packageRoot, encoding: "utf8", env },
  );
}

describe("drift benchmark fixture-key hardening", () => {
  it.each(["__proto__", "constructor", "toString"])("rejects forbidden fixture key %s", (key) => {
    const fixturePath = join(casesDir, "00-forbidden-fixture-key.json");
    const fixture = {
      id: "forbidden-fixture-key",
      source: "source",
      target: "target",
      expected: [],
    };
    Object.defineProperty(fixture, key, { enumerable: true, value: "poison" });
    writeFileSync(fixturePath, `${JSON.stringify(fixture)}\n`, "utf8");

    try {
      const result = runBenchmark({ output: ".pipeline/tmp/forbidden-fixture-key-report.json" });
      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        `fixture 00-forbidden-fixture-key.json has forbidden key: ${key}`,
      );
    } finally {
      unlinkSync(fixturePath);
    }
  });

  it.each([
    ["null", "null"],
    ["number", "42"],
    ["array", "[]"],
  ])("rejects a %s drift-detect response without a TypeError", (_name, output) => {
    const binDir = writeFakeNode(output);
    try {
      const result = runBenchmark({
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        output: ".pipeline/tmp/invalid-drift-detect-response.json",
      });
      expect(result.status).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        "E_DRIFT_BENCHMARK: drift-detect failed",
      );
      expect(`${result.stderr}\n${result.stdout}`).not.toContain("TypeError");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("preserves the golden report schema and mode/class ordering", () => {
    const binDir = writeFakeNode();
    const reportDir = mkdtempSync(join(packageRoot, ".pipeline/tmp/drift-benchmark-report-"));
    const reportPath = join(reportDir, "report.json");
    const output = relative(packageRoot, reportPath);

    try {
      const result = runBenchmark({
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        output,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(reportPath);

      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      expect(Object.keys(report)).toEqual([
        "generated_at",
        "case_count",
        "thresholds",
        "metrics_by_mode",
        "metrics_by_class",
        "overall",
        "modes",
        "status",
        "failed_modes",
      ]);
      expect(report.case_count).toBe(2);
      expect(report.thresholds).toEqual({ precision: 0, recall: 0, f1: 0 });
      expect(Object.keys(report.metrics_by_mode)).toEqual(MODES);
      expect(Object.keys(report.metrics_by_class)).toEqual(TAXONOMY);
      expect(Object.keys(report.modes)).toEqual(MODES);
      for (const mode of MODES) {
        expect(Object.keys(report.metrics_by_class.security[mode])).toEqual([
          "precision",
          "recall",
          "f1",
        ]);
        expect(Object.keys(report.modes[mode].by_class)).toEqual(TAXONOMY);
      }
      expect(report).toMatchObject({ status: "pass", failed_modes: [] });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(reportDir, { recursive: true, force: true });
    }
  });
});
