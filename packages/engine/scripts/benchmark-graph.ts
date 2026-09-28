#!/usr/bin/env node
/** Compare validated graph query results, cache work and resource use on disposable deep and wide graphs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { projectGraph } from "../src/graph/graph/projection.js";
import * as current from "../src/graph/graph/query.js";
interface QueryModule {
  queryGraph: typeof current.queryGraph;
  graphCacheDiagnostics(options?: { reset?: boolean }): Record<string, number>;
}
interface Sample {
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  processMaxRssBytes: number;
  timerLatenessMaxMs: number;
  eventLoopUtilization: number;
  graphMetrics: Record<string, number>;
}
function prepare(shape: "deep" | "wide", size: number): string {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rae-graph-benchmark-")));
  fs.mkdirSync(join(root, "src"));
  fs.writeFileSync(join(root, "README.md"), "# Disposable graph benchmark\n");
  for (let i = 0; i < size; i++) {
    const imports = shape === "deep" && i + 1 < size ? `import './f${i + 1}.js';\n` : "";
    fs.writeFileSync(join(root, `src/f${i}.js`), `${imports}export const module${i} = ${i};\n`);
  }
  if (shape === "wide")
    fs.writeFileSync(
      join(root, "src/root.js"),
      Array.from({ length: size }, (_v, i) => `import './f${i}.js';`).join("\n"),
    );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=RAE Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z",
      },
    },
  );
  return root;
}
async function sample(
  module: QueryModule,
  root: string,
  runId: string,
): Promise<{ digest: string; sample: Sample }> {
  module.graphCacheDiagnostics({ reset: true });
  const rssBeforeBytes = process.memoryUsage().rss;
  const utilization = performance.eventLoopUtilization();
  const start = performance.now();
  let timerLatenessMaxMs = 0,
    expected = start + 5;
  const timer = setInterval(() => {
    const now = performance.now();
    timerLatenessMaxMs = Math.max(timerLatenessMaxMs, now - expected);
    expected = now + 5;
  }, 5);
  try {
    const hash = createHash("sha256");
    for (let iteration = 0; iteration < 3; iteration++) {
      for (const seed of ["File:src/f0.js", "module", "src"]) {
        hash.update(
          JSON.stringify(
            module.queryGraph({ projectRoot: root, runId, seed, maxDepth: 4, maxRecords: 20 }),
          ),
        );
      }
    }
    const elapsedMs = performance.now() - start;
    const eventLoopUtilization = performance.eventLoopUtilization(utilization).utilization;
    const graphMetrics = module.graphCacheDiagnostics();
    await sleep(5);
    return {
      digest: hash.digest("hex"),
      sample: {
        elapsedMs,
        rssBeforeBytes,
        rssAfterBytes: process.memoryUsage().rss,
        processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
        timerLatenessMaxMs,
        eventLoopUtilization,
        graphMetrics,
      },
    };
  } finally {
    clearInterval(timer);
  }
}
function distribution(samples: Sample[]) {
  const values = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  return {
    minimumMs: values[0],
    p50Ms: values[Math.floor(values.length / 2)],
    p95Ms: values.at(-1),
    maximumMs: values.at(-1),
  };
}
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--reference"))
  throw new Error("Usage: graph benchmark [--reference <query-module-path>]");
const reference = args[1]
  ? ((await import(pathToFileURL(resolve(args[1])).href)) as QueryModule)
  : undefined;
for (const shape of ["deep", "wide"] as const) {
  const root = prepare(shape, 512);
  try {
    const projection = projectGraph({ projectRoot: root });
    const runId = String(projection.run_id);
    const compiled: Sample[] = [],
      baseline: Sample[] = [];
    let resultSha256 = "";
    for (let iteration = 0; iteration < 7; iteration++) {
      const prior = reference ? await sample(reference, root, runId) : undefined;
      const result = await sample(current, root, runId);
      if (prior) {
        assert.equal(result.digest, prior.digest);
        baseline.push(prior.sample);
      }
      if (resultSha256) assert.equal(result.digest, resultSha256);
      resultSha256 = result.digest;
      compiled.push(result.sample);
    }
    console.log(
      JSON.stringify({
        workload: "validated-graph-queries",
        node: process.version,
        platform: process.platform,
        shape,
        files: shape === "wide" ? 513 : 512,
        queriesPerSample: 9,
        iterations: 7,
        resultSha256,
        compiled: { latency: distribution(compiled), samples: compiled },
        ...(reference ? { reference: { latency: distribution(baseline), samples: baseline } } : {}),
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
