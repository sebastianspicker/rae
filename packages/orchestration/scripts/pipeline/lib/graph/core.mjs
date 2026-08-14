/** Builds, validates, queries, and persists RAE's local rebuildable graph projections. */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const GRAPH_PROJECTOR = "rae-local-graph-v1";
export const GRAPH_LIMITS = Object.freeze({
  maxNodes: 250_000,
  maxEdges: 1_000_000,
  maxFileBytes: 1_048_576,
});
export const TRUST = new Set(["authoritative", "verified-derived", "model-proposed", "untrusted"]);
export const EDGE_KINDS = new Set([
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
export const PHASES = [
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
export const PHASE_ARTIFACTS = {
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
const GRAPH_CONTRACT_ROOT = resolve(import.meta.dirname, "../../../../contracts/graph");
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
let contractValidators;

export function graphContractValidators() {
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

export function runGit(root, args, { allowFailure = false } = {}) {
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

export function transactionTime(root, runDir) {
  if (runDir && existsSync(resolve(runDir, "request.json"))) {
    const request = readJson(resolve(runDir, "request.json"));
    if (typeof request.requested_at === "string") return request.requested_at;
  }
  return runGit(root, ["show", "-s", "--format=%cI", "HEAD"]);
}

export function credentialLike(path) {
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

export function contained(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function graphRunPaths(root, runId) {
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

export function safeRegularFile(path, root) {
  try {
    return contained(path, root) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads a bounded regular UTF-8 file without following its final path component. */
export function readUtf8RegularFile(path, maxBytes = 16 * 1024 * 1024) {
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

/** Writes UTF-8 data privately within an existing canonical parent directory. */
export function writePrivateUtf8File(path, body) {
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

/** Resolves a source reference canonically and rejects paths outside the project root. */
export function projectSourcePath(projectRoot, sourcePath) {
  const canonicalRoot = realpathSync(projectRoot);
  const canonicalSource = realpathSync(resolve(canonicalRoot, sourcePath));
  const relation = relative(canonicalRoot, canonicalSource);
  if (relation === ".." || relation.startsWith(`..${sep}`))
    throw new Error(`graph source escapes the project root: ${sourcePath}`);
  return canonicalSource;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function atomicWrite(path, body, mode = 0o600) {
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

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function jsonl(records) {
  return records.map((record) => canonicalJson(record)).join("\n") + (records.length ? "\n" : "");
}

export function sourceDigest(root, ref) {
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

export function addNode(graph, spec) {
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

export function addEdge(graph, spec) {
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
