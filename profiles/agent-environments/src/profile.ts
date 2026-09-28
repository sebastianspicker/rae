/** Manifest-v2 installation and restoration preserve existing hashes and recovery receipts. */
import { closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { openRoot } from "@rae/fs-bridge";
import { fileState, openTarget, assertNodeTarget, type FileState } from "./io.js";
import { transact, type Hook, type Mutation } from "./receipts.js";

// Persisted identity stored in every manifest-v2 receipt (`.rae-profile-install.json`).
// This string is not a live file path: it must stay byte-for-byte stable so existing
// receipts remain recoverable even though the referenced installer script is retired.
const manifestInstallerId = "profiles/agent-environments/installers/install-profile.sh";
const manifestPath = ".rae-profile-install.json";
const files = [
  [
    ".codex/config.toml",
    "templates/codex/config.toml",
    ".rae-profile-backups/.codex/config.toml.bak",
  ],
  [
    ".claude/settings.json",
    "templates/claude/settings.json",
    ".rae-profile-backups/.claude/settings.json.bak",
  ],
  [
    "docs/agent-operator-policy.md",
    "shared/policy/operator-policy.md",
    ".rae-profile-backups/docs/agent-operator-policy.md.bak",
  ],
] as const;
interface Entry {
  path: string;
  sha256: string;
  backup_path: string;
  backup_sha256: string;
}
const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...fields].sort().join()
  )
    throw new Error("Invalid profile manifest fields");
  return value as Record<string, unknown>;
}
function parseManifest(data: Buffer): Map<string, Entry> {
  const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)), [
    "manifest_version",
    "installer",
    "installed_files",
  ]);
  if (
    value.manifest_version !== 2 ||
    value.installer !== manifestInstallerId ||
    !Array.isArray(value.installed_files) ||
    value.installed_files.length !== files.length
  )
    throw new Error("Unsupported or invalid profile manifest");
  const expected = new Map<string, string>(files.map(([path, _source, backup]) => [path, backup]));
  const result = new Map<string, Entry>();
  for (const item of value.installed_files) {
    const entry = object(item, ["path", "sha256", "backup_path", "backup_sha256"]);
    const path = entry.path,
      backup = entry.backup_path,
      hash = entry.sha256,
      backupHash = entry.backup_sha256;
    if (
      typeof path !== "string" ||
      !expected.has(path) ||
      result.has(path) ||
      typeof backup !== "string" ||
      (backup !== "" && backup !== expected.get(path))
    )
      throw new Error("Invalid profile manifest path");
    if (
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      typeof backupHash !== "string" ||
      (backup ? !/^[a-f0-9]{64}$/.test(backupHash) : backupHash !== "")
    )
      throw new Error("Invalid profile manifest hash");
    result.set(path, { path, sha256: hash, backup_path: backup, backup_sha256: backupHash });
  }
  return result;
}
function checkedManifest(root: number): Map<string, Entry> | null {
  const manifest = fileState(root, manifestPath);
  if (!manifest.exists) return null;
  const entries = parseManifest(manifest.data);
  for (const [path, entry] of entries) {
    const installed = fileState(root, path);
    if (!installed.exists || digest(installed.data) !== entry.sha256)
      throw new Error(`Installed profile target missing or modified: ${path}`);
    if (entry.backup_path) {
      const backup = fileState(root, entry.backup_path);
      if (!backup.exists || digest(backup.data) !== entry.backup_sha256)
        throw new Error(`Original profile backup hash mismatch: ${entry.backup_path}`);
    }
  }
  return entries;
}
export async function install(
  profileRoot: string,
  target: string,
  force = false,
  hook?: Hook,
): Promise<void> {
  const sourceFd = openRoot(profileRoot);
  const sources = new Map<string, Buffer>();
  try {
    for (const [path, source] of files) {
      const state = fileState(sourceFd, source);
      if (!state.exists) throw new Error(`Missing profile source: ${source}`);
      sources.set(path, state.data);
    }
  } finally {
    closeSync(sourceFd);
  }
  const root = openTarget(target);
  try {
    assertNodeTarget(root);
    const existing = checkedManifest(root);
    const before = new Map<string, FileState>(
      [manifestPath, ...files.flatMap(([path, _source, backup]) => [path, backup])].map((path) => [
        path,
        fileState(root, path),
      ]),
    );
    const state = (path: string): FileState => {
      const result = before.get(path);
      if (!result) throw new Error(`Missing inventory: ${path}`);
      return result;
    };
    if (existing && !force) throw new Error("Profile already installed; use --force to reinstall");
    if (!existing && !force && files.some(([path]) => state(path).exists))
      throw new Error("Refusing overwrite without --force");
    if (!existing && files.some(([_path, _source, backup]) => state(backup).exists))
      throw new Error("Refusing stale profile backup");
    const entries: Entry[] = files.map(([path, _source, backup]) => {
      const payload = sources.get(path);
      if (!payload) throw new Error(`Missing source: ${path}`);
      return {
        path,
        sha256: digest(payload),
        backup_path: existing?.get(path)?.backup_path ?? (state(path).exists ? backup : ""),
        backup_sha256:
          existing?.get(path)?.backup_sha256 ??
          (state(path).exists ? digest(state(path).data) : ""),
      };
    });
    const mutations: Mutation[] = [];
    if (!existing)
      for (const entry of entries)
        if (entry.backup_path)
          mutations.push({
            relative: entry.backup_path,
            expected: state(entry.backup_path),
            replacement: state(entry.path).data,
          });
    for (const [path] of files)
      mutations.push({
        relative: path,
        expected: state(path),
        replacement: sources.get(path) ?? null,
      });
    mutations.push({
      relative: manifestPath,
      expected: state(manifestPath),
      replacement: Buffer.from(
        JSON.stringify(
          { manifest_version: 2, installer: manifestInstallerId, installed_files: entries },
          null,
          2,
        ) +
          "\n",
      ),
    });
    await transact(root, mutations, "install", hook);
  } finally {
    closeSync(root);
  }
}
export async function uninstall(target: string, hook?: Hook): Promise<boolean> {
  const root = openTarget(target);
  try {
    const entries = checkedManifest(root);
    if (!entries) return false;
    const mutations: Mutation[] = [];
    for (const [path, entry] of entries)
      mutations.push({
        relative: path,
        expected: fileState(root, path),
        replacement: entry.backup_path ? fileState(root, entry.backup_path).data : null,
      });
    mutations.push({
      relative: manifestPath,
      expected: fileState(root, manifestPath),
      replacement: null,
    });
    for (const entry of entries.values())
      if (entry.backup_path)
        mutations.push({
          relative: entry.backup_path,
          expected: fileState(root, entry.backup_path),
          replacement: null,
        });
    await transact(root, mutations, "uninstall", hook);
    return true;
  } finally {
    closeSync(root);
  }
}
