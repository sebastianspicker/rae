#!/usr/bin/env node
/**
 * Runs the deterministic drift-detection benchmark and enforces its fixture-defined quality thresholds.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWithinRepo } from "../pipeline/lib/state.mjs";
import { parseArgs as parseCliArgs } from "../lib/argv.mjs";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";

assertSupportedNodeRuntime();

const TAXONOMY = ["interface", "invariant", "security", "performance", "docs"];
const MODES = ["heuristic", "dual-extractor"];
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UNSAFE_FIXTURE_KEYS = new Set(["__proto__", "prototype", "constructor", "toString"]);

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

function serializeMetrics(metrics) {
  return {
    overall: metrics.overall,
    by_class: Object.fromEntries(metrics.byClass),
  };
}

function runSkill(repoRoot, fixture, targetRef, mode) {
  const skillEntrypoint = resolve(repoRoot, "skills/dev-tools/multi-model-review/dist/index.js");
  if (!existsSync(skillEntrypoint)) {
    throw new Error(
      "multi-model-review dist/index.js not found. Run npm run build in skills/dev-tools/multi-model-review first.",
    );
  }

  const driftConfig = {
    target_ref: targetRef,
    mode,
  };

  if (mode === "dual-extractor") {
    if (
      !Object.hasOwn(fixture, "extractor_claim_sets") ||
      !Array.isArray(fixture.extractor_claim_sets) ||
      fixture.extractor_claim_sets.length !== 2
    ) {
      throw new Error(`fixture ${fixture.id} missing extractor_claim_sets for dual-extractor mode`);
    }
    driftConfig.extractor_claim_sets = fixture.extractor_claim_sets;
  }

  const input = {
    action: { type: "drift-detect" },
    document: { content: fixture.source, type: "plan" },
    drift_config: driftConfig,
  };

  const result = spawnSync("node", [skillEntrypoint], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      WORKSPACE_ROOT: repoRoot,
    },
  });

  const rawOut = result.stdout || result.stderr;
  if (!rawOut) {
    throw new Error("drift-detect returned empty output");
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "drift-detect failed");
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`drift-detect returned invalid JSON: ${String(error)}`);
  }
  const parsedIsRecord = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!parsedIsRecord || !Object.hasOwn(parsed, "success") || parsed.success !== true) {
    const errorMessage =
      parsedIsRecord &&
      Object.hasOwn(parsed, "error") &&
      parsed.error &&
      typeof parsed.error === "object" &&
      Object.hasOwn(parsed.error, "message")
        ? parsed.error.message
        : null;
    throw new Error(errorMessage || "drift-detect failed");
  }

  return Object.hasOwn(parsed, "data") ? parsed.data : null;
}

function normalizeExpected(fixture) {
  if (!Object.hasOwn(fixture, "expected") || !Array.isArray(fixture.expected)) return [];
  return fixture.expected
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry, "claim_type") &&
        (!Object.hasOwn(entry, "verification_status") || entry.verification_status !== "verified"),
    )
    .map((entry) => entry.claim_type)
    .filter((entry) => TAXONOMY.includes(entry));
}

function normalizePredicted(driftResult) {
  if (
    !driftResult ||
    typeof driftResult !== "object" ||
    Array.isArray(driftResult) ||
    !Object.hasOwn(driftResult, "claims") ||
    !Array.isArray(driftResult.claims)
  ) {
    return [];
  }
  return driftResult.claims
    .filter(
      (claim) =>
        claim &&
        typeof claim === "object" &&
        !Array.isArray(claim) &&
        Object.hasOwn(claim, "claim_type") &&
        (!Object.hasOwn(claim, "verification_status") || claim.verification_status !== "verified"),
    )
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

function requireFixtureText(fixture, fieldName) {
  if (fieldName === "source") {
    if (
      !Object.hasOwn(fixture, "source") ||
      typeof fixture.source !== "string" ||
      fixture.source.length === 0
    ) {
      throw new Error(`fixture ${fixture.id} is missing non-empty source`);
    }
    return;
  }
  if (
    !Object.hasOwn(fixture, "target") ||
    typeof fixture.target !== "string" ||
    fixture.target.length === 0
  ) {
    throw new Error(`fixture ${fixture.id} is missing non-empty ${fieldName}`);
  }
}

function validateFixtureShape(fixture, fileName) {
  requireFixtureObject(fixture, fileName);
  for (const key of Object.keys(fixture)) {
    if (UNSAFE_FIXTURE_KEYS.has(key)) {
      throw new Error(`fixture ${fileName} has forbidden key: ${key}`);
    }
  }
  if (
    !Object.hasOwn(fixture, "id") ||
    typeof fixture.id !== "string" ||
    !FIXTURE_ID_PATTERN.test(fixture.id)
  ) {
    throw new Error(
      `fixture ${fileName} has invalid id: must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
    );
  }
  requireFixtureText(fixture, "source");
  requireFixtureText(fixture, "target");
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = resolve(args.root);
  const casesDir = resolve(repoRoot, "docs/eval/drift_goldset/cases");
  const outPath = resolveWithinRepo(args.output, repoRoot);
  const workspaceTmpRoot = resolveWithinRepo(".pipeline/tmp", repoRoot);

  const thresholds = {
    precision: args.precisionMin,
    recall: args.recallMin,
    f1: args.f1Min,
  };

  mkdirSync(workspaceTmpRoot, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });
  const tmpDir = mkdtempSync(join(workspaceTmpRoot, "drift-benchmark-"));

  const files = readdirSync(casesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  const modeResults = new Map();
  for (const mode of MODES) {
    modeResults.set(mode, {
      expected: [],
      predicted: [],
      cases: [],
    });
  }

  try {
    for (const file of files) {
      const fixturePath = resolve(casesDir, file);
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
      validateFixtureShape(fixture, file);
      const targetPath = join(tmpDir, `${fixture.id}.target.md`);
      writeFileSync(targetPath, fixture.target, "utf8");
      const targetRef = relative(repoRoot, targetPath);
      const expected = normalizeExpected(fixture);

      for (const mode of MODES) {
        const modeResult = modeResults.get(mode);
        const drift = runSkill(repoRoot, fixture, targetRef, mode);
        const predicted = normalizePredicted(drift);
        const metrics = serializeMetrics(evaluateByClass(expected, predicted));

        modeResult.expected.push(...expected);
        modeResult.predicted.push(...predicted);
        modeResult.cases.push({
          case_id: fixture.id,
          metrics,
          expected,
          predicted,
        });
      }
    }

    const metricsByMode = new Map();
    const metricsByClass = new Map(TAXONOMY.map((cls) => [cls, new Map()]));

    for (const mode of MODES) {
      const modeResult = modeResults.get(mode);
      const aggregate = evaluateByClass(modeResult.expected, modeResult.predicted);
      metricsByMode.set(mode, aggregate.overall);
      for (const cls of TAXONOMY) {
        metricsByClass.get(cls).set(mode, aggregate.byClass.get(cls));
      }
      modeResult.aggregate = serializeMetrics(aggregate);
    }

    const overall = {
      precision:
        MODES.reduce((acc, mode) => acc + metricsByMode.get(mode).precision, 0) / MODES.length,
      recall: MODES.reduce((acc, mode) => acc + metricsByMode.get(mode).recall, 0) / MODES.length,
      f1: MODES.reduce((acc, mode) => acc + metricsByMode.get(mode).f1, 0) / MODES.length,
    };

    const failedModes = MODES.filter((mode) =>
      thresholdFailed(metricsByMode.get(mode), thresholds),
    );

    const report = {
      generated_at: new Date().toISOString(),
      case_count: files.length,
      thresholds,
      metrics_by_mode: Object.fromEntries(metricsByMode),
      metrics_by_class: Object.fromEntries(
        Array.from(metricsByClass, ([cls, metrics]) => [cls, Object.fromEntries(metrics)]),
      ),
      overall,
      modes: Object.fromEntries(
        MODES.map((mode) => [
          mode,
          {
            overall: modeResults.get(mode).aggregate.overall,
            by_class: modeResults.get(mode).aggregate.by_class,
            cases: modeResults.get(mode).cases,
          },
        ]),
      ),
      status: failedModes.length === 0 ? "pass" : "fail",
      failed_modes: failedModes,
    };

    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${outPath}\n`);

    if (failedModes.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
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
