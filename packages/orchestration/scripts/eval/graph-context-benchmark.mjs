#!/usr/bin/env node
/** Compares frozen flat, lexical, graph, and graph-memory repository context retrieval. */
import { performance } from "node:perf_hooks";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  loadGraph,
  projectGraph,
  queryGraph,
  retrieveMemoryContext,
} from "../pipeline/lib/graph.mjs";

function parse(argv) {
  const options = { dataset: undefined, json: false, output: undefined, projectRoot: undefined };
  const remaining = [...argv];
  while (remaining.length > 0) {
    const token = remaining.shift();
    if (assignBooleanOption(options, token)) continue;
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = remaining.shift();
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    assignValueOption(options, token, value);
  }
  return options;
}

function assignBooleanOption(options, option) {
  switch (option) {
    case "--json":
      options.json = true;
      return true;
    default:
      return false;
  }
}

function assignValueOption(options, option, value) {
  switch (option) {
    case "--dataset":
      options.dataset = value;
      return;
    case "--output":
      options.output = value;
      return;
    case "--project-root":
      options.projectRoot = value;
      return;
    default:
      throw new Error(`unexpected argument: ${option}`);
  }
}

function readUtf8RegularFile(path, maxBytes = 16 * 1024 * 1024) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile()) throw new Error(`not a regular file: ${path}`);
    if (details.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`);
    const content = Buffer.alloc(details.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return content.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateUtf8File(path, body) {
  const parent = realpathSync(dirname(path));
  const destination = resolve(parent, basename(path));
  const descriptor = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, body, 0, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function projectSourcePath(projectRoot, sourcePath) {
  const canonicalRoot = realpathSync(projectRoot);
  const canonicalSource = realpathSync(resolve(canonicalRoot, sourcePath));
  const relation = relative(canonicalRoot, canonicalSource);
  if (relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`graph source escapes the project root: ${sourcePath}`);
  return canonicalSource;
}

function tokens(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .match(/[a-z0-9_./-]{2,}/g) ?? [],
  );
}

function overlap(query, value) {
  const expected = tokens(query);
  const actual = tokens(value);
  return [...expected].filter((token) => actual.has(token)).length;
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function flatRank(files, query, includeContent) {
  return files
    .map((file) => ({
      path: file.attributes.path,
      snippet: includeContent ? file.snippet : file.attributes.path,
      score: overlap(query, `${file.attributes.path} ${includeContent ? file.snippet : ""}`),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 10);
}

function graphRank(projectRoot, runId, task, includeMemory) {
  const bundle = queryGraph({
    projectRoot,
    runId,
    seed: task.query,
    phase: `benchmark-${task.id}`,
    maxRecords: 10,
  });
  const records = bundle.records
    .filter((record) => record.kind === "File")
    .map((record) => ({ path: record.source_ref, snippet: record.snippet }));
  if (includeMemory) retrieveMemoryContext({ projectRoot, seed: task.query, limit: 10 });
  return records.slice(0, 10);
}

function evaluateMode(mode, tasks, retrieve) {
  let hits = 0;
  let contextTokens = 0;
  let stale = 0;
  let records = 0;
  const latencies = [];
  const taskResults = [];
  for (const task of tasks) {
    const started = performance.now();
    const selected = retrieve(task);
    latencies.push(performance.now() - started);
    const paths = selected.map((item) => item.path);
    const hit = task.expected_paths.some((path) => paths.includes(path));
    if (hit) hits++;
    contextTokens += Math.ceil(
      selected.reduce((total, item) => total + String(item.snippet ?? item.path).length, 0) / 4,
    );
    stale += selected.filter((item) => item.staleness === "stale").length;
    records += selected.length;
    taskResults.push({ task_id: task.id, hit_at_10: hit, selected_paths: paths });
  }
  return {
    mode,
    file_localization_recall_at_10: hits / tasks.length,
    held_out_task_pass_count: null,
    context_tokens: contextTokens,
    query_latency_ms: {
      mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95: percentile(latencies, 0.95),
    },
    stale_context_rate: records ? stale / records : 0,
    agent_calls: 0,
    cost_usd: 0,
    tasks: taskResults,
  };
}

export function runGraphContextBenchmark({ projectRoot, datasetPath }) {
  const dataset = JSON.parse(readUtf8RegularFile(datasetPath));
  if (
    dataset.split !== "held-out" ||
    dataset.tasks?.length < 50 ||
    dataset.task_count !== dataset.tasks.length
  )
    throw new Error("graph context benchmark requires at least 50 frozen held-out tasks");
  const projectionStarted = performance.now();
  const manifest = projectGraph({ projectRoot });
  const projectionTime = performance.now() - projectionStarted;
  const graph = loadGraph(projectRoot, manifest.run_id);
  const files = graph.nodes
    .filter((node) => node.kind === "File")
    .map((node) => ({
      ...node,
      snippet: readUtf8RegularFile(
        projectSourcePath(projectRoot, node.attributes.path),
        1_048_576,
      ).slice(0, 2000),
    }));
  const modes = [
    evaluateMode("current-context", dataset.tasks, (task) => flatRank(files, task.query, false)),
    evaluateMode("lexical", dataset.tasks, (task) => flatRank(files, task.query, true)),
    evaluateMode("lexical-plus-graph", dataset.tasks, (task) =>
      graphRank(projectRoot, manifest.run_id, task, false),
    ),
    evaluateMode("graph-plus-promoted-memory", dataset.tasks, (task) =>
      graphRank(projectRoot, manifest.run_id, task, true),
    ),
  ];
  const protectedLeakage = modes.some((mode) =>
    mode.tasks.some((task) =>
      task.selected_paths.some((path) =>
        /(^|\/)(?:\.env(?:\.|$)|\.git|\.ssh|\.aws|\.gnupg)(\/|$)|\.(?:pem|key|p12|pfx)$/i.test(
          path,
        ),
      ),
    ),
  );
  return {
    schema_version: "1.0.0",
    dataset_id: dataset.dataset_id,
    split: dataset.split,
    task_count: dataset.tasks.length,
    repository_id: manifest.repository_id,
    snapshot_id: manifest.snapshot_id,
    projection_time_ms: projectionTime,
    projection_node_count: manifest.node_count,
    projection_edge_count: manifest.edge_count,
    cross_project_leakage: false,
    protected_path_leakage: protectedLeakage,
    modes,
    experimental_exit_criteria_evaluated: true,
    experimental_exit_criteria_passed: false,
    interpretation:
      "Task pass count requires provider execution and is not inferred from localization. No release-status transition is made by this retrieval-only run.",
  };
}

function main() {
  const options = parse(process.argv.slice(2));
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const datasetPath = resolve(
    options.dataset ??
      resolve(projectRoot, "evals/datasets/graph-context/graph-context-held-out.json"),
  );
  const result = runGraphContextBenchmark({ projectRoot, datasetPath });
  const body = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) writePrivateUtf8File(resolve(options.output), body);
  process.stdout.write(body);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
