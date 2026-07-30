#!/usr/bin/env node
/** Emits a deterministic fixture for workflow event order, critical path, and barrier idle time. */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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

const OUTPUT_DIRECTORY = "eval-results";

function outputPath(pathValue, cwd = process.cwd()) {
  if (!pathValue || pathValue.startsWith("--")) throw new Error("--output requires a path");
  if (isAbsolute(pathValue)) throw new Error("--output must be relative to the current directory");
  const outputRoot = resolve(cwd, OUTPUT_DIRECTORY);
  const output = resolve(cwd, pathValue);
  if (relative(outputRoot, output).startsWith("..")) {
    throw new Error(`--output must be inside ${OUTPUT_DIRECTORY}/`);
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  if (realpathSync(outputRoot) !== outputRoot) {
    throw new Error(`${OUTPUT_DIRECTORY}/ must not be a symbolic link`);
  }
  if (dirname(output) !== outputRoot) {
    throw new Error(`--output must name a file directly inside ${OUTPUT_DIRECTORY}/`);
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error("--output must not replace a symbolic link");
  }
  return output;
}

function writeResult(pathValue) {
  writeFileSync(outputPath(pathValue), `${JSON.stringify(result, null, 2)}\n`, {
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
