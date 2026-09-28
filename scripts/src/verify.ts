#!/usr/bin/env node
/** Verify public source installation, builds, documentation, and runtime entrypoints. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./repository-files.js";
import { assertNodeRuntime } from "./node-runtime.js";
export interface VerificationOptions {
  skipInstall: boolean;
  skipDocs: boolean;
  releaseCandidate: boolean;
}
export function parseVerificationOptions(args: readonly string[]): VerificationOptions {
  const allowed = ["--skip-install", "--skip-docs", "--release-candidate"];
  for (const flag of args)
    if (!allowed.includes(flag)) throw new Error(`Unknown verification option: ${flag}`);
  const options = {
    skipInstall: args.includes("--skip-install"),
    skipDocs: args.includes("--skip-docs"),
    releaseCandidate: args.includes("--release-candidate"),
  };
  if (options.releaseCandidate && (options.skipInstall || options.skipDocs))
    throw new Error("--release-candidate cannot be combined with partial verification modes");
  return options;
}
async function run(command: string, args: string[], cwd = repositoryRoot): Promise<void> {
  console.log(`\n> ${command === process.execPath ? "node" : command} ${args.join(" ")}`);
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const onInterrupt = (): void => {
      child.kill("SIGINT");
    };
    const onTerminate = (): void => {
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const cleanup = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}
export async function verify(options: VerificationOptions): Promise<void> {
  assertNodeRuntime();
  const npm = async (...args: string[]): Promise<void> => run("npm", args);
  const node = async (path: string, ...args: string[]): Promise<void> =>
    run(process.execPath, [resolve(repositoryRoot, path), ...args]);
  if (!options.skipInstall) {
    await npm("ci", "--ignore-scripts");
    await npm("ci", "--prefix", "apps/platform", "--ignore-scripts");
  }
  await npm("run", "build");
  await npm("--prefix", "apps/platform", "run", "build");
  await npm("run", "typecheck");
  await npm("run", "typecheck:docs");
  await npm("--prefix", "apps/platform", "run", "typecheck");
  await node("integrations/agent-adapters/dist/generate-adapters.js", "--check");
  await npm("--workspace", "@rae/contracts", "run", "build:generator");
  await npm("--workspace", "@rae/contracts", "run", "check:generated");
  await npm("run", "lint");
  await node("scripts/dist/rae.js", "--help");
  await node("scripts/dist/rae.js", "doctor");
  const temporary = mkdtempSync(join(tmpdir(), "rae-verify-"));
  try {
    const engineTarget = join(temporary, "long-horizon");
    await node("scripts/dist/rae.js", "workflow", "long-horizon", "init", engineTarget);
    if (!existsSync(join(engineTarget, ".pipeline/pipeline-state.json")))
      throw new Error("Workflow bootstrap did not write pipeline-state.json");
    const ralphTarget = join(temporary, "ralph");
    mkdirSync(ralphTarget);
    await node("scripts/dist/rae.js", "workflow", "repo-audit", "bootstrap", ralphTarget);
    if (!existsSync(join(ralphTarget, ".claude/ralph-audit/package.json")))
      throw new Error("Ralph bootstrap did not write package.json");
    await node("scripts/dist/rae.js", "hygiene", "coauthor-cleaner", "--help");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  if (!options.skipDocs) await npm("run", "docs:build");
  console.log(`VERDICT: ${options.skipDocs ? "PARTIAL" : "PASS"}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options: VerificationOptions | undefined;
  try {
    options = parseVerificationOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
  if (options)
    try {
      await verify(options);
    } catch (error) {
      console.error(`VERDICT: FAIL\n${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
}
