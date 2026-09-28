/** Projects repository source files and references into graph records. */
import { dirname, extname, relative, resolve } from "node:path";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  GRAPH_LIMITS,
  addEdge,
  addNode,
  credentialLike,
  readJson,
  runGit,
  safeRegularFile,
  sourceDigest,
} from "./core.mjs";

export function trackedFiles(root, planOwned = []) {
  const paths = indexedPaths(root);
  addPlanOwnedChanges(root, paths, planOwned);
  return [...paths].sort().filter((path) => graphFileEligible(root, path));
}

function indexedPaths(root) {
  const paths = new Set();
  for (const row of runGit(root, ["ls-files", "-s", "-z"]).split("\0").filter(Boolean)) {
    const path = indexedPath(row);
    if (path) paths.add(path);
  }
  return paths;
}

function indexedPath(row) {
  const match = row.match(/^(\d+) [a-f0-9]+ \d+\t(.+)$/);
  return match && match[1] !== "160000" ? match[2] : null;
}

function addPlanOwnedChanges(root, paths, planOwned) {
  const command = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  for (const row of runGit(root, command).split("\0").filter(Boolean)) {
    const path = changedPath(row);
    if (planOwnsPath(planOwned, path)) paths.add(path);
  }
}

function changedPath(row) {
  const path = row.slice(3);
  return path.includes(" -> ") ? path.split(" -> ").at(-1) : path;
}

function planOwnsPath(planOwned, candidate) {
  return planOwned.some(
    (owned) =>
      owned === candidate || (owned.endsWith("/**") && candidate.startsWith(owned.slice(0, -2))),
  );
}

function graphFileEligible(root, path) {
  if (credentialLike(path) || path.startsWith(".pipeline/")) return false;
  const absolute = resolve(root, path);
  if (!safeRegularFile(absolute, root)) return false;
  if (lstatSync(absolute).size > GRAPH_LIMITS.maxFileBytes) return false;
  return !readFileSync(absolute).subarray(0, 8192).includes(0);
}

export function planOwnedPaths(runDir) {
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
  const parsed = parsePythonImports(root, pythonFiles);
  return pythonReferenceMap(parsed, fileSet);
}

function parsePythonImports(root, pythonFiles) {
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
  return JSON.parse(proc.stdout || "{}");
}

function pythonReferenceMap(parsed, fileSet) {
  const output = new Map();
  for (const [path, modules] of Object.entries(parsed)) {
    const refs = modules.flatMap((module) => pythonModuleCandidates(path, module));
    output.set(
      path,
      [...new Set(refs)].filter((candidate) => fileSet.has(candidate) && candidate !== path).sort(),
    );
  }
  return output;
}

function pythonModuleCandidates(path, module) {
  const bare = module.replace(/^\.+/, "").replaceAll(".", "/");
  return [
    `${bare}.py`,
    `${bare}/__init__.py`,
    `${dirname(path)}/${bare}.py`,
    `${dirname(path)}/${bare}/__init__.py`,
  ].map((candidate) => (candidate.startsWith("./") ? candidate.slice(2) : candidate));
}

export function projectRepository(graph, root, source, files, snapshotId) {
  const { repoNode, snapshotNode } = projectRepositoryNodes(graph, source, snapshotId);
  const fileSet = new Set(files);
  const pythonRefs = pythonImportReferences(
    root,
    files.filter((path) => extname(path) === ".py"),
    fileSet,
  );
  for (const path of files)
    projectRepositoryFile(graph, root, source, snapshotNode, path, fileSet, pythonRefs);
  return { repoNode, snapshotNode };
}

function projectRepositoryNodes(graph, source, snapshotId) {
  const repoNode = addNode(graph, repositoryNode(source));
  const snapshotNode = addNode(graph, snapshotGraphNode(source, snapshotId));
  addRepositoryContainment(graph, source, repoNode, snapshotNode);
  return { repoNode, snapshotNode };
}

function repositoryNode(source) {
  return {
    ...source,
    family: "repository",
    trust: "authoritative",
    kind: "Repository",
    id: source.repositoryId,
    attributes: { identity: source.repositoryId },
  };
}

function snapshotGraphNode(source, snapshotId) {
  return {
    ...source,
    family: "repository",
    trust: "authoritative",
    kind: "ProjectSnapshot",
    id: snapshotId,
    attributes: { snapshot_id: snapshotId },
  };
}

function addRepositoryContainment(graph, source, from, to) {
  addEdge(graph, {
    ...source,
    family: "repository",
    trust: "verified-derived",
    kind: "CONTAINS",
    from,
    to,
  });
}

function projectRepositoryFile(graph, root, source, snapshotNode, path, fileSet, pythonRefs) {
  const fileSource = { ...source, sourceRef: path, sourceHash: sourceDigest(root, path) };
  const node = addNode(graph, fileGraphNode(root, path, fileSource));
  addRepositoryContainment(graph, fileSource, snapshotNode, node);
  addFileReferenceEdges(graph, root, path, fileSource, node, fileSet, pythonRefs);
}

function fileGraphNode(root, path, source) {
  return {
    ...source,
    family: "repository",
    trust: "authoritative",
    kind: "File",
    id: path,
    attributes: {
      path,
      bytes: lstatSync(resolve(root, path)).size,
      language: extname(path).slice(1) || "unknown",
    },
  };
}

function addFileReferenceEdges(graph, root, path, source, node, fileSet, pythonRefs) {
  const text = readFileSync(resolve(root, path), "utf8");
  const refs = new Set([
    ...literalReferences(path, text, fileSet),
    ...(pythonRefs.get(path) ?? []),
  ]);
  for (const target of [...refs].sort()) addReferenceEdge(graph, path, source, node, target);
}

function addReferenceEdge(graph, path, source, from, target) {
  addEdge(graph, {
    ...source,
    family: "repository",
    trust: "verified-derived",
    kind: "REFERENCES",
    from,
    to: `File:${target}`,
    attributes: { extractor: extname(path) === ".py" ? "literal-or-python-ast" : "literal" },
  });
}
