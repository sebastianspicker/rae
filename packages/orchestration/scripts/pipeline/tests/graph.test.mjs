/** Verifies deterministic local graph projection, bounded retrieval, and repository isolation. */
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decideMemory,
  graphRepositoryIdentity,
  graphStatus,
  listMemory,
  loadGraph,
  projectGraph,
  queryGraph,
  recordRunMemory,
  retrieveMemoryContext,
  sha256,
  validateGraph,
} from "../lib/graph.mjs";
import { runGraphContextBenchmark } from "../../eval/graph-context-benchmark.mjs";

const roots = [];

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function withCanonicalDigest(manifest) {
  const { canonical_digest: ignored, ...core } = manifest;
  return { ...core, canonical_digest: sha256(canonicalJson(core)) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "rae-graph-test-"));
  roots.push(root);
  mkdirSync(resolve(root, "src"));
  mkdirSync(resolve(root, "tests"));
  writeFileSync(resolve(root, "README.md"), "# fixture\n\nSee [source](src/main.js).\n");
  writeFileSync(resolve(root, "src", "main.js"), 'import "./util.js";\n');
  writeFileSync(resolve(root, "src", "util.js"), "export const value = 1;\n");
  writeFileSync(resolve(root, "src", "helper.py"), "from src import module\n");
  writeFileSync(resolve(root, "src", "module.py"), "VALUE = 1\n");
  writeFileSync(resolve(root, "tests", "run.sh"), '. "../src/setup.sh"\n');
  writeFileSync(resolve(root, "src", "setup.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(resolve(root, "manifest.json"), '{"entry":"src/main.js"}\n');
  writeFileSync(resolve(root, "project.toml"), 'source = "src/module.py"\n');
  writeFileSync(resolve(root, "src", "unsupported.xyz"), 'include "./util.js"\n');
  writeFileSync(resolve(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(resolve(root, "oversized.txt"), Buffer.alloc(1_048_577, 65));
  writeFileSync(resolve(root, ".env"), "SECRET=excluded\n");
  symlinkSync(resolve(root, "src", "main.js"), resolve(root, "linked.js"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${head},vendor/module`);
  git(root, "commit", "-qm", "add gitlink fixture");
  return root;
}

function invalidGraphRecords(graph) {
  const [left, right] = graph.nodes.filter((node) => node.kind === "File");
  const temporal = {
    ...left,
    logical_id: "File:temporal-invalid",
    version_id: sha256("temporal-invalid"),
    valid_from: "2026-07-29T00:00:00.000Z",
    valid_to: "2026-07-28T00:00:00.000Z",
  };
  const crossRepository = {
    ...right,
    logical_id: "File:cross-repository",
    version_id: sha256("cross-repository"),
    repository_id: sha256("another-repository"),
  };
  const cycle = [
    {
      ...graph.edges[0],
      kind: "DEPENDS_ON",
      logical_id: `DEPENDS_ON:${left.logical_id}->${right.logical_id}`,
      version_id: sha256("cycle-left"),
      from: left.logical_id,
      to: right.logical_id,
    },
    {
      ...graph.edges[0],
      kind: "DEPENDS_ON",
      logical_id: `DEPENDS_ON:${right.logical_id}->${left.logical_id}`,
      version_id: sha256("cycle-right"),
      from: right.logical_id,
      to: left.logical_id,
    },
  ];
  return { crossRepository, cycle, temporal };
}

function prepareMemoryRun(root) {
  const runDir = resolve(root, ".pipeline", "runs", "run-memory");
  mkdirSync(resolve(runDir, "gates"), { recursive: true });
  const records = [
    [
      "request.json",
      { task: "Remember verified behavior", requested_at: "2026-07-29T12:00:00.000Z" },
    ],
    [
      "brief.json",
      { requirements: [{ id: "REQ-MEMORY", priority: "must", statement: "Keep evidence" }] },
    ],
    ["gates/arm-gate.json", { gate_id: "arm-gate", status: "pass" }],
    ["operator-control.json", { status: "completed" }],
  ];
  for (const [path, record] of records) {
    writeFileSync(resolve(runDir, path), `${JSON.stringify(record)}\n`);
  }
  writeFileSync(
    resolve(runDir, "trace.jsonl"),
    `${JSON.stringify({ event: "run_completed", phase: "arm", run_id: "run-memory", ts: "2026-07-29T12:01:00.000Z" })}\n`,
  );
  projectGraph({ projectRoot: root, runId: "run-memory" });
}

describe("local graph projection", () => {
  it("is canonical across repeated builds and excludes protected or non-regular paths", () => {
    const root = fixture();
    const first = projectGraph({ projectRoot: root });
    const second = projectGraph({ projectRoot: root });
    expect(second.canonical_digest).toBe(first.canonical_digest);
    const graph = loadGraph(root, first.run_id);
    expect(graph.nodes.some((node) => node.logical_id === "File:src/main.js")).toBe(true);
    expect(graph.nodes.some((node) => node.logical_id === "File:.env")).toBe(false);
    expect(graph.nodes.some((node) => node.logical_id === "File:linked.js")).toBe(false);
    expect(graph.nodes.some((node) => node.logical_id === "File:binary.dat")).toBe(false);
    expect(graph.nodes.some((node) => node.logical_id === "File:oversized.txt")).toBe(false);
    expect(graph.nodes.some((node) => node.logical_id === "File:vendor/module")).toBe(false);
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "REFERENCES",
        from: "File:src/main.js",
        to: "File:src/util.js",
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "REFERENCES",
        from: "File:manifest.json",
        to: "File:src/main.js",
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "REFERENCES",
        from: "File:project.toml",
        to: "File:src/module.py",
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "REFERENCES",
        from: "File:src/unsupported.xyz",
        to: "File:src/util.js",
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "REFERENCES",
        from: "File:src/helper.py",
        to: "File:src/module.py",
      }),
    );
  });

  it("returns bounded source-backed context and fails closed on digest corruption", () => {
    const root = fixture();
    const manifest = projectGraph({ projectRoot: root });
    const bundle = queryGraph({
      projectRoot: root,
      runId: manifest.run_id,
      seed: "File:src/main.js",
      maxRecords: 3,
    });
    expect(bundle.records[0]).toMatchObject({
      node_id: "File:src/main.js",
      trust_class: "authoritative",
      staleness: "current",
    });
    expect(bundle.records[0].snippet).toContain("import");
    expect(bundle.records).toHaveLength(3);
    const nodesPath = resolve(root, manifest.graph_dir, "nodes.jsonl");
    writeFileSync(nodesPath, `${readFileSync(nodesPath, "utf8")}{}\n`);
    expect(() => loadGraph(root, manifest.run_id)).toThrow("digest mismatch");
  });

  it("rejects traversal or absolute run ids before graph paths are resolved", () => {
    const root = fixture();
    for (const runId of ["../outside", resolve(root, "outside")]) {
      expect(() => projectGraph({ projectRoot: root, runId })).toThrow("invalid graph run id");
      expect(() => loadGraph(root, runId)).toThrow("invalid graph run id");
    }
    mkdirSync(resolve(root, ".pipeline"), { recursive: true });
    writeFileSync(
      resolve(root, ".pipeline", "pipeline-state.json"),
      `${JSON.stringify({ run_id: "../outside" })}\n`,
    );
    expect(() => projectGraph({ projectRoot: root })).toThrow("invalid graph run id");
    expect(() => loadGraph(root)).toThrow("invalid graph run id");
  });

  it("rejects manifest-only tampering before graph content is accepted", () => {
    const root = fixture();
    const manifest = projectGraph({ projectRoot: root });
    const manifestPath = resolve(root, manifest.graph_dir, "manifest.json");
    const original = JSON.parse(readFileSync(manifestPath, "utf8"));
    const cases = [
      [{ unexpected: true }, "does not satisfy its contract"],
      [{ canonical_digest: sha256("tampered") }, "canonical digest mismatch"],
      [{ node_count: original.node_count + 1 }, "record count mismatch"],
      [{ run_id: "other-run" }, "run id mismatch"],
      [{ repository_id: sha256("other-repository") }, "repository identity mismatch"],
    ];
    for (const [changes, message] of cases) {
      const tampered = changes.canonical_digest
        ? { ...original, ...changes }
        : withCanonicalDigest({ ...original, ...changes });
      writeFileSync(manifestPath, `${JSON.stringify(tampered)}\n`);
      expect(() => loadGraph(root, manifest.run_id)).toThrow(message);
    }
  });

  it("marks changed snapshots stale and rejects invalid topology and temporal records", () => {
    const root = fixture();
    const manifest = projectGraph({ projectRoot: root });
    writeFileSync(resolve(root, "README.md"), "# changed after projection\n");
    expect(graphStatus({ projectRoot: root, runId: manifest.run_id })).toMatchObject({
      available: true,
      valid: false,
    });
    expect(
      queryGraph({ projectRoot: root, runId: manifest.run_id, seed: "File:README.md" }).records,
    ).toEqual([]);
    writeFileSync(resolve(root, "README.md"), "# fixture\n\nSee [source](src/main.js).\n");
    const graph = loadGraph(root, manifest.run_id);
    const { crossRepository, cycle, temporal } = invalidGraphRecords(graph);
    const validation = validateGraph(
      [...graph.nodes, graph.nodes[0], temporal, crossRepository],
      [...graph.edges, ...cycle],
      root,
    );
    expect(validation.valid).toBe(false);
    expect(validation.issues.join("\n")).toMatch(/duplicate logical node id|duplicate version id/);
    expect(validation.issues).toContain("cross-repository records are not allowed");
    expect(validation.issues).toContain("invalid temporal interval: File:temporal-invalid");
    expect(validation.issues).toContain("dependency cycle detected");
  });

  it("includes only plan-owned dirty overlay additions and renames", () => {
    const root = fixture();
    const runDir = resolve(root, ".pipeline", "runs", "run-overlay");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, "request.json"),
      `${JSON.stringify({ task: "Project owned overlay", requested_at: "2026-07-29T12:00:00.000Z" })}\n`,
    );
    writeFileSync(
      resolve(runDir, "plan.json"),
      `${JSON.stringify({ file_ownership: { "src/new.js": "build", "src/renamed.js": "build" }, task_groups: [] })}\n`,
    );
    writeFileSync(resolve(root, "src", "new.js"), "export const added = true;\n");
    writeFileSync(resolve(root, "src", "unowned.js"), "export const excluded = true;\n");
    renameSync(resolve(root, "src", "main.js"), resolve(root, "src", "renamed.js"));
    const manifest = projectGraph({ projectRoot: root, runId: "run-overlay" });
    const graph = loadGraph(root, manifest.run_id);
    expect(graph.nodes.some((node) => node.logical_id === "File:src/new.js")).toBe(true);
    expect(graph.nodes.some((node) => node.logical_id === "File:src/renamed.js")).toBe(true);
    expect(graph.nodes.some((node) => node.logical_id === "File:src/main.js")).toBe(false);
    expect(graph.nodes.some((node) => node.logical_id === "File:src/unowned.js")).toBe(false);
  });

  it("keeps memory namespaces isolated by Git common-directory identity", () => {
    const first = fixture();
    const second = fixture();
    expect(graphRepositoryIdentity(first).repositoryId).not.toBe(
      graphRepositoryIdentity(second).repositoryId,
    );
    expect(listMemory({ projectRoot: first }).status.facts).toBe(0);
    expect(listMemory({ projectRoot: second }).status.facts).toBe(0);
    expect(graphStatus({ projectRoot: first }).available).toBe(false);
  });

  it("quarantines model proposals and preserves attributable promotion decisions", () => {
    const root = fixture();
    prepareMemoryRun(root);
    const memoryRoot = resolve(root, ".git", "rae-memory", "v1");
    mkdirSync(memoryRoot, { recursive: true });
    writeFileSync(resolve(memoryRoot, "memory.lock"), `${process.pid}\n`);
    expect(() => recordRunMemory({ projectRoot: root, runId: "run-memory" })).toThrow(
      "graph memory is locked",
    );
    writeFileSync(resolve(memoryRoot, "memory.lock"), "999999\n");
    const status = recordRunMemory({ projectRoot: root, runId: "run-memory" });
    expect(status.facts).toBeGreaterThan(0);
    expect(status.pending_candidates).toBeGreaterThan(0);
    const before = listMemory({ projectRoot: root });
    const candidate = before.candidates.find(
      (item) => item.logical_id === "Requirement:REQ-MEMORY",
    );
    const decision = decideMemory({
      projectRoot: root,
      candidateId: candidate.version_id,
      decision: "promoted",
      actor: "fixture-maintainer",
      rationale: "README corroborates the fixture behavior.",
      sourceRef: "README.md",
    });
    expect(decision).toMatchObject({
      candidate_id: candidate.version_id,
      decision: "promoted",
      actor: "fixture-maintainer",
    });
    const admitted = retrieveMemoryContext({ projectRoot: root, seed: "REQ-MEMORY" });
    expect(admitted).toContainEqual(
      expect.objectContaining({
        logical_id: "Requirement:REQ-MEMORY",
        trust_class: "verified-derived",
      }),
    );
  });

  it("evaluates all four retrieval modes on the frozen 50-task contract", {
    timeout: 15_000,
  }, () => {
    const root = fixture();
    const datasetPath = resolve(
      import.meta.dirname,
      "../../../../../evals/datasets/graph-context/graph-context-held-out.json",
    );
    const result = runGraphContextBenchmark({ projectRoot: root, datasetPath });
    expect(result.task_count).toBe(50);
    expect(result.modes.map((mode) => mode.mode)).toEqual([
      "current-context",
      "lexical",
      "lexical-plus-graph",
      "graph-plus-promoted-memory",
    ]);
    expect(result.cross_project_leakage).toBe(false);
    expect(result.protected_path_leakage).toBe(false);
    expect(result.experimental_exit_criteria_passed).toBe(false);
  });
});
