#!/usr/bin/env node
/** Remove disposable editor residue using anchored descriptors without following links. */
import { closeSync, fstatSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  openDirectoryAt,
  openLinkedFileAt,
  openRoot,
  readDirectory,
  unlinkAt,
} from "@rae/fs-bridge";
import { repositoryRoot } from "./repository-files.js";
const residue = /^(?:\.DS_Store|Thumbs\.db|.*\.(?:swp|swo|tmp|bak|orig))$/;
function code(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}
export function cleanLocal(rootPath: string): number {
  const root = openRoot(rootPath);
  let removed = 0;
  function clearDirectory(parent: number): void {
    for (const name of readDirectory(parent)) {
      let child: number;
      try {
        child = openDirectoryAt(parent, name);
      } catch (error) {
        if (!["ENOTDIR", "ELOOP"].includes(code(error))) throw error;
        unlinkAt(parent, name);
        continue;
      }
      try {
        clearDirectory(child);
      } finally {
        closeSync(child);
      }
      unlinkAt(parent, name, true);
    }
  }
  function visit(parent: number, prefix: string): void {
    for (const name of readDirectory(parent)) {
      const label = name.toString("utf8");
      if (!prefix && label === ".git") continue;
      let directory: number;
      try {
        directory = openDirectoryAt(parent, name);
      } catch (error) {
        if (!["ENOTDIR", "ELOOP"].includes(code(error))) throw error;
        if (!residue.test(label)) continue;
        let file: number;
        try {
          file = openLinkedFileAt(parent, name);
        } catch (readError) {
          if (code(readError) === "ELOOP") continue;
          throw readError;
        }
        try {
          if (fstatSync(file).isFile()) {
            unlinkAt(parent, name);
            console.log(`removed: ./${prefix}${label}`);
            removed++;
          }
        } finally {
          closeSync(file);
        }
        continue;
      }
      const cache = !prefix && [".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(label);
      try {
        if (cache) clearDirectory(directory);
        else visit(directory, `${prefix}${label}/`);
      } finally {
        closeSync(directory);
      }
      if (cache) {
        unlinkAt(parent, name, true);
        console.log(`removed: ${label}/`);
        removed++;
      }
    }
  }
  try {
    visit(root, "");
  } finally {
    closeSync(root);
  }
  console.log(`cleanup complete: removed ${removed} item(s)`);
  return removed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error("Usage: clean-local");
    cleanLocal(repositoryRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
