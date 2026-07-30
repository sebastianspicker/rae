#!/usr/bin/env node
/** Emits a deterministic fixture for workflow event order, critical path, and barrier idle time. */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const items = [
  { key: "a", first: 8, second: 2 },
  { key: "b", first: 3, second: 6 },
  { key: "c", first: 5, second: 1 },
];
const entryDuration = 4;
const firstCompletion = items.map((item) => ({ ...item, completed: entryDuration + item.first }));
const barrierOpen = Math.max(...firstCompletion.map(({ completed }) => completed));
const barrierCompletion = barrierOpen + Math.max(...items.map(({ second }) => second));
const streamCompletion = Math.max(
  ...firstCompletion.map(({ completed, second }) => completed + second),
);
const barrierIdle = firstCompletion.reduce(
  (total, { completed }) => total + barrierOpen - completed,
  0,
);
const eventOrder = [
  { event: "entry_completed", at_ms: entryDuration },
  ...firstCompletion
    .map(({ key, completed }) => ({
      event: "first_stage_completed",
      item_key: key,
      at_ms: completed,
    }))
    .sort((left, right) => left.at_ms - right.at_ms || left.item_key.localeCompare(right.item_key)),
  ...firstCompletion
    .map(({ key, completed, second }) => ({
      event: "stream_stage_completed",
      item_key: key,
      at_ms: completed + second,
    }))
    .sort((left, right) => left.at_ms - right.at_ms || left.item_key.localeCompare(right.item_key)),
];

const result = {
  schema_version: "1.0.0",
  fixture_id: "workflow-topology-order-v1",
  measurements: {
    event_order: eventOrder,
    streaming_critical_path_ms: streamCompletion,
    barrier_critical_path_ms: barrierCompletion,
    barrier_idle_time_ms: barrierIdle,
  },
  interpretation: {
    scope: "deterministic scheduler fixture",
    model_quality_claim: false,
    universal_speed_claim: false,
  },
};

const OUTPUT_PATH = "eval-results/workflow-topology.json";

function outputPath(pathValue, cwd = process.cwd()) {
  if (!pathValue || pathValue.startsWith("--")) throw new Error("--output requires a path");
  if (pathValue !== OUTPUT_PATH) {
    throw new Error(`--output must be ${OUTPUT_PATH}`);
  }
  mkdirSync("eval-results", { recursive: true, mode: 0o700 });
  if (realpathSync("eval-results") !== resolve(cwd, "eval-results")) {
    throw new Error("eval-results/ must not be a symbolic link");
  }
  if (
    existsSync("eval-results/workflow-topology.json") &&
    lstatSync("eval-results/workflow-topology.json").isSymbolicLink()
  ) {
    throw new Error("--output must not replace a symbolic link");
  }
  return OUTPUT_PATH;
}

function writeResult(pathValue) {
  outputPath(pathValue);
  writeFileSync("eval-results/workflow-topology.json", `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  writeResult(process.argv[outputIndex + 1]);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
