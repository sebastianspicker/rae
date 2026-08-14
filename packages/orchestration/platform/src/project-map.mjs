/** Purpose: map hosted logical project IDs to private canonical local roots and profiles. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";

const MAX_MAP_BYTES = 64 * 1024;

/** Validates the immutable file descriptor used for the private project map. */
export function validateProjectMapFileStat(stat) {
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_MAP_BYTES
  ) {
    throw new Error("project map must be a private owner-only regular file");
  }
}

/** Rejects a project-map file that changed between descriptor checks. */
export function assertStableProjectMapDescriptor(before, after) {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error("project map changed while it was read");
  }
}

/** Validates one untrusted TOML descriptor before resolving it on the worker. */
export function validateProjectMapEntry(projectId, value) {
  if (
    !/^[A-Za-z0-9._-]{1,128}$/.test(projectId) ||
    !value ||
    typeof value !== "object" ||
    typeof value.root !== "string" ||
    typeof value.profile !== "string" ||
    !path.isAbsolute(value.root) ||
    !path.isAbsolute(value.profile)
  ) {
    throw new Error(`invalid project map entry: ${projectId}`);
  }
  return { root: value.root, profile: value.profile };
}

function canonicalGitRoot(projectId, rootPath) {
  const root = fs.realpathSync(rootPath);
  const probe = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (probe.status !== 0 || fs.realpathSync(probe.stdout.trim()) !== root) {
    throw new Error(`project ${projectId} root must be a canonical Git top level`);
  }
  return root;
}

export function loadProjectMap(filePath) {
  if (!path.isAbsolute(filePath || "")) throw new Error("RAE_PROJECT_MAP_FILE must be absolute");
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    validateProjectMapFileStat(before);
    const source = fs.readFileSync(descriptor, "utf8");
    const after = fs.fstatSync(descriptor);
    assertStableProjectMapDescriptor(before, after);
    const parsed = parseToml(source);
    if (!parsed.projects || typeof parsed.projects !== "object" || Array.isArray(parsed.projects))
      throw new Error("project map must define [projects.<id>] entries");
    const projects = new Map();
    for (const [projectId, value] of Object.entries(parsed.projects)) {
      const entry = validateProjectMapEntry(projectId, value);
      const root = canonicalGitRoot(projectId, entry.root);
      projects.set(projectId, Object.freeze({ root, profile: path.resolve(entry.profile) }));
    }
    return projects;
  } finally {
    fs.closeSync(descriptor);
  }
}
