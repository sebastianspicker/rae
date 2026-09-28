/** Characterizes graph cache validation counts and iterative deep/wide topology checks. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, test } from "node:test";
import { projectGraph } from "../src/graph/projection.js";
import { canonicalJson, jsonl, sha256 } from "../src/graph/core.js";
import { graphCacheDiagnostics, loadGraph, queryGraph } from "../src/graph/query.js";
import { hasDependencyCycle } from "../src/graph/validation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(fileCount = 32) {
  const root = mkdtempSync(resolve(tmpdir(), "rae-graph-cache-"));
  roots.push(root);
  mkdirSync(resolve(root, "src"));
  writeFileSync(resolve(root, "README.md"), "# graph fixture\n");
  for (let index = 0; index < fileCount; index++) {
    const next = index + 1 < fileCount ? `import "./f${index + 1}.js";\n` : "";
    writeFileSync(resolve(root, "src", `f${index}.js`), `${next}export const n = ${index};\n`);
  }
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "RAE Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "rae@example.invalid"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

test("graph cache reuses parsed records and adjacency only after current artifact digest checks", () => {
  const root = repository();
  const projection = projectGraph({ projectRoot: root });
  const runId = typeof projection.run_id === "string" ? projection.run_id : null;
  const graphDir = String(projection.graph_dir);
  graphCacheDiagnostics({ reset: true });
  const first = loadGraph(root, runId);
  const second = loadGraph(root, runId);
  assert.strictEqual(second.nodes, first.nodes);
  assert.strictEqual(second.edges, first.edges);
  queryGraph({ projectRoot: root, runId, seed: "File:src/f0.js" });
  queryGraph({ projectRoot: root, runId, seed: "File:src/f0.js" });
  const metrics = graphCacheDiagnostics();
  assert.equal(metrics.lexical_builds, 1);
  assert.ok(metrics.lexical_reuses > 0);
  assert.ok(metrics.cache_bytes <= metrics.max_total_bytes);
  assert.deepEqual(
    {
      content_digest_checks: metrics.content_digest_checks,
      parsed_loads: metrics.parsed_loads,
      parsed_reuses: metrics.parsed_reuses,
      adjacency_builds: metrics.adjacency_builds,
      adjacency_reuses: metrics.adjacency_reuses,
    },
    {
      content_digest_checks: 8,
      parsed_loads: 1,
      parsed_reuses: 3,
      adjacency_builds: 1,
      adjacency_reuses: 1,
    },
  );

  const nodesPath = resolve(root, graphDir, "nodes.jsonl");
  writeFileSync(nodesPath, `${readFileSync(nodesPath, "utf8")}\n`);
  assert.throws(() => loadGraph(root, runId), /digest mismatch/);
});

test("every query rechecks repository freshness and source snippets remain bounded prefixes", () => {
  const root = repository(4);
  const longPrefix = "🧭".repeat(2100);
  writeFileSync(resolve(root, "src", "f0.js"), `${longPrefix}\nTAIL-MARKER\n`);
  execFileSync("git", ["-C", root, "add", "src/f0.js"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "unicode prefix"]);
  const projection = projectGraph({ projectRoot: root });
  const runId = typeof projection.run_id === "string" ? projection.run_id : null;
  const current = queryGraph({
    projectRoot: root,
    runId,
    seed: "File:src/f0.js",
    maxRecords: 1,
  });
  const snippet = String(current.records[0]?.snippet ?? "");
  assert.equal([...snippet].length, 2000);
  assert.equal(snippet.includes("TAIL-MARKER"), false);

  writeFileSync(resolve(root, "src", "f0.js"), "changed after projection\n");
  const stale = queryGraph({
    projectRoot: root,
    runId,
    seed: "File:src/f0.js",
  });
  assert.deepEqual(stale.records, []);
});

test("oversized parsed projections bypass byte-bounded retention", () => {
  const root = repository(2);
  const projection = projectGraph({ projectRoot: root });
  const runId = typeof projection.run_id === "string" ? projection.run_id : null;
  const graphDir = resolve(root, String(projection.graph_dir));
  const nodesPath = resolve(graphDir, "nodes.jsonl");
  const manifestPath = resolve(graphDir, "manifest.json");
  const nodes = readFileSync(nodesPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const limits = graphCacheDiagnostics({ reset: true });
  nodes[0].attributes.cache_padding = "p".repeat(limits.max_entry_bytes);
  const nodesBody = jsonl(nodes);
  writeFileSync(nodesPath, nodesBody);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.nodes_digest = sha256(nodesBody);
  const { canonical_digest: _ignored, ...manifestCore } = manifest;
  manifest.canonical_digest = sha256(canonicalJson(manifestCore));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const first = loadGraph(root, runId);
  const second = loadGraph(root, runId);
  const elapsedMs = performance.now() - started;
  const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const metrics = graphCacheDiagnostics();
  assert.notStrictEqual(first.nodes, second.nodes);
  assert.equal(metrics.cache_bypasses, 2);
  assert.equal(metrics.parsed_loads, 2);
  assert.equal(metrics.parsed_reuses, 0);
  assert.equal(metrics.cache_entries, 0);
  assert.ok(metrics.content_read_bytes >= limits.max_entry_bytes * 2);
  assert.ok(metrics.parse_duration_ms >= 0);
  assert.ok(Number.isFinite(elapsedMs));
  assert.ok(Number.isSafeInteger(heapDeltaBytes));
});

test("deep and wide dependency-cycle checks are iterative and preserve cycle results", () => {
  const depth = 50_000;
  type DependencyEdge = Parameters<typeof hasDependencyCycle>[0][number];
  const deep: DependencyEdge[] = Array.from({ length: depth }, (_, index) => ({
    kind: "DEPENDS_ON",
    from: `n${index}`,
    to: `n${index + 1}`,
  }));
  assert.equal(hasDependencyCycle(deep), false);
  assert.equal(
    hasDependencyCycle([...deep, { kind: "DEPENDS_ON", from: `n${depth}`, to: "n0" }]),
    true,
  );
  const wide: DependencyEdge[] = Array.from({ length: depth }, (_, index) => ({
    kind: "DEPENDS_ON",
    from: "root",
    to: `leaf${index}`,
  }));
  assert.equal(hasDependencyCycle(wide), false);
});
