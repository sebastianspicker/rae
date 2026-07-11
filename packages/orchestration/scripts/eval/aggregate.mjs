#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseCliArgs } from "../lib/argv.mjs";
import { CONFIG_IDS } from "../lib/constants.mjs";
import {
  getRunDir,
  readJson,
  resolveWithinRepo,
  toWorkspaceRelative,
} from "../pipeline/lib/state.mjs";

const UNSAFE_AGGREGATION_KEYS = new Set(["__proto__", "prototype", "constructor", "toString"]);

function assertSafeAggregationKey(key, label) {
  if (typeof key !== "string" || UNSAFE_AGGREGATION_KEYS.has(key)) {
    throw new Error(`${label} contains an unsafe key`);
  }
  return key;
}

function parseArgs(argv) {
  const args = parseCliArgs(
    {
      defaults: { matrix: null, output: null, root: process.cwd() },
      options: {
        matrix: { type: "string" },
        output: { type: "string" },
        root: { type: "string" },
      },
    },
    argv.slice(2),
  );
  if (!args.matrix || !args.output) {
    throw new Error(
      "Usage: aggregate.mjs --matrix <matrix.json> --output <evaluation-report.json> [--root <repo>] ",
    );
  }
  return args;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx];
}

function driftScoreFromClaims(claims) {
  if (!Array.isArray(claims) || claims.length === 0) return 0;
  const scoreByStatus = new Map([
    ["verified", 0],
    ["partial", 0.5],
    ["violated", 1],
    ["unverifiable", 0.75],
  ]);
  const values = claims.map((c) => scoreByStatus.get(c.verification_status) ?? 0.75);
  return mean(values);
}

export function gatePassRate(gates) {
  const byPhase = new Map();
  for (const gate of gates) {
    const phase = assertSafeAggregationKey(gate.phase, "gate phase");
    const stats = byPhase.get(phase) ?? { pass: 0, total: 0 };
    stats.total += 1;
    if (gate.status === "pass") stats.pass += 1;
    byPhase.set(phase, stats);
  }
  return Object.fromEntries(
    [...byPhase].map(([phase, stats]) => [phase, stats.total === 0 ? 0 : stats.pass / stats.total]),
  );
}

function loadRunMetrics(root, runId) {
  const runDir = getRunDir(runId, root);
  if (!existsSync(runDir)) {
    throw new Error(`run directory not found for run_id=${runId}`);
  }
  const gatesDir = resolve(runDir, "gates");
  const traceSummary = readJson(resolve(runDir, "trace.summary.json"), {});
  const drift = readJson(resolve(runDir, "drift-reports", "pmatch.json"), {});
  const review = readJson(resolve(runDir, "review.json"), {});
  const security = readJson(resolve(runDir, "quality-reports", "security.json"), {});

  const gateFiles = [
    "arm-gate.json",
    "design-gate.json",
    "adversarial-review-gate.json",
    "plan-gate.json",
    "pmatch-gate.json",
    "build-gate.json",
    "quality-static-gate.json",
    "quality-tests-gate.json",
    "postbuild-gate.json",
    "release-readiness-gate.json",
  ];
  const gateResults = gateFiles
    .map((name) => readJson(resolve(gatesDir, name), null))
    .filter(Boolean)
    .map((g) => ({ phase: g.phase, status: g.status }));

  const success = gateResults.length > 0 && gateResults.every((g) => g.status === "pass");
  const rawFindings = Array.isArray(review.reviewers)
    ? review.reviewers.reduce(
        (acc, r) => acc + (Array.isArray(r.findings) ? r.findings.length : 0),
        0,
      )
    : 0;
  const dedupFindings = Array.isArray(review.deduplicated_findings)
    ? review.deduplicated_findings.length
    : 0;
  const dedupRatio = dedupFindings > 0 ? rawFindings / dedupFindings : 1;

  return {
    run_id: runId,
    success,
    cost_usd: Number(traceSummary.total_cost_usd ?? 0),
    latency_s: Number(traceSummary.total_duration_s ?? 0),
    drift_score: driftScoreFromClaims(drift.claims ?? []),
    dedup_ratio: dedupRatio,
    security_time_to_closure_s: Number(
      traceSummary.security_time_to_closure_s ?? security?.security_audit?.fix_loop?.rounds ?? 0,
    ),
    gate_results: gateResults,
  };
}

export function aggregateMetrics(configs) {
  const pipelineSuccess = new Map();
  const gatePassRates = new Map();
  const meanDrift = new Map();
  const driftP95 = new Map();
  const meanCost = new Map();
  const meanLatency = new Map();
  const dedupRatio = new Map();
  const securityTtc = new Map();

  for (const config of configs) {
    const id = assertSafeAggregationKey(config.id, "configuration id");
    const runs = config.runs;
    const successValues = runs.map((r) => (r.success ? 1 : 0));
    const driftValues = runs.map((r) => Number(r.drift_score ?? 0));
    const costValues = runs.map((r) => Number(r.cost_usd ?? 0));
    const latencyValues = runs.map((r) => Number(r.latency_s ?? 0));
    const dedupValues = runs.map((r) => Number(r.dedup_ratio ?? 1));
    const ttcValues = runs.map((r) => Number(r.security_time_to_closure_s ?? 0));
    const gates = runs.flatMap((r) => r.gate_results ?? []);

    pipelineSuccess.set(id, mean(successValues));
    gatePassRates.set(id, gatePassRate(gates));
    meanDrift.set(id, mean(driftValues));
    driftP95.set(id, p95(driftValues));
    meanCost.set(id, mean(costValues));
    meanLatency.set(id, mean(latencyValues));
    dedupRatio.set(id, mean(dedupValues));
    securityTtc.set(id, {
      mean: mean(ttcValues),
      p95: p95(ttcValues),
    });
  }

  return {
    pipeline_success_rate: Object.fromEntries(pipelineSuccess),
    gate_pass_rate_by_phase: Object.fromEntries(gatePassRates),
    mean_drift_score: Object.fromEntries(meanDrift),
    drift_p95: Object.fromEntries(driftP95),
    mean_cost_usd_per_run: Object.fromEntries(meanCost),
    mean_latency_s_per_run: Object.fromEntries(meanLatency),
    dedup_ratio: Object.fromEntries(dedupRatio),
    security_time_to_closure: Object.fromEntries(securityTtc),
  };
}

function normalizeConfigurations(raw) {
  const byId = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    if (!CONFIG_IDS.includes(entry.id)) continue;
    const runIds = Array.isArray(entry.run_ids)
      ? entry.run_ids.filter((id) => typeof id === "string")
      : [];
    byId.set(entry.id, runIds);
  }
  return CONFIG_IDS.map((id) => ({ id, run_ids: byId.get(id) ?? [] }));
}

function main() {
  const { matrix, output, root } = parseArgs(process.argv);
  const matrixPath = resolveWithinRepo(matrix, root);
  const matrixData = readJson(matrixPath);
  if (!matrixData) {
    throw new Error(`Matrix file not found: ${toWorkspaceRelative(matrixPath, root)}`);
  }

  const configurations = normalizeConfigurations(matrixData.configurations ?? []).map((config) => {
    const runs = config.run_ids.map((runId) => loadRunMetrics(root, runId));
    return {
      id: config.id,
      run_count: runs.length,
      runs,
    };
  });

  const report = {
    evaluation_id: matrixData.evaluation_id,
    created_at: new Date().toISOString(),
    taskset_id: matrixData.taskset_id,
    configurations,
    metrics: aggregateMetrics(configurations),
  };

  const outPath = resolveWithinRepo(output, root);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${outPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const code = error?.code || "E_EVAL_AGGREGATE";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${code}: ${message}\n`);
    process.exit(1);
  }
}
