#!/usr/bin/env node
/** Disposable Git interposer switches HEAD at a ref-transaction boundary. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const realGit = process.env.RAE_TEST_REAL_GIT;
const marker = process.env.RAE_TEST_REF_MARKER;
if (!realGit || !marker)
  throw new Error("Git interposer requires explicit disposable fixture configuration");
const args = process.argv.slice(2);
let input: Buffer | undefined;
if (args.includes("update-ref") && args.includes("--stdin")) {
  input = readFileSync(0);
  const count = input.includes(Buffer.from("\nabort\n"))
    ? 0
    : existsSync(marker)
      ? Number(readFileSync(marker, "utf8")) + 1
      : 1;
  if (count) writeFileSync(marker, String(count));
  if (count === Number(process.env.RAE_TEST_SWITCH_AT)) {
    const changed = spawnSync(
      realGit,
      ["-C", args[1], "symbolic-ref", "HEAD", "refs/heads/other"],
      { stdio: "inherit" },
    );
    if (changed.status !== 0) process.exit(changed.status ?? 1);
  }
}
if (process.env.RAE_TEST_DISABLE_HOOKS === "1") {
  const hooks = args.findIndex((value) => value.startsWith("core.hooksPath="));
  if (hooks >= 0) args[hooks] = `core.hooksPath=${dirname(marker)}`;
}
const child = spawnSync(realGit, args, {
  input,
  stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
