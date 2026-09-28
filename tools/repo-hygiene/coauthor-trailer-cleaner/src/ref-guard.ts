#!/usr/bin/env node
/** Refuse prepared Git ref transactions unless their locks protect the captured HEAD attachment. */
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function regularFile(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw new Error("Expected a regular Git ref file");
  }
  return descriptor;
}
try {
  const phase = process.argv[2];
  if (!["prepared", "committed", "aborted"].includes(phase ?? ""))
    throw new Error("Unknown reference-transaction phase");
  const input = readFileSync(0);
  if (phase === "prepared") {
    const headPath = process.env.RAE_HISTORY_HEAD_PATH,
      branch = process.env.RAE_HISTORY_BRANCH;
    if (!headPath || !branch?.startsWith("refs/heads/"))
      throw new Error("Missing captured Git attachment");
    const head = regularFile(headPath);
    try {
      // Git holds HEAD.lock while prepared only when this branch was resolved
      // as current. This rejects switch-away/switch-back races as well.
      const lock = regularFile(`${headPath}.lock`);
      try {
        if (!readFileSync(head).equals(Buffer.from(`ref: ${branch}\n`)))
          throw new Error("Git HEAD attachment changed");
      } finally {
        closeSync(lock);
      }
    } finally {
      closeSync(head);
    }
  }
  if (phase === "prepared") {
    const receipt = process.env.RAE_HISTORY_PREPARED_RECEIPT;
    if (!receipt) throw new Error("Missing guard capability receipt");
    writeFileSync(receipt, "prepared\n", { mode: 0o600 });
  }
  const original = process.env.RAE_HISTORY_REFERENCE_HOOK;
  if (original) {
    const child = spawnSync(original, [phase ?? ""], {
      input,
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  }
} catch (error) {
  console.error(`History ref guard: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
