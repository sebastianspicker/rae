#!/usr/bin/env node
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
  const byClass = {};
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const cls of TAXONOMY) {
    const expectedCount = expected.filter((item) => item === cls).length;
    const predictedCount = predicted.filter((item) => item === cls).length;
    const tp = Math.min(expectedCount, predictedCount);
    const fp = Math.max(0, predictedCount - expectedCount);
    const fn = Math.max(0, expectedCount - predictedCount);

    byClass[cls] = toMetrics(tp, fp, fn);
    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
  }

  return {
    overall: toMetrics(totalTp, totalFp, totalFn),
    by_class: byClass,
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
    if (!Array.isArray(fixture.extractor_claim_sets) || fixture.extractor_claim_sets.length !== 2) {
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
  if (!parsed.success) {
    throw new Error(parsed.error?.message || "drift-detect failed");
  }

  return parsed.data;
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

function validateFixtureShape(fixture, fileName) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error(`fixture ${fileName} must be an object`);
  }
  if (typeof fixture.id !== "string" || !FIXTURE_ID_PATTERN.test(fixture.id)) {
    throw new Error(
      `fixture ${fileName} has invalid id: must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
    );
  }
  if (typeof fixture.source !== "string" || fixture.source.length === 0) {
    throw new Error(`fixture ${fixture.id} is missing non-empty source`);
  }
  if (typeof fixture.target !== "string" || fixture.target.length === 0) {
    throw new Error(`fixture ${fixture.id} is missing non-empty target`);
  }
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

  const modeResults = {};
  for (const mode of MODES) {
    modeResults[mode] = {
      expected: [],
      predicted: [],
      cases: [],
    };
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
        const drift = runSkill(repoRoot, fixture, targetRef, mode);
        const predicted = normalizePredicted(drift);
        const metrics = evaluateByClass(expected, predicted);

        modeResults[mode].expected.push(...expected);
        modeResults[mode].predicted.push(...predicted);
        modeResults[mode].cases.push({
          case_id: fixture.id,
          metrics,
          expected,
          predicted,
        });
      }
    }

    const metricsByMode = {};
    const metricsByClass = {};

    for (const cls of TAXONOMY) {
      metricsByClass[cls] = {};
    }

    for (const mode of MODES) {
      const aggregate = evaluateByClass(modeResults[mode].expected, modeResults[mode].predicted);
      metricsByMode[mode] = aggregate.overall;
      for (const cls of TAXONOMY) {
        metricsByClass[cls][mode] = aggregate.by_class[cls];
      }
      modeResults[mode].aggregate = aggregate;
    }

    const overall = {
      precision: MODES.reduce((acc, mode) => acc + metricsByMode[mode].precision, 0) / MODES.length,
      recall: MODES.reduce((acc, mode) => acc + metricsByMode[mode].recall, 0) / MODES.length,
      f1: MODES.reduce((acc, mode) => acc + metricsByMode[mode].f1, 0) / MODES.length,
    };

    const failedModes = MODES.filter((mode) => thresholdFailed(metricsByMode[mode], thresholds));

    const report = {
      generated_at: new Date().toISOString(),
      case_count: files.length,
      thresholds,
      metrics_by_mode: metricsByMode,
      metrics_by_class: metricsByClass,
      overall,
      modes: Object.fromEntries(
        MODES.map((mode) => [
          mode,
          {
            overall: modeResults[mode].aggregate.overall,
            by_class: modeResults[mode].aggregate.by_class,
            cases: modeResults[mode].cases,
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
