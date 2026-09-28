#!/usr/bin/env node
/** Benchmark identical run-list pages against a selected reference or compiled operator module. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { instrumentReads, measure, latencyDistribution, type Sample } from "./measure.js";
interface Project {
  id: string;
  root: string;
}
interface OperatorModule {
  discoverRuns(project: Project): unknown[];
  publicRun(run: unknown): unknown;
  RunCatalog: new (options?: {
    measureReads: boolean;
  }) => {
    page(project: Project, options: { limit: number }): Promise<{ runs: unknown[] }>;
    close?: () => void | Promise<void>;
    takeReadMetrics?: () => { bytesRead: number; readCalls: number; parseCalls: number };
  };
}
function parseOptions() {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !value || !["--module", "--mode", "--iterations", "--sizes"].includes(key))
      throw new Error(
        "Usage: operator benchmark --module <path> --mode <reference|compiled> [--iterations 7] [--sizes 100,1000,10000]",
      );
    options.set(key, value);
  }
  const mode = options.get("--mode");
  const module = options.get("--module");
  const iterations = Number(options.get("--iterations") ?? 7);
  const sizes = (options.get("--sizes") ?? "100,1000,10000").split(",").map(Number);
  if (
    !module ||
    !["reference", "compiled"].includes(mode ?? "") ||
    !Number.isSafeInteger(iterations) ||
    iterations < 3 ||
    iterations > 100 ||
    sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 10_000)
  )
    throw new Error("Invalid benchmark parameters");
  return { module, mode, iterations, sizes };
}
function prepare(root: string, size: number) {
  execFileSync("git", ["init", "-q", root]);
  const runs = join(root, ".pipeline/runs");
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(
    join(root, ".pipeline/pipeline-state.json"),
    JSON.stringify({
      run_id: "run-0",
      current_phase: "arm",
      workspace: { primary_repo_root: root },
    }),
  );
  for (let i = 0; i < size; i++) {
    const directory = join(runs, `run-${i}`);
    fs.mkdirSync(directory);
    const at = new Date(1800000000000 + i).toISOString();
    fs.writeFileSync(
      join(directory, "request.json"),
      JSON.stringify({ task: `Fixture ${i}`, requested_at: at }),
    );
    fs.writeFileSync(
      join(directory, "trace.jsonl"),
      `${JSON.stringify({ run_id: `run-${i}`, event: "agent_call", phase: "arm", ts: at })}\n`,
    );
  }
}
function resultIdentity(runs: unknown[], root: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        runs.map((value) => {
          if (
            !value ||
            typeof value !== "object" ||
            !("id" in value) ||
            typeof value.id !== "string"
          )
            throw new Error("Invalid benchmark run projection");
          return value;
        }),
        (_key, value: unknown) =>
          typeof value === "string"
            ? value.replaceAll(root, "<project-root>").replaceAll(basename(root), "<workspace>")
            : value,
      ),
    )
    .digest("hex");
}
const options = parseOptions();
const instrumentation = instrumentReads();
try {
  const namespace: unknown = await import(pathToFileURL(resolve(options.module)).href);
  if (!namespace || typeof namespace !== "object")
    throw new Error("Invalid operator benchmark module");
  const module = namespace as OperatorModule;
  if (
    options.mode === "reference" &&
    (typeof module.discoverRuns !== "function" || typeof module.publicRun !== "function")
  )
    throw new Error("Reference module lacks run discovery");
  if (options.mode === "compiled" && typeof module.RunCatalog !== "function")
    throw new Error("Compiled module lacks RunCatalog");
  for (const size of options.sizes) {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rae-catalog-bench-")));
    const catalog =
      options.mode === "compiled" ? new module.RunCatalog({ measureReads: true }) : undefined;
    try {
      prepare(root, size);
      const project = { id: "fixture-project", root };
      const samples: Sample[] = [];
      let identity: string | undefined;
      for (let iteration = 0; iteration < options.iterations; iteration++) {
        const { result, sample } = await measure(
          async () =>
            catalog
              ? (await catalog.page(project, { limit: 100 })).runs
              : module
                  .discoverRuns(project)
                  .slice(0, 100)
                  .map((run) => module.publicRun(run)),
          instrumentation,
        );
        assert.equal(result.length, Math.min(size, 100));
        const digest = resultIdentity(result, root);
        if (identity) assert.equal(digest, identity);
        else identity = digest;
        const workerReads = catalog?.takeReadMetrics?.();
        if (workerReads)
          for (const key of ["bytesRead", "readCalls", "parseCalls"] as const)
            sample[key] += workerReads[key];
        samples.push(sample);
      }
      console.log(
        JSON.stringify({
          workload: "run-list-first-100",
          mode: options.mode,
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          size,
          iterations: options.iterations,
          resultSha256: identity,
          latency: latencyDistribution(samples),
          samples,
        }),
      );
    } finally {
      await catalog?.close?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  instrumentation.restore();
}
