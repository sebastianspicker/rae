/** Keep local analyzer report creation and reads inside descriptor-anchored directories. */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { openRoot, openDirectoryAt, openFileAt, renameAt, unlinkAt } from "@rae/fs-bridge";
import { repositoryRoot } from "./repository-files.js";
type Area = "tmp" | "reports";
function withDirectory<T>(area: Area, operation: (fd: number) => T): T {
  const fds: number[] = [];
  try {
    let fd = openRoot(fs.realpathSync(repositoryRoot));
    fds.push(fd);
    for (const segment of [".codacy", area]) {
      fd = openDirectoryAt(fd, segment, true);
      fds.push(fd);
      const stat = fs.fstatSync(fd);
      if (stat.uid !== process.getuid?.() || stat.mode & 0o022)
        throw new Error(
          "Analyzer report directories must be owned and not writable by other users",
        );
    }
    return operation(fd);
  } finally {
    for (const fd of fds.reverse()) fs.closeSync(fd);
  }
}
export function writeQualityFile(area: Area, name: string, content: string): void {
  withDirectory(area, (fd) => {
    const temporary = `.${randomUUID()}.tmp`;
    const output = openFileAt(fd, temporary, "create");
    let staged = true;
    try {
      try {
        fs.writeFileSync(output, content);
        fs.fsyncSync(output);
      } finally {
        fs.closeSync(output);
      }
      renameAt(fd, temporary, fd, name, false);
      staged = false;
    } finally {
      if (staged) unlinkAt(fd, temporary);
    }
  });
}
export function readQualityJson(area: Area, name: string): unknown {
  return withDirectory(area, (fd) => {
    const input = openFileAt(fd, name);
    try {
      const stat = fs.fstatSync(input);
      const limit = 64 * 1024 * 1024;
      if (
        !stat.isFile() ||
        stat.size > limit ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error("Analyzer report must be a private bounded regular file");
      const bytes = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(input, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      const after = fs.fstatSync(input);
      if (
        count !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("Analyzer report changed while reading");
      return JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, count)),
      ) as unknown;
    } finally {
      fs.closeSync(input);
    }
  });
}
