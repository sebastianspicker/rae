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
