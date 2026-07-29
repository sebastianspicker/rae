/** Builds, validates, queries, and persists RAE's local rebuildable graph projections. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const GRAPH_PROJECTOR = "rae-local-graph-v1";
export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 250_000,
  maxEdges: 1_000_000,
  maxFileBytes: 1_048_576,
});
const TRUST = new Set(["authoritative", "verified-derived", "model-proposed", "untrusted"]);
const EDGE_KINDS = new Set([
  "CONTAINS",
  "DEPENDS_ON",
  "REFERENCES",
  "READS",
  "WRITES",
  "DERIVED_FROM",
  "COVERS",
  "VERIFIES",
  "EVALUATES",
  "AUTHORIZED_BY",
  "SUPPORTS_CLAIM",
  "SUPERSEDES",
  "INVALIDATES",
]);
const PHASES = [
  "arm",
  "design",
  "adversarial-review",
  "plan",
  "pmatch",
  "build",
  "quality-static",
  "quality-tests",
  "post-build",
  "release-readiness",
];
const PHASE_ARTIFACTS = {
  arm: "brief.json",
  design: "design.json",
  "adversarial-review": "review.json",
  plan: "plan.json",
  pmatch: "drift-reports/pmatch.json",
  build: "build.json",
  "quality-static": "quality-reports/static.json",
  "quality-tests": "quality-reports/tests.json",
  "post-build": "quality-reports/post-build.json",
  "release-readiness": "release-readiness.json",
};
const GRAPH_CONTRACT_ROOT = resolve(import.meta.dirname, "../../../contracts/graph");
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
let contractValidators;

function graphContractValidators() {
  if (contractValidators) return contractValidators;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const compile = (name) => ajv.compile(readJson(resolve(GRAPH_CONTRACT_ROOT, name)));
  contractValidators = {
    node: compile("graph-node.schema.json"),
    edge: compile("graph-edge.schema.json"),
    manifest: compile("graph-manifest.schema.json"),
    context: compile("graph-context.schema.json"),
    decision: compile("memory-decision.schema.json"),
  };
  return contractValidators;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return "";
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`,
    );
  }
  return result.stdout.trim();
}

export function graphRepositoryIdentity(projectRoot) {
  const root = resolve(projectRoot);
  const common = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const canonical = resolve(common);
  return { commonDir: canonical, repositoryId: sha256(canonical) };
}

function dirtyOverlayDigest(root) {
  const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = status
    .split("\0")
    .filter(Boolean)
    .filter((entry) => !entry.slice(3).replaceAll("\\", "/").startsWith(".pipeline/"));
  const parts = [entries.join("\0")];
  for (const entry of entries.sort()) {
    const path = entry.slice(3);
    const absolute = resolve(root, path.includes(" -> ") ? path.split(" -> ").at(-1) : path);
    if (!safeRegularFile(absolute, root)) continue;
    const data = readFileSync(absolute);
    parts.push(`${path}\0${sha256(data)}`);
  }
  return sha256(parts.join("\0"));
}

export function graphSnapshotIdentity(projectRoot) {
  const tree = runGit(projectRoot, ["rev-parse", "HEAD^{tree}"]);
  const overlay = dirtyOverlayDigest(projectRoot);
  return { treeDigest: tree, overlayDigest: overlay, snapshotId: sha256(`${tree}\0${overlay}`) };
}

function transactionTime(root, runDir) {
  if (runDir && existsSync(resolve(runDir, "request.json"))) {
    const request = readJson(resolve(runDir, "request.json"));
    if (typeof request.requested_at === "string") return request.requested_at;
  }
  return runGit(root, ["show", "-s", "--format=%cI", "HEAD"]);
}

function credentialLike(path) {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .some(
      (part) =>
        part === ".env" ||
        part.startsWith(".env.") ||
        /\.(?:key|pem|p12|pfx)$/.test(part) ||
        [
          "auth.json",
          ".git-credentials",
          ".netrc",
          ".npmrc",
          ".pypirc",
          "id_rsa",
          "id_ed25519",
        ].includes(part) ||
        [".git", ".ssh", ".aws", ".azure", ".docker", ".gnupg", ".kube"].includes(part),
    );
}

function contained(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function graphRunPaths(root, runId) {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("invalid graph run id");
  }
  const canonicalRunsRoot = resolve(root, ".pipeline", "runs");
  const runDir = resolve(canonicalRunsRoot, runId);
  const graphDir = resolve(runDir, "graph");
  if (!contained(runDir, canonicalRunsRoot) || !contained(graphDir, canonicalRunsRoot)) {
    throw new Error("graph directory must remain under .pipeline/runs");
  }
  return { runDir, graphDir };
}

function safeRegularFile(path, root) {
  try {
    return contained(path, root) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWrite(path, body, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, body, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonl(records) {
  return records.map((record) => canonicalJson(record)).join("\n") + (records.length ? "\n" : "");
}

function sourceDigest(root, ref) {
  const absolute = resolve(root, ref);
  if (!safeRegularFile(absolute, root))
    throw new Error(`graph source does not resolve to a safe regular file: ${ref}`);
  return sha256(readFileSync(absolute));
}

function recordBase({ family, repositoryId, runId, sourceRef, sourceHash, time, trust }) {
  if (!TRUST.has(trust)) throw new Error(`invalid graph trust class: ${trust}`);
  return {
    graph_family: family,
    repository_id: repositoryId,
    run_id: runId ?? null,
    source_ref: sourceRef,
    source_digest: sourceHash,
    projector: GRAPH_PROJECTOR,
    transaction_time: time,
    valid_from: time,
    valid_to: null,
    trust_class: trust,
  };
}

function addNode(graph, spec) {
  const logicalId = `${spec.kind}:${spec.id}`;
  const base = recordBase(spec);
  const versionId = sha256(`${spec.kind}\0${logicalId}\0${base.source_digest}`);
  graph.nodes.push({
    record_type: "node",
    ...base,
    kind: spec.kind,
    logical_id: logicalId,
    version_id: versionId,
    attributes: spec.attributes ?? {},
  });
  return logicalId;
}

function addEdge(graph, spec) {
  const base = recordBase(spec);
  const logicalId = `${spec.kind}:${spec.from}->${spec.to}`;
  const versionId = sha256(`${spec.kind}\0${logicalId}\0${base.source_digest}`);
  graph.edges.push({
    record_type: "edge",
    ...base,
    kind: spec.kind,
    logical_id: logicalId,
    version_id: versionId,
    from: spec.from,
    to: spec.to,
    attributes: spec.attributes ?? {},
  });
  return logicalId;
}

function trackedFiles(root, planOwned = []) {
  const staged = runGit(root, ["ls-files", "-s", "-z"]);
  const out = new Set();
  for (const row of staged.split("\0").filter(Boolean)) {
    const match = row.match(/^(\d+) [a-f0-9]+ \d+\t(.+)$/);
    if (!match || match[1] === "160000") continue;
    out.add(match[2]);
  }
  const changed = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  for (const row of changed.split("\0").filter(Boolean)) {
    const path = row.slice(3);
    const candidate = path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
    if (
      planOwned.some(
        (owned) =>
          owned === candidate ||
          (owned.endsWith("/**") && candidate.startsWith(owned.slice(0, -2))),
      )
    )
      out.add(candidate);
  }
  return [...out].sort().filter((path) => {
    if (credentialLike(path) || path.startsWith(".pipeline/")) return false;
    const absolute = resolve(root, path);
    if (!safeRegularFile(absolute, root)) return false;
    const stat = lstatSync(absolute);
    if (stat.size > GRAPH_LIMITS.maxFileBytes) return false;
    const head = readFileSync(absolute).subarray(0, 8192);
    return !head.includes(0);
  });
}

function planOwnedPaths(runDir) {
  const path = resolve(runDir, "plan.json");
  if (!existsSync(path)) return [];
  const ownership = readJson(path).file_ownership ?? {};
  return Object.keys(ownership).sort();
}

function resolveLiteral(fromPath, literal, fileSet) {
  if (!literal || credentialLike(literal) || /^[a-z]+:/i.test(literal) || literal.startsWith("#"))
    return null;
  const clean = literal.split("?")[0].split("#")[0];
  const base = clean.startsWith("/")
    ? clean.slice(1)
    : relative("/", resolve("/", dirname(fromPath), clean));
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    `${base}.py`,
    `${base}/index.js`,
    `${base}/index.ts`,
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function literalReferences(path, text, fileSet) {
  const refs = new Set();
  const patterns = [
    "(?:from\\s+|import\\s*\\(|require\\s*\\(|source\\s+|\\.\\s+)[\"']([^\"']+)[\"']",
    '\\[[^\\]]*\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)',
    "[\"']((?:\\.\\.?\\/|\\/)?[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)+)[\"']",
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const resolved = resolveLiteral(path, match[1], fileSet);
      if (resolved && resolved !== path) refs.add(resolved);
    }
  }
  for (const literal of manifestLiterals(path, text)) {
    const resolved = resolveLiteral(path, literal, fileSet);
    if (resolved && resolved !== path) refs.add(resolved);
  }
  return [...refs].sort();
}

function manifestLiterals(path, text) {
  if (extname(path) === ".json") {
    try {
      const strings = [];
      const visit = (value) => {
        if (typeof value === "string") strings.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") Object.values(value).forEach(visit);
      };
      visit(JSON.parse(text));
      return strings;
    } catch {
      return [];
    }
  }
  if (extname(path) === ".toml")
    return [...text.matchAll(/=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  return [];
}

function pythonImportReferences(root, pythonFiles, fileSet) {
  if (!pythonFiles.length) return new Map();
  const script = `import ast,json,sys
root=sys.argv[1]
out={}
for rel in json.load(sys.stdin):
 try:
  tree=ast.parse(open(root+'/'+rel,encoding='utf-8').read(),filename=rel)
 except (OSError,SyntaxError,UnicodeError):
  continue
 vals=[]
 for n in ast.walk(tree):
  if isinstance(n,ast.Import): vals += [a.name for a in n.names]
  elif isinstance(n,ast.ImportFrom) and n.module:
   vals.append('.'*n.level+n.module)
   vals += ['.'*n.level+n.module+'.'+a.name for a in n.names if a.name != '*']
 out[rel]=vals
print(json.dumps(out,sort_keys=True))`;
  const proc = spawnSync(process.env.RAE_PYTHON_BIN || "python3", ["-B", "-c", script, root], {
    input: JSON.stringify(pythonFiles),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.status !== 0) return new Map();
  const parsed = JSON.parse(proc.stdout || "{}");
  const output = new Map();
  for (const [path, modules] of Object.entries(parsed)) {
    const refs = new Set();
    for (const module of modules) {
      let bare = module;
      while (bare.startsWith(".")) bare = bare.slice(1);
      bare = bare.replaceAll(".", "/");
      for (const candidate of [
        `${bare}.py`,
        `${bare}/__init__.py`,
        `${dirname(path)}/${bare}.py`,
        `${dirname(path)}/${bare}/__init__.py`,
      ]) {
        const normalized = candidate.startsWith("./") ? candidate.slice(2) : candidate;
        if (fileSet.has(normalized) && normalized !== path) refs.add(normalized);
      }
    }
    output.set(path, [...refs].sort());
  }
  return output;
}

function projectRepository(graph, root, source, files, snapshotId) {
  const repoNode = addNode(graph, {
    ...source,
    family: "repository",
    trust: "authoritative",
    kind: "Repository",
    id: source.repositoryId,
    attributes: { identity: source.repositoryId },
  });
  const snapshotNode = addNode(graph, {
    ...source,
    family: "repository",
    trust: "authoritative",
    kind: "ProjectSnapshot",
    id: snapshotId,
    attributes: { snapshot_id: snapshotId },
  });
  addEdge(graph, {
    ...source,
    family: "repository",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: repoNode,
    to: snapshotNode,
  });
  const fileSet = new Set(files);
  const pythonRefs = pythonImportReferences(
    root,
    files.filter((path) => extname(path) === ".py"),
    fileSet,
  );
  for (const path of files) {
    const hash = sourceDigest(root, path);
    const fileSource = { ...source, sourceRef: path, sourceHash: hash };
    const node = addNode(graph, {
      ...fileSource,
      family: "repository",
      trust: "authoritative",
      kind: "File",
      id: path,
      attributes: {
        path,
        bytes: lstatSync(resolve(root, path)).size,
        language: extname(path).slice(1) || "unknown",
      },
    });
    addEdge(graph, {
      ...fileSource,
      family: "repository",
      trust: "verified-derived",
      kind: "CONTAINS",
      from: snapshotNode,
      to: node,
    });
    const text = readFileSync(resolve(root, path), "utf8");
    const refs = new Set([
      ...literalReferences(path, text, fileSet),
      ...(pythonRefs.get(path) ?? []),
    ]);
    for (const target of [...refs].sort()) {
      addEdge(graph, {
        ...fileSource,
        family: "repository",
        trust: "verified-derived",
        kind: "REFERENCES",
        from: node,
        to: `File:${target}`,
        attributes: { extractor: extname(path) === ".py" ? "literal-or-python-ast" : "literal" },
      });
    }
  }
  return { repoNode, snapshotNode };
}

function addArtifactChild(graph, source, artifactId, family, kind, id, attributes, edgeKind) {
  const child = addNode(graph, {
    ...source,
    family,
    trust: "model-proposed",
    kind,
    id,
    attributes,
  });
  if (!edgeKind) return child;
  addEdge(graph, {
    ...source,
    family,
    trust: "model-proposed",
    kind: edgeKind,
    from: edgeKind === "DERIVED_FROM" ? child : artifactId,
    to: edgeKind === "DERIVED_FROM" ? artifactId : child,
  });
  return child;
}

function projectArtifactRequirements(graph, source, artifactId, artifact) {
  for (const req of artifact.requirements ?? []) {
    if (!req?.id) continue;
    addArtifactChild(
      graph,
      source,
      artifactId,
      "evidence",
      "Requirement",
      req.id,
      {
        priority: req.priority,
        text: req.statement ?? req.description ?? "",
      },
      "CONTAINS",
    );
  }
}

function projectArtifactConstraints(graph, source, artifactId, artifact) {
  for (const constraint of artifact.constraints ?? artifact.constraints_classification ?? []) {
    addArtifactChild(
      graph,
      source,
      artifactId,
      "evidence",
      "Constraint",
      artifactRecordKey(constraint, "constraint_id"),
      {
        text: constraint.statement ?? constraint.constraint ?? "",
      },
      "CONTAINS",
    );
  }
}

function artifactRecordKey(record, fallbackKey) {
  return record.id ?? record[fallbackKey] ?? sha256(canonicalJson(record)).slice(0, 16);
}

function projectTaskCoverage(graph, source, from, requirementIds, kind) {
  for (const reqId of requirementIds ?? [])
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "model-proposed",
      kind,
      from,
      to: `Requirement:${reqId}`,
    });
}

function projectTaskTests(graph, source, artifactId, task, taskId) {
  for (const test of task.test_cases ?? []) {
    const name = test.name ?? test.trace_id;
    if (!name) continue;
    const testId = addArtifactChild(
      graph,
      source,
      artifactId,
      "workflow",
      "TestCase",
      `${task.id}:${name}`,
      { name, command: test.command ?? "" },
      null,
    );
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "model-proposed",
      kind: "VERIFIES",
      from: testId,
      to: taskId,
    });
    projectTaskCoverage(graph, source, testId, test.covers_requirement_ids, "VERIFIES");
  }
}

function projectArtifactTasks(graph, source, artifactId, artifact) {
  for (const group of artifact.task_groups ?? []) {
    for (const task of group.tasks ?? []) {
      if (!task?.id) continue;
      const taskId = addArtifactChild(
        graph,
        source,
        artifactId,
        "workflow",
        "PlanTask",
        task.id,
        {
          title: task.title ?? task.description ?? "",
        },
        "CONTAINS",
      );
      projectTaskCoverage(graph, source, taskId, task.covers_requirement_ids, "COVERS");
      projectTaskTests(graph, source, artifactId, task, taskId);
    }
  }
}

function projectArtifactEvidence(graph, source, artifactId, phase, artifact) {
  projectArtifactFindings(graph, source, artifactId, phase, artifact);
  projectArtifactClaims(graph, source, artifactId, phase, artifact);
}

function projectArtifactFindings(graph, source, artifactId, phase, artifact) {
  const findings = artifact.deduplicated_findings ?? artifact.findings ?? artifact.violations ?? [];
  for (const finding of findings) {
    const key = artifactRecordKey(finding, "finding_id");
    addArtifactChild(
      graph,
      source,
      artifactId,
      "evidence",
      "Finding",
      `${phase}:${key}`,
      findingAttributes(finding),
      "DERIVED_FROM",
    );
  }
}

function findingAttributes(finding) {
  return {
    severity: finding.severity ?? "unknown",
    summary: finding.summary ?? finding.message ?? "",
  };
}

function projectArtifactClaims(graph, source, artifactId, phase, artifact) {
  for (const claim of artifact.claims ?? []) {
    const key = artifactRecordKey(claim, "claim_id");
    addArtifactChild(
      graph,
      source,
      artifactId,
      "evidence",
      "Claim",
      `${phase}:${key}`,
      {
        status: claim.verification_status ?? "proposed",
        text: claim.statement ?? claim.claim ?? "",
      },
      "DERIVED_FROM",
    );
  }
}

function artifactNode(graph, root, runDir, runNode, phase, source) {
  const rel = relative(root, resolve(runDir, PHASE_ARTIFACTS[phase]));
  const absolute = resolve(root, rel);
  if (!safeRegularFile(absolute, root)) return null;
  const hash = sourceDigest(root, rel);
  const artifact = readJson(absolute);
  const artifactSource = { ...source, sourceRef: rel, sourceHash: hash };
  const artifactId = addNode(graph, {
    ...artifactSource,
    family: "evidence",
    trust: "model-proposed",
    kind: "ArtifactVersion",
    id: `${phase}:${hash}`,
    attributes: { phase, path: rel },
  });
  addEdge(graph, {
    ...artifactSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: runNode,
    to: artifactId,
  });
  projectArtifactRequirements(graph, artifactSource, artifactId, artifact);
  projectArtifactConstraints(graph, artifactSource, artifactId, artifact);
  projectArtifactTasks(graph, artifactSource, artifactId, artifact);
  projectArtifactEvidence(graph, artifactSource, artifactId, phase, artifact);
  return artifactId;
}

function projectPhaseEvidence(graph, root, runDir, runId, phase, previous, runNode, source) {
  const phaseNode = addNode(graph, {
    ...source,
    family: "workflow",
    trust: "authoritative",
    kind: "PhaseAttempt",
    id: `${runId}:${phase}`,
    attributes: { phase },
  });
  addEdge(graph, {
    ...source,
    family: "workflow",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: runNode,
    to: phaseNode,
  });
  if (previous)
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "verified-derived",
      kind: "DEPENDS_ON",
      from: phaseNode,
      to: previous,
    });
  const artifact = artifactNode(graph, root, runDir, runNode, phase, source);
  if (artifact)
    addEdge(graph, {
      ...source,
      family: "workflow",
      trust: "verified-derived",
      kind: "WRITES",
      from: phaseNode,
      to: artifact,
    });
  projectCommandEvents(graph, root, runDir, runId, phase, phaseNode, source);
  projectPhaseGate(graph, root, runDir, runId, phase, phaseNode, artifact, source);
  return phaseNode;
}

function projectPhaseGate(graph, root, runDir, runId, phase, phaseNode, artifact, source) {
  const gateName = phase === "post-build" ? "postbuild-gate.json" : `${phase}-gate.json`;
  const gateRel = relative(root, resolve(runDir, "gates", gateName));
  if (!safeRegularFile(resolve(root, gateRel), root)) return;
  const hash = sourceDigest(root, gateRel);
  const gateSource = { ...source, sourceRef: gateRel, sourceHash: hash };
  const gate = readJson(resolve(root, gateRel));
  const gateNode = addNode(graph, {
    ...gateSource,
    family: "evidence",
    trust: "authoritative",
    kind: "GateDecision",
    id: gate.gate_id ?? `${runId}:${phase}`,
    attributes: { phase, status: gate.status },
  });
  addEdge(graph, {
    ...gateSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "EVALUATES",
    from: gateNode,
    to: phaseNode,
  });
  if (artifact)
    addEdge(graph, {
      ...gateSource,
      family: "evidence",
      trust: "verified-derived",
      kind: "EVALUATES",
      from: gateNode,
      to: artifact,
    });
}

function projectRunEvidence(graph, root, runDir, runId, source, repoNode) {
  const requestRel = relative(root, resolve(runDir, "request.json"));
  if (!safeRegularFile(resolve(root, requestRel), root)) return;
  const requestHash = sourceDigest(root, requestRel);
  const requestSource = { ...source, sourceRef: requestRel, sourceHash: requestHash };
  const runNode = addNode(graph, {
    ...requestSource,
    family: "workflow",
    trust: "authoritative",
    kind: "Run",
    id: runId,
    attributes: { run_id: runId },
  });
  const requestNode = addNode(graph, {
    ...requestSource,
    family: "evidence",
    trust: "authoritative",
    kind: "SourceDocument",
    id: `${runId}:request`,
    attributes: { document_type: "run-request" },
  });
  addEdge(graph, {
    ...requestSource,
    family: "workflow",
    trust: "verified-derived",
    kind: "CONTAINS",
    from: repoNode,
    to: runNode,
  });
  addEdge(graph, {
    ...requestSource,
    family: "evidence",
    trust: "verified-derived",
    kind: "DERIVED_FROM",
    from: runNode,
    to: requestNode,
  });
  let previous = null;
  for (const phase of PHASES)
    previous = projectPhaseEvidence(graph, root, runDir, runId, phase, previous, runNode, source);
  projectCheckpointDecisions(graph, root, runDir, runId, source);
}

function projectCheckpointDecisions(graph, root, runDir, runId, source) {
  const directory = resolve(runDir, "checkpoints");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || extname(entry.name) !== ".json") continue;
    const rel = relative(root, resolve(directory, entry.name));
    if (!safeRegularFile(resolve(root, rel), root)) continue;
    const checkpoint = readJson(resolve(root, rel));
    if (!checkpoint.decision || !["approved", "rejected", "escalated"].includes(checkpoint.status))
      continue;
    const hash = sourceDigest(root, rel);
    const checkpointSource = { ...source, sourceRef: rel, sourceHash: hash };
    const node = addNode(graph, {
      ...checkpointSource,
      family: "evidence",
      trust: "authoritative",
      kind: "CheckpointDecision",
      id: checkpoint.checkpoint_id ?? `${runId}:${entry.name}`,
      attributes: {
        phase: checkpoint.phase,
        status: checkpoint.status,
        actor: checkpoint.decision.actor,
      },
    });
    const phaseNode = `PhaseAttempt:${runId}:${checkpoint.phase}`;
    if (graph.nodes.some((item) => item.logical_id === phaseNode))
      addEdge(graph, {
        ...checkpointSource,
        family: "evidence",
        trust: "verified-derived",
        kind: "AUTHORIZED_BY",
        from: phaseNode,
        to: node,
      });
  }
}

function commandFromEvent(line, index) {
  try {
    const event = JSON.parse(line);
    const item = event.item ?? event;
    if (item.type !== "command_execution") return null;
    return {
      item,
      command: Array.isArray(item.command) ? item.command.join(" ") : String(item.command ?? ""),
    };
  } catch {
    throw new Error(`corrupt agent event JSONL at line ${index + 1}`);
  }
}

function linkCommandTests(graph, source, commandNode, command) {
  for (const test of graph.nodes.filter(
    (node) => node.kind === "TestCase" && node.attributes.command === command,
  )) {
    addEdge(graph, {
      ...source,
      family: "evidence",
      trust: "verified-derived",
      kind: "VERIFIES",
      from: commandNode,
      to: test.logical_id,
    });
  }
}

function projectCommandEvents(graph, root, runDir, runId, phase, phaseNode, source) {
  const eventRel = relative(root, resolve(runDir, "agent-outputs", `${phase}.events.jsonl`));
  if (!safeRegularFile(resolve(root, eventRel), root)) return;
  const eventHash = sourceDigest(root, eventRel);
  const eventSource = { ...source, sourceRef: eventRel, sourceHash: eventHash };
  for (const [index, line] of readFileSync(resolve(root, eventRel), "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const event = commandFromEvent(line, index);
    if (!event) continue;
    const { item, command } = event;
    const commandDigest = sha256(command);
    const commandNode = addNode(graph, {
      ...eventSource,
      family: "evidence",
      trust: "authoritative",
      kind: "CommandExecution",
      id: `${runId}:${phase}:${index + 1}`,
      attributes: {
        phase,
        status: item.exit_code === 0 ? "pass" : "fail",
        command_digest: commandDigest,
      },
    });
    addEdge(graph, {
      ...eventSource,
      family: "evidence",
      trust: "verified-derived",
      kind: "CONTAINS",
      from: phaseNode,
      to: commandNode,
    });
    linkCommandTests(graph, eventSource, commandNode, command);
  }
}

function validateRecordSource(record, root, verifySources, issues) {
  if (!verifySources || record.source_ref.startsWith("git:")) return;
  try {
    if (sourceDigest(root, record.source_ref) !== record.source_digest)
      issues.push(`digest mismatch: ${record.logical_id}`);
  } catch {
    issues.push(`unresolved source: ${record.logical_id}`);
  }
}

function validateNodes(nodes, root, verifySources, contracts, ids, versions, issues) {
  for (const node of nodes) {
    if (!contracts.node(node)) issues.push(`node schema violation: ${node.logical_id}`);
    if (ids.has(node.logical_id)) issues.push(`duplicate logical node id: ${node.logical_id}`);
    ids.add(node.logical_id);
    if (versions.has(node.version_id)) issues.push(`duplicate version id: ${node.version_id}`);
    versions.add(node.version_id);
    if (!TRUST.has(node.trust_class)) issues.push(`invalid trust class: ${node.logical_id}`);
    if (node.valid_to && new Date(node.valid_to) < new Date(node.valid_from))
      issues.push(`invalid temporal interval: ${node.logical_id}`);
    validateRecordSource(node, root, verifySources, issues);
  }
}

function validateEdges(edges, root, verifySources, contracts, ids, versions, issues) {
  for (const edge of edges) {
    if (!contracts.edge(edge)) issues.push(`edge schema violation: ${edge.logical_id}`);
    if (!EDGE_KINDS.has(edge.kind)) issues.push(`invalid edge kind: ${edge.logical_id}`);
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push(`orphan edge: ${edge.logical_id}`);
    if (versions.has(edge.version_id)) issues.push(`duplicate version id: ${edge.version_id}`);
    versions.add(edge.version_id);
    if (edge.valid_to && new Date(edge.valid_to) < new Date(edge.valid_from))
      issues.push(`invalid temporal interval: ${edge.logical_id}`);
    validateRecordSource(edge, root, verifySources, issues);
  }
}

export function validateGraph(nodes, edges, root, { verifySources = true } = {}) {
  const issues = [];
  const contracts = graphContractValidators();
  const repositoryIds = new Set([...nodes, ...edges].map((record) => record.repository_id));
  if (repositoryIds.size > 1) issues.push("cross-repository records are not allowed");
  const ids = new Set();
  const versions = new Set();
  validateNodes(nodes, root, verifySources, contracts, ids, versions, issues);
  validateEdges(edges, root, verifySources, contracts, ids, versions, issues);
  if (nodes.length > GRAPH_LIMITS.maxNodes) issues.push(`node limit exceeded: ${nodes.length}`);
  if (edges.length > GRAPH_LIMITS.maxEdges) issues.push(`edge limit exceeded: ${edges.length}`);
  if (hasDependencyCycle(edges)) issues.push("dependency cycle detected");
  if (
    nodes.some(
      (node) => node.kind === "GateDecision" && node.attributes.phase === "release-readiness",
    )
  ) {
    issues.push(...mustRequirementPathIssues(nodes, edges));
  }
  return { valid: issues.length === 0, issues };
}

function hasDependencyCycle(edges) {
  const adjacency = new Map();
  for (const edge of edges.filter((item) => item.kind === "DEPENDS_ON"))
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

function traversedEvidenceKinds(requirementId, adjacency, byId) {
  const seen = new Set([requirementId]);
  let frontier = [requirementId];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier)
      for (const neighbor of adjacency.get(id) ?? [])
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
    frontier = next;
  }
  return new Set([...seen].map((id) => byId.get(id)?.kind).filter(Boolean));
}

function mustRequirementPathIssues(nodes, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const byId = new Map(nodes.map((node) => [node.logical_id, node]));
  const requiredKinds = ["PlanTask", "TestCase", "CommandExecution", "GateDecision"];
  const issues = [];
  for (const requirement of nodes.filter(
    (node) => node.kind === "Requirement" && node.attributes.priority === "must",
  )) {
    const found = traversedEvidenceKinds(requirement.logical_id, adjacency, byId);
    const missing = requiredKinds.filter((kind) => !found.has(kind));
    if (missing.length)
      issues.push(
        `MUST requirement lacks traversable evidence path (${missing.join(", ")}): ${requirement.logical_id}`,
      );
  }
  return issues;
}

function graphSource(root, repositoryId, runId, runDir) {
  const sourceRef =
    runDir && existsSync(resolve(runDir, "request.json"))
      ? relative(root, resolve(runDir, "request.json"))
      : "README.md";
  return {
    repositoryId,
    runId,
    sourceRef,
    sourceHash: sourceDigest(root, sourceRef),
    time: transactionTime(root, runDir),
  };
}

function selectedGraphRun(runId, statePath, snapshotId) {
  const state = existsSync(statePath) ? readJson(statePath) : null;
  return runId ?? state?.run_id ?? `repository-${snapshotId.slice(0, 16)}`;
}

function graphProjectionContext(root, runId, identity, snapshot) {
  const statePath = resolve(root, ".pipeline", "pipeline-state.json");
  const selectedRun = selectedGraphRun(runId, statePath, snapshot.snapshotId);
  const { runDir, graphDir: outputDir } = graphRunPaths(root, selectedRun);
  const hasRun = existsSync(resolve(runDir, "request.json"));
  if (runId && !hasRun) throw new Error(`run not found: ${runId}`);
  const source = graphSource(
    root,
    identity.repositoryId,
    hasRun ? selectedRun : null,
    hasRun ? runDir : null,
  );
  return { selectedRun, runDir, hasRun, outputDir, source };
}

function graphManifest(graph, root, identity, snapshot, selectedRun, source) {
  graph.nodes.sort(
    (a, b) => a.logical_id.localeCompare(b.logical_id) || a.version_id.localeCompare(b.version_id),
  );
  graph.edges.sort(
    (a, b) => a.logical_id.localeCompare(b.logical_id) || a.version_id.localeCompare(b.version_id),
  );
  const validation = validateGraph(graph.nodes, graph.edges, root);
  if (!validation.valid)
    throw new Error(`graph validation failed: ${validation.issues.join("; ")}`);
  const nodesBody = jsonl(graph.nodes);
  const edgesBody = jsonl(graph.edges);
  const manifestCore = {
    schema_version: "1.0.0",
    projector: GRAPH_PROJECTOR,
    repository_id: identity.repositoryId,
    snapshot_id: snapshot.snapshotId,
    run_id: selectedRun,
    transaction_time: source.time,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    nodes_digest: sha256(nodesBody),
    edges_digest: sha256(edgesBody),
    limits: {
      max_nodes: GRAPH_LIMITS.maxNodes,
      max_edges: GRAPH_LIMITS.maxEdges,
      max_file_bytes: GRAPH_LIMITS.maxFileBytes,
    },
    validation,
  };
  const manifest = { ...manifestCore, canonical_digest: sha256(canonicalJson(manifestCore)) };
  if (!graphContractValidators().manifest(manifest))
    throw new Error("graph manifest does not satisfy its contract");
  return { manifest, nodesBody, edgesBody };
}

function writeGraphProjection(outputDir, nodesBody, edgesBody, manifest) {
  mkdirSync(resolve(outputDir, "contexts"), { recursive: true, mode: 0o700 });
  atomicWrite(resolve(outputDir, "nodes.jsonl"), nodesBody);
  atomicWrite(resolve(outputDir, "edges.jsonl"), edgesBody);
  atomicWrite(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function projectGraph({ projectRoot, runId = null }) {
  const root = resolve(projectRoot);
  const identity = graphRepositoryIdentity(root);
  const snapshot = graphSnapshotIdentity(root);
  const { selectedRun, runDir, hasRun, outputDir, source } = graphProjectionContext(
    root,
    runId,
    identity,
    snapshot,
  );
  const graph = { nodes: [], edges: [] };
  const files = trackedFiles(root, hasRun ? planOwnedPaths(runDir) : []);
  const { repoNode } = projectRepository(graph, root, source, files, snapshot.snapshotId);
  if (hasRun) projectRunEvidence(graph, root, runDir, selectedRun, source, repoNode);
  const { manifest, nodesBody, edgesBody } = graphManifest(
    graph,
    root,
    identity,
    snapshot,
    selectedRun,
    source,
  );
  writeGraphProjection(outputDir, nodesBody, edgesBody, manifest);
  return { ...manifest, graph_dir: relative(root, outputDir) };
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`corrupt JSONL at ${path}:${index + 1}`);
      }
    });
}

export function loadGraph(projectRoot, runId) {
  const root = resolve(projectRoot);
  const statePath = resolve(root, ".pipeline", "pipeline-state.json");
  const selectedRun =
    runId ?? (existsSync(statePath) ? readJson(statePath).run_id : discoverProjectionRun(root));
  if (!selectedRun) throw new Error("--run-id is required when no active pipeline state exists");
  const { graphDir } = graphRunPaths(root, selectedRun);
  const manifestPath = resolve(graphDir, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error(`graph projection not found for run: ${selectedRun}`);
  const manifest = readJson(manifestPath);
  validateLoadedManifest(manifest, selectedRun, graphRepositoryIdentity(root).repositoryId);
  const nodes = readJsonl(resolve(graphDir, "nodes.jsonl"));
  const edges = readJsonl(resolve(graphDir, "edges.jsonl"));
  if (
    sha256(jsonl(nodes)) !== manifest.nodes_digest ||
    sha256(jsonl(edges)) !== manifest.edges_digest
  )
    throw new Error("graph projection digest mismatch");
  validateManifestRecordCounts(manifest, nodes, edges);
  const validation = validateGraph(nodes, edges, root, { verifySources: false });
  if (!validation.valid)
    throw new Error(`graph validation failed: ${validation.issues.join("; ")}`);
  return { root, runId: selectedRun, graphDir, manifest, nodes, edges };
}

function validateLoadedManifest(manifest, selectedRun, repositoryId) {
  if (!graphContractValidators().manifest(manifest)) {
    throw new Error("graph manifest does not satisfy its contract");
  }
  const { canonical_digest: canonicalDigest, ...manifestCore } = manifest;
  if (canonicalDigest !== sha256(canonicalJson(manifestCore))) {
    throw new Error("graph manifest canonical digest mismatch");
  }
  if (manifest.run_id !== selectedRun) {
    throw new Error("graph manifest run id mismatch");
  }
  if (manifest.repository_id !== repositoryId) {
    throw new Error("graph manifest repository identity mismatch");
  }
}

function validateManifestRecordCounts(manifest, nodes, edges) {
  if (manifest.node_count !== nodes.length || manifest.edge_count !== edges.length) {
    throw new Error("graph manifest record count mismatch");
  }
}

function discoverProjectionRun(root) {
  const runsRoot = resolve(root, ".pipeline", "runs");
  if (!existsSync(runsRoot)) return null;
  const candidates = readdirSync(runsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(resolve(runsRoot, entry.name, "graph", "manifest.json")),
    )
    .map((entry) => ({
      id: entry.name,
      manifest: readJson(resolve(runsRoot, entry.name, "graph", "manifest.json")),
    }))
    .sort(
      (a, b) =>
        String(b.manifest.transaction_time).localeCompare(String(a.manifest.transaction_time)) ||
        a.id.localeCompare(b.id),
    );
  const currentSnapshot = graphSnapshotIdentity(root).snapshotId;
  return (
    candidates.find((item) => item.manifest.snapshot_id === currentSnapshot)?.id ??
    candidates[0]?.id ??
    null
  );
}

function sourceSnippet(root, node) {
  if (node.source_ref.startsWith("git:") || credentialLike(node.source_ref)) return "";
  if (node.source_ref.includes("/agent-outputs/") || node.source_ref.endsWith(".events.jsonl"))
    return canonicalJson(node.attributes).slice(0, 2000);
  const absolute = resolve(root, node.source_ref);
  if (!safeRegularFile(absolute, root)) return "";
  return readFileSync(absolute, "utf8").slice(0, 2000);
}

function tokens(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .match(/[a-z0-9_./-]{2,}/g) ?? [],
  );
}

export function queryGraph({
  projectRoot,
  runId,
  seed,
  phase = "query",
  maxDepth = 4,
  maxRecords = 200,
  includeModelProposed = false,
}) {
  if (!seed) throw new Error("graph query requires --seed <kind:id>");
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4)
    throw new Error("graph query depth must be between 0 and 4");
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200)
    throw new Error("graph query limit must be between 1 and 200");
  const graph = loadGraph(projectRoot, runId);
  const allowed = includeModelProposed
    ? new Set(["authoritative", "verified-derived", "model-proposed"])
    : new Set(["authoritative", "verified-derived"]);
  const currentSnapshot =
    graphSnapshotIdentity(graph.root).snapshotId === graph.manifest.snapshot_id;
  const isCurrent = (node) =>
    node.graph_family === "repository" ? currentSnapshot : sourceCurrent(graph.root, node);
  const nodes = new Map(
    graph.nodes
      .filter((node) => allowed.has(node.trust_class) && isCurrent(node))
      .map((node) => [node.logical_id, node]),
  );
  const searchText = new Map();
  const nodeSearchText = (node) => {
    if (!searchText.has(node.logical_id))
      searchText.set(
        node.logical_id,
        `${node.logical_id} ${canonicalJson(node.attributes)} ${node.kind === "File" ? sourceSnippet(graph.root, node) : ""}`,
      );
    return searchText.get(node.logical_id);
  };
  const adjacency = new Map();
  for (const edge of graph.edges.filter((item) => allowed.has(item.trust_class))) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
  }
  const seedTokens = tokens(seed);
  const preliminary = [...nodes.values()]
    .map((node) => {
      const nodeTokens = tokens(nodeSearchText(node));
      return {
        id: node.logical_id,
        overlap: [...seedTokens].filter((token) => nodeTokens.has(token)).length,
      };
    })
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.id.localeCompare(b.id));
  const exactSeeds = [...nodes.keys()].filter(
    (id) => id === seed || id.toLowerCase().includes(seed.toLowerCase()),
  );
  if (!exactSeeds.length) exactSeeds.push(...preliminary.slice(0, 10).map((entry) => entry.id));
  const distances = new Map(exactSeeds.map((id) => [id, 0]));
  let frontier = exactSeeds;
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const id of frontier)
      for (const neighbor of adjacency.get(id) ?? [])
        if (!distances.has(neighbor)) {
          distances.set(neighbor, depth);
          next.push(neighbor);
        }
    frontier = next;
  }
  const ranked = [];
  for (const node of nodes.values()) {
    const idTokens = tokens(nodeSearchText(node));
    const overlap = [...seedTokens].filter((token) => idTokens.has(token)).length;
    const lexical = seedTokens.size ? overlap / seedTokens.size : 0;
    const exact =
      node.logical_id === seed
        ? 1
        : node.logical_id.toLowerCase().includes(seed.toLowerCase())
          ? 0.75
          : 0;
    const distance = distances.has(node.logical_id) ? 1 / (1 + distances.get(node.logical_id)) : 0;
    const total = exact * 100 + lexical * 10 + distance;
    if (total <= 0) continue;
    ranked.push({
      node,
      total,
      exact,
      lexical,
      distance,
      depth: distances.get(node.logical_id) ?? null,
    });
  }
  ranked.sort((a, b) => b.total - a.total || a.node.logical_id.localeCompare(b.node.logical_id));
  const records = ranked.slice(0, maxRecords).map((entry) => ({
    node_id: entry.node.logical_id,
    kind: entry.node.kind,
    selection_reason: entry.exact
      ? "exact path or identifier match"
      : entry.depth !== null
        ? "bounded graph traversal"
        : "lexical match",
    traversal_path: entry.depth === null ? [] : [seed, entry.node.logical_id].slice(0, 5),
    trust_class: entry.node.trust_class,
    source_ref: entry.node.source_ref,
    source_digest: entry.node.source_digest,
    staleness: "current",
    score: {
      exact: entry.exact,
      lexical: entry.lexical,
      distance: entry.distance,
      total: entry.total,
    },
    snippet: sourceSnippet(graph.root, entry.node),
  }));
  const queryId = sha256(
    canonicalJson({
      seed,
      phase,
      maxDepth,
      maxRecords,
      includeModelProposed,
      snapshot: graph.manifest.snapshot_id,
    }),
  );
  const bundle = {
    schema_version: "1.0.0",
    repository_id: graph.manifest.repository_id,
    snapshot_id: graph.manifest.snapshot_id,
    run_id: graph.runId,
    phase,
    query_id: queryId,
    seed,
    generated_at: graph.manifest.transaction_time,
    limits: { max_depth: maxDepth, max_records: maxRecords },
    records,
  };
  if (!graphContractValidators().context(bundle))
    throw new Error("graph context does not satisfy its contract");
  const contextPath = resolve(
    graph.graphDir,
    "contexts",
    `${phase.replace(/[^a-z0-9-]/gi, "-")}.json`,
  );
  atomicWrite(contextPath, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function sourceCurrent(root, node) {
  try {
    return (
      node.source_ref.startsWith("git:") ||
      sourceDigest(root, node.source_ref) === node.source_digest
    );
  } catch {
    return false;
  }
}

export function graphStatus({ projectRoot, runId }) {
  try {
    const graph = loadGraph(projectRoot, runId);
    const stale = graph.nodes.filter((node) => !sourceCurrent(graph.root, node)).length;
    return {
      available: true,
      repository_id: graph.manifest.repository_id,
      snapshot_id: graph.manifest.snapshot_id,
      run_id: graph.runId,
      canonical_digest: graph.manifest.canonical_digest,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      stale_sources: stale,
      unresolved_conflicts: 0,
      valid: stale === 0,
    };
  } catch (error) {
    return {
      available: false,
      valid: false,
      error: error.message,
      stale_sources: 0,
      unresolved_conflicts: 0,
    };
  }
}

export function explainGraphNode({ projectRoot, runId, nodeId }) {
  const graph = loadGraph(projectRoot, runId);
  const node = graph.nodes.find((item) => item.logical_id === nodeId || item.version_id === nodeId);
  if (!node) throw new Error(`graph node not found: ${nodeId}`);
  const edges = graph.edges.filter(
    (edge) => edge.from === node.logical_id || edge.to === node.logical_id,
  );
  return {
    node,
    current: sourceCurrent(graph.root, node),
    relationships: edges,
    source_snippet: sourceSnippet(graph.root, node),
  };
}

function memoryPaths(projectRoot) {
  const { commonDir, repositoryId } = graphRepositoryIdentity(projectRoot);
  const root = resolve(commonDir, "rae-memory", "v1");
  return {
    root,
    repositoryId,
    facts: resolve(root, "facts.jsonl"),
    candidates: resolve(root, "candidates.jsonl"),
    decisions: resolve(root, "decisions.jsonl"),
    sources: resolve(root, "sources"),
    lock: resolve(root, "memory.lock"),
  };
}

function memoryRecord(node, paths) {
  const evidence = canonicalJson({
    logical_id: node.logical_id,
    kind: node.kind,
    attributes: node.attributes,
    original_source_ref: node.source_ref,
    original_source_digest: node.source_digest,
  });
  const sourceBody = `${evidence}\n`;
  const digest = sha256(sourceBody);
  atomicWrite(resolve(paths.sources, `${digest}.json`), sourceBody);
  return {
    ...node,
    graph_family: "memory",
    source_ref: `memory:sources/${digest}.json`,
    source_digest: digest,
    version_id: sha256(`${node.kind}\0${node.logical_id}\0${digest}`),
    attributes: {
      ...node.attributes,
      original_source_ref: node.source_ref,
      original_source_digest: node.source_digest,
    },
  };
}

function memorySourceCurrent(paths, item) {
  if (!item.source_ref.startsWith("memory:sources/")) return sourceCurrent(paths.projectRoot, item);
  const name = item.source_ref.slice("memory:sources/".length);
  const path = resolve(paths.sources, name);
  try {
    return contained(path, paths.root) && sha256(readFileSync(path)) === item.source_digest;
  } catch {
    return false;
  }
}

function withMemoryLock(paths, operation) {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = acquireMemoryLock(paths.lock);
  } catch {
    throw new Error("graph memory is locked by another process");
  }
  try {
    return operation();
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(paths.lock, { force: true });
  }
}

function acquireMemoryLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      return fd;
    } catch (error) {
      if (error.code !== "EEXIST" || !staleMemoryLock(lockPath) || attempt > 0) throw error;
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error("unable to acquire graph memory lock");
}

function staleMemoryLock(lockPath) {
  try {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH" || error.code === "ENOENT";
  }
}

function appendJsonl(path, record) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  atomicWrite(path, `${existing}${canonicalJson(record)}\n`);
}

export function recordRunMemory({ projectRoot, runId }) {
  const runDir = resolve(projectRoot, ".pipeline", "runs", runId);
  const controlPath = resolve(runDir, "operator-control.json");
  const tracePath = resolve(runDir, "trace.jsonl");
  const completedControl = existsSync(controlPath) && readJson(controlPath).status === "completed";
  const completedTrace =
    existsSync(tracePath) && readFileSync(tracePath, "utf8").includes('"event":"run_completed"');
  if (!completedControl || !completedTrace)
    throw new Error("graph memory imports only completed runs with durable completion evidence");
  const graph = loadGraph(projectRoot, runId);
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  return withMemoryLock(paths, () => {
    const existing = new Map(readJsonl(paths.facts).map((item) => [item.version_id, item]));
    const candidates = new Map(readJsonl(paths.candidates).map((item) => [item.version_id, item]));
    const decisions = readJsonl(paths.decisions);
    for (const prior of existing.values()) {
      if (
        memorySourceCurrent(paths, prior) ||
        decisions.some(
          (item) => item.candidate_id === prior.version_id && item.decision === "invalidated",
        )
      )
        continue;
      const recordedAt = new Date().toISOString();
      decisions.push({
        schema_version: "1.0.0",
        decision_id: sha256(`${prior.version_id}\0invalidated\0${recordedAt}`),
        candidate_id: prior.version_id,
        decision: "invalidated",
        actor: GRAPH_PROJECTOR,
        rationale: "cached source digest no longer resolves",
        source_ref: prior.source_ref,
        source_digest: prior.source_digest,
        recorded_at: recordedAt,
      });
    }
    for (const node of graph.nodes) {
      if (!sourceCurrent(projectRoot, node)) continue;
      const storedNode = memoryRecord(node, paths);
      if (
        ["GateDecision", "CheckpointDecision", "CommandExecution", "ProjectSnapshot"].includes(
          storedNode.kind,
        ) &&
        ["authoritative", "verified-derived"].includes(storedNode.trust_class)
      ) {
        for (const prior of existing.values()) {
          if (
            prior.logical_id !== storedNode.logical_id ||
            prior.version_id === storedNode.version_id
          )
            continue;
          if (
            !decisions.some(
              (item) => item.candidate_id === prior.version_id && item.decision === "superseded",
            )
          ) {
            const recordedAt = storedNode.transaction_time;
            decisions.push({
              schema_version: "1.0.0",
              decision_id: sha256(`${prior.version_id}\0superseded\0${storedNode.version_id}`),
              candidate_id: prior.version_id,
              decision: "superseded",
              actor: GRAPH_PROJECTOR,
              rationale: `superseded by ${storedNode.version_id}`,
              source_ref: storedNode.source_ref,
              source_digest: storedNode.source_digest,
              recorded_at: recordedAt,
            });
          }
        }
        existing.set(storedNode.version_id, storedNode);
      } else if (storedNode.trust_class === "model-proposed")
        candidates.set(storedNode.version_id, {
          ...storedNode,
          trust_class: "untrusted",
        });
    }
    atomicWrite(
      paths.facts,
      jsonl([...existing.values()].sort((a, b) => a.version_id.localeCompare(b.version_id))),
    );
    atomicWrite(
      paths.candidates,
      jsonl([...candidates.values()].sort((a, b) => a.version_id.localeCompare(b.version_id))),
    );
    atomicWrite(
      paths.decisions,
      jsonl(
        decisions
          .map((decision) => {
            if (!graphContractValidators().decision(decision))
              throw new Error("graph memory decision does not satisfy its contract");
            return decision;
          })
          .sort(
            (a, b) =>
              a.recorded_at.localeCompare(b.recorded_at) ||
              a.decision_id.localeCompare(b.decision_id),
          ),
      ),
    );
    return memoryStatus(projectRoot);
  });
}

export function memoryStatus(projectRoot) {
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  const facts = readJsonl(paths.facts);
  const candidates = readJsonl(paths.candidates);
  const decisions = readJsonl(paths.decisions);
  const decided = new Set(decisions.map((item) => item.candidate_id));
  const staleFacts = facts.filter((item) => !memorySourceCurrent(paths, item)).length;
  const superseded = new Set(
    decisions
      .filter((item) => ["superseded", "invalidated", "rejected"].includes(item.decision))
      .map((item) => item.candidate_id),
  );
  const currentFacts = facts.filter(
    (item) => memorySourceCurrent(paths, item) && !superseded.has(item.version_id),
  );
  const logicalCounts = new Map();
  for (const item of currentFacts)
    logicalCounts.set(item.logical_id, (logicalCounts.get(item.logical_id) ?? 0) + 1);
  return {
    repository_id: paths.repositoryId,
    facts: facts.length,
    candidates: candidates.length,
    pending_candidates: candidates.filter((item) => !decided.has(item.version_id)).length,
    decisions: decisions.length,
    stale_facts: staleFacts,
    unresolved_conflicts: [...logicalCounts.values()].filter((count) => count > 1).length,
    memory_dir: paths.root,
  };
}

export function listMemory({ projectRoot, status = "all" }) {
  const paths = memoryPaths(projectRoot);
  const facts = readJsonl(paths.facts);
  const candidates = readJsonl(paths.candidates);
  const decisions = readJsonl(paths.decisions);
  if (status === "facts") return { status: memoryStatus(projectRoot), records: facts, decisions };
  if (status === "candidates")
    return { status: memoryStatus(projectRoot), records: candidates, decisions };
  return { status: memoryStatus(projectRoot), facts, candidates, decisions };
}

export function decideMemory({ projectRoot, candidateId, decision, actor, rationale, sourceRef }) {
  for (const [label, value] of Object.entries({ candidateId, actor, rationale, sourceRef }))
    if (!value) throw new Error(`memory ${decision} requires ${label}`);
  const paths = memoryPaths(projectRoot);
  if (isAbsolute(sourceRef) || sourceRef.includes("\0"))
    throw new Error("corroborating source must be repository-relative");
  const absolute = resolve(projectRoot, sourceRef);
  if (!safeRegularFile(absolute, projectRoot) || credentialLike(sourceRef))
    throw new Error("corroborating source must be a safe repository-relative regular file");
  return withMemoryLock(paths, () => {
    const candidate = readJsonl(paths.candidates).find((item) => item.version_id === candidateId);
    if (!candidate) throw new Error(`memory candidate not found: ${candidateId}`);
    const recordedAt = new Date().toISOString();
    const record = {
      schema_version: "1.0.0",
      decision_id: sha256(`${candidateId}\0${decision}\0${actor}\0${recordedAt}`),
      candidate_id: candidateId,
      decision,
      actor,
      rationale,
      source_ref: sourceRef,
      source_digest: sha256(readFileSync(absolute)),
      recorded_at: recordedAt,
    };
    if (!graphContractValidators().decision(record))
      throw new Error("graph memory decision does not satisfy its contract");
    appendJsonl(paths.decisions, record);
    if (decision === "promoted") {
      const facts = new Map(readJsonl(paths.facts).map((item) => [item.version_id, item]));
      const promotedVersion = sha256(
        `${candidate.kind}\0${candidate.logical_id}\0${record.source_digest}`,
      );
      facts.set(promotedVersion, {
        ...candidate,
        version_id: promotedVersion,
        trust_class: "verified-derived",
        source_ref: sourceRef,
        source_digest: record.source_digest,
        transaction_time: recordedAt,
        valid_from: recordedAt,
        valid_to: null,
      });
      atomicWrite(
        paths.facts,
        jsonl([...facts.values()].sort((a, b) => a.version_id.localeCompare(b.version_id))),
      );
    }
    return record;
  });
}

export function rebuildMemory({ projectRoot, runId }) {
  const paths = memoryPaths(projectRoot);
  return withMemoryLock(paths, () => {
    atomicWrite(paths.facts, "");
    atomicWrite(paths.candidates, "");
    return { rebuilt: true, run_id: runId ?? null };
  });
}

export function retrieveMemoryContext({ projectRoot, seed, limit = 50 }) {
  const paths = { ...memoryPaths(projectRoot), projectRoot };
  const decisions = readJsonl(paths.decisions);
  const rejected = new Set(
    decisions.filter((item) => item.decision === "rejected").map((item) => item.candidate_id),
  );
  const superseded = new Set(
    decisions
      .filter((item) => ["superseded", "invalidated"].includes(item.decision))
      .map((item) => item.candidate_id),
  );
  const queryTokens = tokens(seed);
  return readJsonl(paths.facts)
    .filter(
      (item) =>
        item.repository_id === paths.repositoryId &&
        !rejected.has(item.version_id) &&
        !superseded.has(item.version_id) &&
        memorySourceCurrent(paths, item) &&
        ["authoritative", "verified-derived"].includes(item.trust_class),
    )
    .map((item) => ({
      item,
      score: [...queryTokens].filter((token) =>
        tokens(`${item.logical_id} ${canonicalJson(item.attributes)}`).has(token),
      ).length,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.logical_id.localeCompare(b.item.logical_id))
    .slice(0, Math.min(limit, 200))
    .map(({ item }) => ({
      logical_id: item.logical_id,
      kind: item.kind,
      trust_class: item.trust_class,
      source_ref: item.source_ref,
      source_digest: item.source_digest,
      attributes: item.attributes,
    }));
}
