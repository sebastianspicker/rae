#!/usr/bin/env node
/** Provision checksum-pinned native Linux analyzers without interpreter runtimes. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { openRoot, openDirectoryAt, openFileAt, renameAt, unlinkAt } from "@rae/fs-bridge";
interface Download {
  tool: string;
  executable: string;
  version: string;
  sha256: string;
  url: string;
  archive?: boolean;
}
export const ANALYZERS: readonly Download[] = [
  {
    tool: "Hadolint",
    executable: "hadolint",
    version: "2.14.0",
    sha256: "6bf226944684f56c84dd014e8b979d27425c0148f61b3bd99bcc6f39e9dc5a47",
    url: "https://github.com/hadolint/hadolint/releases/download/v2.14.0/hadolint-linux-x86_64",
  },
  {
    tool: "Trivy",
    executable: "trivy",
    version: "0.72.0",
    sha256: "bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea",
    url: "https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_Linux-64bit.tar.gz",
    archive: true,
  },
  {
    tool: "Semgrep",
    executable: "opengrep",
    version: "1.25.0",
    sha256: "9ac4aebb47ba3f7b0d8fc641ac8749cb6c2f253f616131a67d9631e00d4bea33",
    url: "https://github.com/opengrep/opengrep/releases/download/v1.25.0/opengrep_manylinux_x86",
  },
];
async function downloadPinned(spec: Download, destination: string): Promise<void> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 120_000);
  const fd = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const response = await fetch(spec.url, { signal: controller.signal });
    if (!response.ok || !response.body || new URL(response.url).protocol !== "https:")
      throw new Error(`${spec.tool} download failed`);
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > 512 * 1024 * 1024) throw new Error(`${spec.tool} download exceeds byte limit`);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength)
        offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset);
    }
    if (hash.digest("hex") !== spec.sha256) throw new Error(`${spec.tool} checksum mismatch`);
    fs.fsyncSync(fd);
  } finally {
    controller.abort();
    clearTimeout(deadline);
    fs.closeSync(fd);
  }
}
function requireSuccess(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
  return capture ? `${result.stdout}${result.stderr}` : "";
}
function installVerified(source: string, spec: Download): string {
  const descriptors: number[] = [];
  const home = fs.realpathSync(homedir());
  const temporary = `.${spec.executable}-${randomUUID()}`;
  let staged = false;
  let destinationFd: number | undefined;
  try {
    let fd = openRoot(home);
    descriptors.push(fd);
    for (const segment of [".codacy", "tools", spec.tool]) {
      fd = openDirectoryAt(fd, segment, true);
      descriptors.push(fd);
      const stat = fs.fstatSync(fd);
      if (stat.uid !== process.getuid?.() || stat.mode & 0o022)
        throw new Error(
          "Analyzer installation directories must be owned and not writable by other users",
        );
    }
    destinationFd = fd;
    const executableFd = openFileAt(fd, temporary, "create");
    staged = true;
    try {
      fs.writeFileSync(executableFd, fs.readFileSync(source));
      fs.fchmodSync(executableFd, 0o755);
      fs.fsyncSync(executableFd);
    } finally {
      fs.closeSync(executableFd);
    }
    renameAt(fd, temporary, fd, spec.executable, false);
    staged = false;
    fs.fsyncSync(fd);
    return join(home, ".codacy/tools", spec.tool, spec.executable);
  } finally {
    if (staged && destinationFd !== undefined) unlinkAt(destinationFd, temporary);
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
}
export async function provisionAnalyzers(): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(
      `Codacy analyzer provisioning supports Linux x86_64; got ${process.platform} ${process.arch}`,
    );
  const work = fs.mkdtempSync(join(tmpdir(), "rae-codacy-tools-"));
  try {
    for (const spec of ANALYZERS) {
      const archive = join(work, `${spec.executable}.download`);
      await downloadPinned(spec, archive);
      let executable = archive;
      if (spec.archive) {
        // The authenticated archive is extracted in a new private directory; only this member is selected.
        const extract = join(work, `${spec.executable}-extract`);
        fs.mkdirSync(extract, { mode: 0o700 });
        requireSuccess("tar", ["-xzf", archive, "-C", extract, spec.executable]);
        executable = join(extract, spec.executable);
        if (!fs.lstatSync(executable).isFile())
          throw new Error("Analyzer archive member must be a regular file");
      }
      const installed = installVerified(executable, spec);
      if (
        requireSuccess(installed, ["--version"], true).match(/\d+\.\d+\.\d+/)?.[0] !== spec.version
      )
        throw new Error(`${spec.tool} installed version does not match ${spec.version}`);
      console.log(`Provisioned ${spec.tool} ${spec.version}`);
    }
    requireSuccess(join(homedir(), ".codacy/tools/Trivy/trivy"), [
      "image",
      "--cache-dir",
      join(homedir(), ".codacy/cache/trivy"),
      "--download-db-only",
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await provisionAnalyzers();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
