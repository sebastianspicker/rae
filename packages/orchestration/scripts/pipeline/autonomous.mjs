#!/usr/bin/env node
/**
 * Provides the stable autonomous CLI entrypoint while execution lives in focused helpers.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";
import { agentDoctor } from "./lib/agent-executor.mjs";
import { runControlCommand, runWorkflow } from "./lib/autonomous-actions.mjs";
export { enforceCommandEvidence } from "./lib/autonomous-evidence.mjs";
export { validateConcurrentOperatorChanges } from "./lib/autonomous-git.mjs";

assertSupportedNodeRuntime();

function usage() {
  process.stdout.write(`RAE autonomous coding-agent orchestrator

Usage:
  node scripts/pipeline/autonomous.mjs doctor [--provider codex]
  node scripts/pipeline/autonomous.mjs run --task <text> [options]
  node scripts/pipeline/autonomous.mjs resume --run-id <id> [options]
  node scripts/pipeline/autonomous.mjs status --project-root <workspace> --run-id <id> [--json]
  node scripts/pipeline/autonomous.mjs stop --project-root <workspace> --run-id <id> [--json]
  node scripts/pipeline/autonomous.mjs resolve-checkpoint --project-root <workspace> --run-id <id>
    --checkpoint-id <id> --decision <approved|rejected|escalated>
    --decision-id <id> --actor <label> --rationale <text> [--json]
  node scripts/pipeline/autonomous.mjs events --project-root <workspace> --run-id <id>
    [--after-seq <n>] [--limit <1..1000>] [--json]

Run options:
  --project-root <path>       Target Git repository (default: current directory)
  --task <text>               Work request
  --task-file <path>          Read a relative, non-symlink .md or .txt file under the project root
  --provider <name>           auto or codex (command is test-integration only)
  --model <id>                Optional Codex model override
  --reasoning-effort <level>  low, medium, high, or xhigh
  --execution-profile <file> Operator-owned logical tier to Codex mapping
  --timeout-seconds <n>       Per-phase timeout (default: 1800)
  --policy <path>             Validated data-only autonomous policy JSON
  --workflow <path>           Explicit graph-native workflow JSON for a new run
  --legacy-linear             Start a temporary v1 ten-phase run
  --checkpoint-policy <mode> Human pause mode: none, before-mutation, or before-mutation-and-ship
  --graph-memory <mode>      Local graph mode: off, read, or read-write (default: off)
  --in-place                  Modify a clean target checkout directly
  --through <node-id>         Stop after one workflow node
  --max-concurrency <n>       Concurrent readers, from 1 to 4 (default: 4)
  --max-repair-rounds <n>     Repair iterations, from 1 to 5 (default: 5)
  --run-id <id>               Resume an existing run (resume command only)
  --json                      Emit the final result as JSON

Custom command-provider options:
  --agent-command <path>      Executable implementing the rae-agent-v1 stdin/stdout protocol
  --agent-arg <value>         Argument for the command; repeat as needed
  --allow-unsafe-command-provider
                              Explicitly enable the unsandboxed test-integration provider

Safety defaults:
  - run creates an isolated Git worktree unless --in-place is explicit
  - Codex phases use read-only or workspace-write sandbox modes as appropriate
  - agents may not commit, push, publish, install dependencies, or use network infrastructure
  - the custom command provider always fails doctor and cannot run without an unsafe opt-in
`);
}

function parseOptions(argv) {
  const options = Object.assign(Object.create(null), { _: [], agentArgs: [] });
  const booleanFlags = new Set([
    "in-place",
    "json",
    "help",
    "legacy-linear",
    "allow-unsafe-command-provider",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      Reflect.set(options, key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || (value.startsWith("--") && key !== "agent-arg")) {
      throw new Error(`missing value for --${key}`);
    }
    index++;
    if (key === "agent-arg") {
      options.agentArgs.push(value);
    } else {
      Reflect.set(options, key, value);
    }
  }
  return options;
}
async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (isHelpCommand(command, options)) return usage();
  if (command === "doctor") return runDoctor(options);
  if (["status", "stop", "resolve-checkpoint", "events"].includes(command))
    return runControlCommand(command, options);
  if (["run", "resume"].includes(command)) return await runWorkflow(command, options);
  throw new Error(`unknown autonomous command: ${command}`);
}

function isHelpCommand(command, options) {
  return command === "help" || command === "--help" || command === "-h" || options.help;
}
function runDoctor(options) {
  const result = agentDoctor({
    provider: options.provider ?? "auto",
    command: options["agent-command"],
    allowUnsafeCommand: options["allow-unsafe-command-provider"] === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.success) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}
