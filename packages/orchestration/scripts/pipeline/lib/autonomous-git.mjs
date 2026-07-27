/** Git and runtime-namespace invariants for autonomous workflow execution. */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PHASE_ORDER } from "../../lib/constants.mjs";

export function requireDirectory(pathValue, label) {
  const resolvedPath = realpathSync(resolve(pathValue));
  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`${label} is not a directory: ${pathValue}`);
  }
  return resolvedPath;
}

export function runProcess(command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  assertProcessStarted(proc, command, options);
  assertProcessSucceeded(proc, command, options);
  return proc;
}

export function assertProcessStarted(proc, command, options) {
  if (proc.error) throw new Error(`${options.label ?? command} failed to start: ${proc.error.message}`);
}

export function assertProcessSucceeded(proc, command, options) {
  if (proc.status === 0 || options.allowFailure) return;
  const detail = `${proc.stderr ?? ""}\n${proc.stdout ?? ""}`.trim().slice(-4000);
  throw new Error(`${options.label ?? command} exited with status ${proc.status}: ${detail}`);
}

export function gitOutput(root, args) {
  return runProcess("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
    label: `git ${args.join(" ")}`,
  }).stdout;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertGitRepository(root) {
  const topLevel = gitOutput(root, ["rev-parse", "--show-toplevel"]).trim();
  if (realpathSync(topLevel) !== realpathSync(root)) {
    throw new Error(`project root must be the Git top-level directory: ${topLevel}`);
  }
}

export function reflogDigest(root, ref) {
  const output = gitOutput(root, [
    "reflog",
    "show",
    "--no-abbrev",
    "--format=%H%x00%gD%x00%gs",
    ref,
  ]);
  if (!output) {
    throw new Error(
      `Git reflog is required for autonomous safety checks but is unavailable for ${ref}`,
    );
  }
  return sha256(output);
}

export function indexDigests(root) {
  return Object.fromEntries(
    [
      ["entries", ["ls-files", "-s", "-z"]],
      ["skip_worktree", ["ls-files", "-t", "-z"]],
      ["assume_unchanged", ["ls-files", "-v", "-z"]],
    ].map(([name, args]) => [name, sha256(gitOutput(root, args))]),
  );
}

export function configDigest(root, scope) {
  const proc = runProcess("git", ["-C", root, "config", `--${scope}`, "--null", "--list"], {
    label: `git config --${scope} --list`,
    allowFailure: true,
  });
  if (proc.status === 0) return sha256(proc.stdout);
  if (scope === "worktree" && proc.status === 128) return "worktree-config-unavailable";
  throw new Error(`could not inspect ${scope} Git configuration: ${proc.stderr.trim()}`);
}

export function refsSnapshot(root) {
  const output = gitOutput(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
  ]);
  const sensitive = output
    .split("\n")
    .filter((line) => /^(refs\/(replace|bisect|rewritten|worktree)\/)/.test(line.split("\0", 1)[0]))
    .sort()
    .join("\n");
  return { all: sha256(output), sensitive: sha256(sensitive) };
}

export function gitInfoEntrySnapshot(root, name) {
  const pathValue = gitOutput(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    `info/${name}`,
  ]).trim();
  let entry;
  try {
    entry = lstatSync(pathValue);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
  if (entry.isSymbolicLink()) {
    return `symlink:${entry.mode}:${readlinkSync(pathValue)}`;
  }
  if (!entry.isFile()) return `special:${entry.mode}`;
  return `file:${entry.mode}:${sha256(readFileSync(pathValue))}`;
}

export function gitPrivateInfoSnapshot(root) {
  return {
    exclude: gitInfoEntrySnapshot(root, "exclude"),
    attributes: gitInfoEntrySnapshot(root, "attributes"),
  };
}

export function gitStateSnapshot(root) {
  const topLevel = realpathSync(gitOutput(root, ["rev-parse", "--show-toplevel"]).trim());
  const gitDirectory = realpathSync(gitOutput(root, ["rev-parse", "--absolute-git-dir"]).trim());
  const symbolicHead = runProcess("git", ["-C", root, "symbolic-ref", "-q", "HEAD"], {
    label: "git symbolic-ref -q HEAD",
    allowFailure: true,
  });
  if (symbolicHead.status !== 0 && symbolicHead.status !== 1) {
    throw new Error(`could not determine Git HEAD state: ${symbolicHead.stderr.trim()}`);
  }
  const headRef = symbolicHead.status === 0 ? symbolicHead.stdout.trim() : null;
  return {
    schema_version: "1.4.0",
    top_level: topLevel,
    git_directory: gitDirectory,
    head_ref: headRef,
    head_commit: gitOutput(root, ["rev-parse", "HEAD"]).trim(),
    head_reflog: reflogDigest(root, "HEAD"),
    branch_reflog: headRef ? reflogDigest(root, headRef) : null,
    index: indexDigests(root),
    refs: refsSnapshot(root),
    repository_config: {
      local: configDigest(root, "local"),
      worktree: configDigest(root, "worktree"),
    },
    private_info: gitPrivateInfoSnapshot(root),
  };
}

export function gitStateDifferences(baseline, current) {
  return [
    ["top_level", "Git top-level identity changed; repository ownership is no longer trustworthy"],
    ["git_directory", "Git directory identity changed; repository ownership is no longer trustworthy"],
    ["head_commit", `HEAD commit changed from ${baseline.head_commit} to ${current.head_commit}`],
    ["head_reflog", "worktree HEAD reflog changed; a checkout, commit, or reset occurred"],
    ["branch_reflog", "current branch reflog changed; the run branch moved"],
    ["index", "Git index state changed; this can conceal tracked changes from ownership checks"],
    ["refs", "Git refs changed outside the run-owned HEAD transition"],
    ["repository_config", "Git local or worktree configuration changed"],
    ["private_info", "Git private exclude or attributes state changed"],
  ].flatMap(([key, message]) => JSON.stringify(baseline[key]) === JSON.stringify(current[key]) ? [] : [message]);
}

export function changedGitState(baseline, current) {
  if (baseline.schema_version !== current.schema_version) {
    return ["Git-state snapshot schema changed; start a new autonomous run"];
  }
  if (baseline.head_ref !== current.head_ref) {
    return [
      `HEAD ref changed from ${baseline.head_ref ?? "detached"} to ${current.head_ref ?? "detached"}`,
      ...gitStateDifferences(baseline, current),
    ];
  }
  return gitStateDifferences(baseline, current);
}

/**
 * Fails the workflow when an in-place phase changes Git state outside its explicitly allowed transition.
 */
export function assertGitStateInvariant(root, baseline, phase) {
  const changes = changedGitState(baseline, gitStateSnapshot(root));
  if (changes.length > 0) {
    throw new Error(
      `prohibited Git-state change after ${phase}: ${changes.join("; ")}. ` +
        "Agents must leave run-owned HEAD/current-branch state, remotes, and index visibility unchanged.",
    );
  }
}

export function refreshResumeRefBaseline(root, baseline) {
  const current = gitStateSnapshot(root);
  const changes = changedGitState(baseline, current);
  const ordinarySharedRefChange =
    baseline.refs?.sensitive === current.refs?.sensitive &&
    changes.includes("Git refs changed outside the run-owned HEAD transition");
  const blocking = changes.filter(
    (change) =>
      change !== "Git refs changed outside the run-owned HEAD transition" ||
      !ordinarySharedRefChange,
  );
  if (blocking.length > 0) {
    throw new Error(
      `prohibited Git-state change after resume preflight: ${blocking.join("; ")}. ` +
        "Agents must leave run-owned HEAD/current-branch state, remotes, sensitive refs, and index visibility unchanged.",
    );
  }
  baseline.refs = current.refs;
}

export function splitNullList(value) {
  return value.split("\0").filter(Boolean);
}

export function untrackedPaths(root) {
  const entries = splitNullList(
    gitOutput(root, [
      "ls-files",
      "--others",
      "--directory",
      "--no-empty-directory",
      "--exclude=/.pipeline/",
      "-z",
      "--",
    ]),
  );
  const paths = [];
  for (const entry of entries) {
    if (entry === ".pipeline/" || entry.startsWith(".pipeline/")) continue;
    if (!entry.endsWith("/")) {
      paths.push(entry);
      continue;
    }
    paths.push(...splitNullList(gitOutput(root, ["ls-files", "--others", "-z", "--", entry])));
  }
  return paths;
}

export function changedPaths(root) {
  const paths = new Set([
    ...splitNullList(gitOutput(root, ["diff", "--name-only", "-z", "--relative"])),
    ...splitNullList(gitOutput(root, ["diff", "--cached", "--name-only", "-z", "--relative"])),
    // Do not consult .gitignore, $GIT_DIR/info/exclude, or global excludes here:
    // ownership checks must discover every untracked path an agent could hide with mutable Git state.
    // Collapse wholly untracked directories first. The sole fixed exclude prunes the runtime-owned
    // .pipeline subtree; that namespace is independently covered by its tamper snapshot.
    ...untrackedPaths(root),
  ]);
  return [...paths]
    .filter((pathValue) => pathValue !== ".pipeline" && !pathValue.startsWith(".pipeline/"))
    .sort();
}

export function runtimeNamespaceSnapshot(workspaceRoot, ignoredRefs = []) {
  const pipelineRoot = resolve(workspaceRoot, ".pipeline");
  const ignored = new Set(ignoredRefs);
  const snapshot = new Map();
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathValue = resolve(directory, entry.name);
      const ref = relative(pipelineRoot, pathValue);
      if (ignored.has(ref)) continue;
      let stat;
      try {
        stat = lstatSync(pathValue);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (entry.isDirectory()) {
        snapshot.set(ref, `directory:${stat.mode}`);
        visit(pathValue);
      } else if (entry.isFile()) {
        snapshot.set(
          ref,
          `file:${stat.mode}:${createHash("sha256").update(readFileSync(pathValue)).digest("hex")}`,
        );
      } else if (entry.isSymbolicLink()) {
        snapshot.set(ref, `symlink:${stat.mode}:${readlinkSync(pathValue)}`);
      } else {
        snapshot.set(ref, `special:${stat.mode}`);
      }
    }
  };
  visit(pipelineRoot);
  return snapshot;
}

export function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateConcurrentOperatorChanges({
  beforeControl,
  afterControl,
  beforeTrace,
  afterTrace,
  runId,
  expectedPhase = null,
}) {
  validateConcurrentControl(beforeControl, afterControl, runId);
  if (beforeTrace === afterTrace) return;
  if (afterControl.status !== "stop-requested" || afterControl.stop_requested !== true) {
    throw new Error("provider or concurrent process appended a stop trace without stop control");
  }
  if (!afterTrace.startsWith(beforeTrace)) {
    throw new Error("provider or concurrent process rewrote protected trace history");
  }
  afterTrace.slice(beforeTrace.length).split("\n").map((line) => line.trim()).filter(Boolean)
    .forEach((line) => validateConcurrentTraceEvent(line, runId, expectedPhase));
}

export function validateConcurrentControl(beforeControl, afterControl, runId) {
  if (sameJson(beforeControl, afterControl)) return;
  const mutable = new Set(["status", "stop_requested", "stop_requested_at", "updated_at"]);
  const unexpected = Object.keys(afterControl).some((key) => !Object.hasOwn(beforeControl, key) && !mutable.has(key));
  const stableChanged = Object.keys(beforeControl).some((key) => !mutable.has(key) && !sameJson(beforeControl[key], afterControl[key]));
  const invalidTimestamp =
    typeof afterControl.stop_requested_at !== "string" ||
    !Number.isFinite(Date.parse(afterControl.stop_requested_at)) ||
    typeof afterControl.updated_at !== "string" ||
    !Number.isFinite(Date.parse(afterControl.updated_at));
  if (afterControl.run_id !== runId || afterControl.status !== "stop-requested" || afterControl.stop_requested !== true || invalidTimestamp || unexpected || stableChanged) {
    throw new Error("provider or concurrent process made an invalid operator-control transition");
  }
}

export function validateConcurrentTraceEvent(line, runId, expectedPhase = null) {
  let event;
  try { event = JSON.parse(line); } catch { throw new Error("provider or concurrent process appended invalid trace JSON"); }
  const expectedKeys = ["event", "phase", "run_id", "status", "ts"];
  if (JSON.stringify(Object.keys(event).sort()) !== JSON.stringify(expectedKeys) || event.event !== "run_stop_requested" || event.run_id !== runId || event.status !== "ok" || !PHASE_ORDER.includes(event.phase) || (expectedPhase && event.phase !== expectedPhase) || typeof event.ts !== "string" || !Number.isFinite(Date.parse(event.ts))) {
    throw new Error("provider or concurrent process appended a non-stop operator trace event");
  }
}

export function assertRuntimeNamespaceInvariant(before, workspaceRoot, allowedChanges = []) {
  const after = runtimeNamespaceSnapshot(workspaceRoot, allowedChanges);
  const allowed = new Set(allowedChanges);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter((ref) => !allowed.has(ref) && before.get(ref) !== after.get(ref))
    .sort();
  if (changed.length > 0) {
    throw new Error(
      `provider modified protected .pipeline state: ${changed.slice(0, 8).join(", ")}`,
    );
  }
}
