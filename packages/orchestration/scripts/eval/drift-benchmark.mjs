#!/usr/bin/env node
/**
 * Runs the deterministic drift-detection benchmark and enforces its fixture-defined quality thresholds.
 */
import {
  existsSync as skillEntrypointExists,
  mkdirSync as createDirectory,
  mkdtempSync as createTempDirectory,
  readdirSync as listFixtureFiles,
  rmSync as removeTempDirectory,
  writeFileSync as writeTempTarget,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readJsonStrict, resolveWithinRepo, writeJson } from "../pipeline/lib/state.mjs";
import { parseArgs as parseCliArgs } from "../lib/argv.mjs";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";

assertSupportedNodeRuntime();

const TAXONOMY = ["interface", "invariant", "security", "performance", "docs"];
const MODES = ["heuristic", "dual-extractor"];
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseRatioArg(name, value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1`);
  }
  return num;
}

function parseArgs(argv) {
  return parseCliArgs(
    {
      defaults: {
        root: process.cwd(),
        output: ".pipeline/evaluations/drift-quality-report.json",
        precisionMin: 0.75,
        recallMin: 0.65,
        f1Min: 0.7,
      },
      options: {
        root: { type: "string" },
        output: { type: "string" },
        "precision-min": {
          key: "precisionMin",
          type: "number",
          parse: (value) => parseRatioArg("--precision-min", value),
        },
        "recall-min": {
          key: "recallMin",
          type: "number",
          parse: (value) => parseRatioArg("--recall-min", value),
        },
        "f1-min": {
          key: "f1Min",
          type: "number",
          parse: (value) => parseRatioArg("--f1-min", value),
        },
      },
    },
    argv.slice(2),
  );
}

function toMetrics(tp, fp, fn) {
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function evaluateByClass(expected, predicted) {
  const byClass = new Map();
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const cls of TAXONOMY) {
    const expectedCount = expected.filter((item) => item === cls).length;
    const predictedCount = predicted.filter((item) => item === cls).length;
    const tp = Math.min(expectedCount, predictedCount);
    const fp = Math.max(0, predictedCount - expectedCount);
    const fn = Math.max(0, expectedCount - predictedCount);

    byClass.set(cls, toMetrics(tp, fp, fn));
    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
  }

  return {
    overall: toMetrics(totalTp, totalFp, totalFn),
    byClass,
  };
}

function driftInput(fixture, targetRef, mode) {
  const driftConfig = { target_ref: targetRef, mode };
  if (mode !== "dual-extractor") {
    return {
      action: { type: "drift-detect" },
      document: { content: fixture.source, type: "plan" },
      drift_config: driftConfig,
    };
  }
  if (!Array.isArray(fixture.extractor_claim_sets) || fixture.extractor_claim_sets.length !== 2) {
    throw new Error(`fixture ${fixture.id} missing extractor_claim_sets for dual-extractor mode`);
  }
  return {
    action: { type: "drift-detect" },
    document: { content: fixture.source, type: "plan" },
    drift_config: { ...driftConfig, extractor_claim_sets: fixture.extractor_claim_sets },
  };
}

function runDriftSkill(skillEntrypoint, repoRoot, input) {
  const result = spawnSync("node", [skillEntrypoint], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, WORKSPACE_ROOT: repoRoot },
  });
  if (result.error) throw result.error;
  if (!result.stdout && !result.stderr) throw new Error("drift-detect returned empty output");
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "drift-detect failed");
  return result.stdout;
}

function parseDriftResult(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`drift-detect returned invalid JSON: ${String(error)}`);
  }
  if (!parsed.success) throw new Error(parsed.error?.message || "drift-detect failed");
  return parsed.data;
}

function runSkill(repoRoot, fixture, targetRef, mode) {
  const skillEntrypoint = resolve(repoRoot, "skills/dev-tools/multi-model-review/dist/index.js");
  if (!skillEntrypointExists(skillEntrypoint)) {
    throw new Error(
      "multi-model-review dist/index.js not found. Run npm run build in skills/dev-tools/multi-model-review first.",
    );
  }

  return parseDriftResult(
    runDriftSkill(skillEntrypoint, repoRoot, driftInput(fixture, targetRef, mode)),
  );
}

function normalizeExpected(fixture) {
  if (!Array.isArray(fixture.expected)) return [];
  return fixture.expected
    .filter((entry) => entry?.verification_status !== "verified")
    .map((entry) => entry.claim_type)
    .filter((entry) => TAXONOMY.includes(entry));
}

function normalizePredicted(driftResult) {
  if (!Array.isArray(driftResult?.claims)) return [];
  return driftResult.claims
    .filter((claim) => claim?.verification_status !== "verified")
    .map((claim) => claim.claim_type)
    .filter((entry) => TAXONOMY.includes(entry));
}

function thresholdFailed(metric, thresholds) {
  return (
    metric.precision < thresholds.precision ||
    metric.recall < thresholds.recall ||
    metric.f1 < thresholds.f1
  );
}

function requireFixtureObject(fixture, fileName) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error(`fixture ${fileName} must be an object`);
  }
}

function requireFixtureText(fixture, field, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`fixture ${fixture.id} is missing non-empty ${field}`);
  }
}

function validateFixtureShape(fixture, fileName) {
  requireFixtureObject(fixture, fileName);
  if (typeof fixture.id !== "string" || !FIXTURE_ID_PATTERN.test(fixture.id)) {
    throw new Error(
      `fixture ${fileName} has invalid id: must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
    );
  }
  requireFixtureText(fixture, "source", fixture.source);
  requireFixtureText(fixture, "target", fixture.target);
}

function benchmarkPaths(args) {
  const repoRoot = resolve(args.root);
  return {
    repoRoot,
    casesDir: resolve(repoRoot, "docs/eval/drift_goldset/cases"),
    outPath: resolveWithinRepo(args.output, repoRoot),
    workspaceTmpRoot: resolveWithinRepo(".pipeline/tmp", repoRoot),
    thresholds: {
      precision: args.precisionMin,
      recall: args.recallMin,
      f1: args.f1Min,
    },
  };
}

function modeResultStore() {
  return new Map(MODES.map((mode) => [mode, { expected: [], predicted: [], cases: [] }]));
}

function fixtureFiles(casesDir) {
  return listFixtureFiles(casesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

function collectFixtureResults({ files, casesDir, modeResults, repoRoot, tmpDir }) {
  for (const file of files) {
    const fixturePath = resolve(casesDir, file);
    const fixture = readJsonStrict(fixturePath);
    validateFixtureShape(fixture, file);
    const targetPath = join(tmpDir, `${fixture.id}.target.md`);
    writeTempTarget(targetPath, fixture.target, "utf8");
    const targetRef = relative(repoRoot, targetPath);
    const expected = normalizeExpected(fixture);

    for (const mode of MODES) {
      const drift = runSkill(repoRoot, fixture, targetRef, mode);
      const predicted = normalizePredicted(drift);
      const metrics = evaluateByClass(expected, predicted);
      const result = modeResults.get(mode);

      result.expected.push(...expected);
      result.predicted.push(...predicted);
      result.cases.push({
        case_id: fixture.id,
        metrics: { overall: metrics.overall, by_class: Object.fromEntries(metrics.byClass) },
        expected,
        predicted,
      });
    }
  }
}

function aggregateModeResults(modeResults) {
  const metricsByMode = new Map();
  const metricsByClass = new Map(TAXONOMY.map((cls) => [cls, new Map()]));

  for (const mode of MODES) {
    const result = modeResults.get(mode);
    const aggregate = evaluateByClass(result.expected, result.predicted);
    metricsByMode.set(mode, aggregate.overall);
    for (const cls of TAXONOMY) {
      metricsByClass.get(cls).set(mode, aggregate.byClass.get(cls));
    }
    result.aggregate = {
      overall: aggregate.overall,
      by_class: Object.fromEntries(aggregate.byClass),
    };
  }
  return { metricsByMode, metricsByClass };
}

function overallMetrics(metricsByMode) {
  const meanMetric = (metric) =>
    MODES.reduce((sum, mode) => sum + metric(metricsByMode.get(mode)), 0) / MODES.length;
  return {
    precision: meanMetric((metrics) => metrics.precision),
    recall: meanMetric((metrics) => metrics.recall),
    f1: meanMetric((metrics) => metrics.f1),
  };
}

function benchmarkReport({ files, thresholds, metricsByMode, metricsByClass, modeResults }) {
  const failedModes = MODES.filter((mode) => thresholdFailed(metricsByMode.get(mode), thresholds));
  return {
    generated_at: new Date().toISOString(),
    case_count: files.length,
    thresholds,
    metrics_by_mode: Object.fromEntries(metricsByMode),
    metrics_by_class: Object.fromEntries(
      [...metricsByClass].map(([cls, metrics]) => [cls, Object.fromEntries(metrics)]),
    ),
    overall: overallMetrics(metricsByMode),
    modes: Object.fromEntries(
      MODES.map((mode) => {
        const aggregate = modeResults.get(mode).aggregate;
        return [
          mode,
          {
            overall: aggregate.overall,
            by_class: aggregate.by_class,
            cases: modeResults.get(mode).cases,
          },
        ];
      }),
    ),
    status: failedModes.length === 0 ? "pass" : "fail",
    failed_modes: failedModes,
  };
}

function main() {
  const paths = benchmarkPaths(parseArgs(process.argv));
  createDirectory(paths.workspaceTmpRoot, { recursive: true });
  const tmpDir = createTempDirectory(join(paths.workspaceTmpRoot, "drift-benchmark-"));
  const files = fixtureFiles(paths.casesDir);
  const modeResults = modeResultStore();

  try {
    collectFixtureResults({ ...paths, files, modeResults, tmpDir });
    const { metricsByMode, metricsByClass } = aggregateModeResults(modeResults);
    const report = benchmarkReport({
      ...paths,
      files,
      metricsByMode,
      metricsByClass,
      modeResults,
    });
    writeJson(paths.outPath, report);
    process.stdout.write(`${paths.outPath}\n`);
    if (report.failed_modes.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    removeTempDirectory(tmpDir, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const code = error?.code || "E_DRIFT_BENCHMARK";
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}
