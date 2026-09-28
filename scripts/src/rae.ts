#!/usr/bin/env node
/** Node umbrella CLI dispatches compiled package entrypoints with caller-relative paths. */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openRoot } from "@rae/fs-bridge";
import { repositoryRoot } from "./repository-files.js";
import { assertNodeRuntime as assertNode } from "./node-runtime.js";

const caller = process.env.INIT_CWD || process.cwd();
const help = `Usage: npm run rae -- <command> [args]

Commands:
  verify [options]                  Run repository verification
  doctor                            Check Node and compiled package entrypoints
  agent <subcommand> [args]         Autonomous coding-agent orchestrator
  graph <subcommand> [args]         Repository graph projections and memory
  operator serve [args]             Authenticated loopback operator console
  orchestrate <subcommand> [args]   Staged workflow interface
  worktree <subcommand> [args]      Worktree orchestration aliases
  ralph [args]                      Ralph story loop and embedded bootstrap
  hygiene coauthor-cleaner [args]   Narrow history maintenance
  profile <install|uninstall> [args]  Agent profile transactions
  workflow <family> [args]          Autonomous, repo-audit and long-horizon aliases
  help                              Show this help
`;
async function engineEntry(name: string): Promise<string> {
  const moduleName = "@rae/engine";
  const namespace: unknown = await import(moduleName);
  if (!namespace || typeof namespace !== "object" || !(name in namespace))
    throw new Error(`Engine entrypoint ${name} is unavailable; finish the engine build`);
  const entry: unknown = Reflect.get(namespace, name);
  if (typeof entry !== "function") throw new Error(`Invalid engine entrypoint ${name}`);
  const path: unknown = entry();
  if (typeof path !== "string" || !path.endsWith(".js") || !existsSync(path))
    throw new Error(`Compiled engine entrypoint ${name} is unavailable; run the TypeScript build`);
  return path;
}
async function execute(path: string, args: string[], cwd = caller): Promise<number> {
  if (!existsSync(path))
    throw new Error(`Compiled entrypoint missing: ${path}; run the owning package build`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [path, ...args], { cwd, stdio: "inherit" });
    const signals = ["SIGINT", "SIGTERM"] as const;
    const handlers = signals.map((signal) => {
      const handler = (): void => {
        child.kill(signal);
      };
      process.on(signal, handler);
      return handler;
    });
    const cleanup = (): void => {
      signals.forEach((signal, index) => {
        process.off(signal, handlers[index]);
      });
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}
function packageFile(path: string): string {
  return resolve(repositoryRoot, path);
}
async function doctor(): Promise<number> {
  let failed = false;
  console.log(`RAE doctor\nroot   ${repositoryRoot}\npwd    ${caller}`);
  const check = async (name: string, run: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      const result = await run();
      console.log(`OK     ${name.padEnd(18)} ${String(result ?? "available")}`);
    } catch (error) {
      failed = true;
      console.error(
        `FAIL   ${name.padEnd(18)} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  await check("node", () => {
    assertNode();
    return process.version;
  });
  await check("git", () => {
    const child = spawnSync("git", ["--version"], { encoding: "utf8" });
    if (child.error || child.status) throw new Error("Git unavailable");
    return child.stdout.trim();
  });
  await check("native-filesystem", () => {
    const fd = openRoot(realpathSync(repositoryRoot));
    closeSync(fd);
    return process.platform;
  });
  for (const entry of [
    "autonomousEntrypoint",
    "graphCliEntrypoint",
    "stagedEntrypoint",
    "pipelineInitEntrypoint",
  ])
    await check(entry, () => engineEntry(entry));
  for (const [name, path] of [
    ["operator", "apps/operator/dist/server.js"],
    ["ralph", "packages/ralph/dist/src/cli.js"],
    ["profiles", "profiles/agent-environments/dist/cli.js"],
    ["history", "tools/repo-hygiene/coauthor-trailer-cleaner/dist/cli.js"],
  ])
    await check(name, () => {
      if (!existsSync(packageFile(path))) throw new Error("Compiled entrypoint missing");
      return path;
    });
  console.log(`VERDICT: ${failed ? "FAIL" : "PASS"}`);
  return failed ? 1 : 0;
}
async function orchestrate(args: string[]): Promise<number> {
  const [command = "help", ...rest] = args;
  if (command === "init") {
    const parameters = [...rest];
    if (parameters[0] && !parameters[0].startsWith("--"))
      parameters[0] = resolve(caller, parameters[0]);
    return execute(
      await engineEntry("pipelineInitEntrypoint"),
      parameters,
      packageFile("packages/engine"),
    );
  }
  if (
    ![
      "help",
      "--help",
      "-h",
      "run-stage",
      "start-phase",
      "end-phase",
      "record-artifact",
      "record-gate",
      "record-review-state",
      "summarize-run",
      "summarize-progress",
      "doctor",
    ].includes(command)
  )
    throw new Error(`Unknown orchestrate subcommand: ${command}`);
  return execute(
    await engineEntry("stagedEntrypoint"),
    [command === "help" ? "--help" : command, ...rest],
    packageFile("packages/engine"),
  );
}
async function ralph(args: string[]): Promise<number> {
  const [command = "--help", ...rest] = args;
  const root = packageFile("packages/ralph");
  if (["bootstrap", "bootstrap-template"].includes(command))
    return execute(resolve(root, "dist/src/helper-cli.js"), ["bootstrap", ...rest], root);
  if (command === "tests") return execute(resolve(root, "dist/src/test-cli.js"), rest, root);
  return execute(
    resolve(root, "dist/src/cli.js"),
    [command === "help" ? "--help" : command, ...rest],
    root,
  );
}
async function worktree(args: string[]): Promise<number> {
  const [command = "help", ...rest] = args;
  if (["help", "-h", "--help"].includes(command)) {
    console.log(
      "worktree init [root] [options] | summary [args] | review-state [args] | cleanup <path>",
    );
    return 0;
  }
  if (["summary", "summarize"].includes(command))
    return orchestrate(["summarize-progress", ...rest]);
  if (command === "review-state") return orchestrate(["record-review-state", ...rest]);
  const init = await engineEntry("pipelineInitEntrypoint");
  if (command === "cleanup") {
    if (rest.length !== 1) throw new Error("worktree cleanup accepts exactly one path");
    return execute(init, ["--cleanup-worktree", resolve(caller, rest[0])]);
  }
  if (command !== "init") throw new Error(`Unknown worktree subcommand: ${command}`);
  let root = repositoryRoot;
  if (rest[0] && !rest[0].startsWith("--")) {
    root = resolve(caller, rest[0]);
    rest.shift();
  }
  return execute(init, [root, "--use-worktree", ...rest], packageFile("packages/engine"));
}
async function workflow(args: string[]): Promise<number> {
  const [family = "help", action, ...rest] = args;
  if (["help", "--help", "-h"].includes(family)) {
    console.log("workflow autonomous|repo-audit|long-horizon|hygiene [args]");
    return 0;
  }
  const parameters = action === undefined ? [] : [action, ...rest];
  if (["autonomous", "agent"].includes(family)) return main(["agent", ...parameters]);
  if (family === "hygiene") return main(["hygiene", ...parameters]);
  if (family === "long-horizon") return orchestrate(parameters);
  if (family !== "repo-audit") throw new Error(`Unknown workflow family: ${family}`);
  if (action === "run") {
    if (!rest.length) throw new Error("repo-audit run expects explicit Ralph arguments");
    return ralph(rest);
  }
  if (action === "bootstrap") return ralph(["bootstrap", ...rest]);
  if ([undefined, "check", "doctor", "status", "list-stories", "validate-prd"].includes(action))
    return ralph([`--${action ?? "check"}`, ...rest]);
  if (["help", "--help", "-h"].includes(action ?? "")) {
    console.log("repo-audit bootstrap|check|doctor|status|list-stories|validate-prd|run [args]");
    return 0;
  }
  throw new Error(`Unknown repo-audit action: ${action}`);
}
export async function main(args: string[]): Promise<number> {
  assertNode();
  const [command = "help", ...rest] = args;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      console.log(help);
      return 0;
    case "doctor":
      return doctor();
    case "agent":
    case "autonomous":
      return execute(await engineEntry("autonomousEntrypoint"), rest);
    case "graph":
      return execute(await engineEntry("graphCliEntrypoint"), rest);
    case "orchestrate":
    case "orchestration":
      return orchestrate(rest);
    case "worktree":
      return worktree(rest);
    case "ralph":
      return ralph(rest);
    case "workflow":
    case "workflows":
      return workflow(rest);
    case "profile":
      return execute(packageFile("profiles/agent-environments/dist/cli.js"), rest);
    case "verify":
      return execute(packageFile("scripts/dist/verify.js"), rest, repositoryRoot);
    case "operator":
    case "console": {
      const [action = "help", ...parameters] = rest;
      if (!["help", "--help", "-h", "serve"].includes(action))
        throw new Error(`Unknown operator subcommand: ${action}`);
      return execute(
        packageFile("apps/operator/dist/server.js"),
        action === "serve" ? parameters : ["--help"],
      );
    }
    case "hygiene": {
      const [tool = "help", ...parameters] = rest;
      if (["help", "--help", "-h"].includes(tool)) {
        console.log("hygiene coauthor-cleaner [args]");
        return 0;
      }
      if (!["coauthor-cleaner", "coauthor-trailer-cleaner"].includes(tool))
        throw new Error(`Unknown hygiene tool: ${tool}`);
      return execute(
        packageFile("tools/repo-hygiene/coauthor-trailer-cleaner/dist/cli.js"),
        parameters,
      );
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
