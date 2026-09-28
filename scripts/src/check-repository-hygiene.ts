#!/usr/bin/env node
/** Reject tracked editor residue while keeping local ignored work outside the gate. */
import { pathToFileURL } from "node:url";
import { repositoryFiles } from "./repository-files.js";
export function repositoryResidue(files: readonly string[]): string[] {
  return files.filter((file) =>
    /(^|\/)(\.DS_Store|Thumbs\.db|.*\.swp|.*\.swo|.*\.tmp|.*\.bak|.*\.orig)$/.test(file),
  );
}
export function checkRepositoryHygiene(): void {
  const residue = repositoryResidue(repositoryFiles(true));
  if (residue.length) throw new Error(`Tracked local-junk files detected:\n${residue.join("\n")}`);
  console.log("Repository hygiene checks passed");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkRepositoryHygiene();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
