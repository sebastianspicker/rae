#!/usr/bin/env node
/**
 * Provides the stable autonomous CLI entrypoint while execution lives in focused helpers.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedNodeRuntime } from "../lib/node-runtime.mjs";
import { agentDoctor } from "./lib/agent-executor.mjs";
import { loadExecutionProfile } from "./lib/execution-profile.mjs";
import { runControlCommand, runWorkflow } from "./lib/autonomous-actions.mjs";
export { enforceCommandEvidence } from "./lib/autonomous-evidence.mjs";
export { validateConcurrentOperatorChanges } from "./lib/autonomous-git.mjs";

assertSupportedNodeRuntime();

function usage() {
  process.stdout.write(`RAE autonomous coding-agent orchestrator

Usage:
  node scripts/pipeline/autonomous.mjs doctor [--provider codex|opencode] [--model <provider/model>]
  node scripts/pipeline/autonomous.mjs run --task <text> [options]
  node scripts/pipeline/autonomous.mjs resume --run-id <id> [options]
  node scripts/pipeline/autonomous.mjs status --project-root <workspace> --run-id <id> [--json]
  node scripts/pipeline/autonomous.mjs stop --project-root <workspace> --run-id <id> [--json]
  node scripts/pipeline/autonomous.mjs signal --project-root <workspace> --run-id <id>
    --node-id <wait-node> --signal <name> --idempotency-key <key> [--payload-json <json>] [--json]
  node scripts/pipeline/autonomous.mjs resolve-checkpoint --project-root <workspace> --run-id <id>
    --checkpoint-id <id> --decision <approved|rejected|escalated>
    --decision-id <id> --actor <label> --rationale <text> [--json]
  node scripts/pipeline/autonomous.mjs events --project-root <workspace> --run-id <id>
    [--after-seq <n>] [--limit <1..1000>] [--json]

Run options:
  --project-root <path>       Target Git repository (default: current directory)
  --task <text>               Work request
  --task-file <path>          Read a relative, non-symlink .md or .txt file under the project root
  --provider <name>           auto, codex, or explicit opencode (command is test-integration only)
  --model <id>                Optional Codex model or required OpenCode provider/model
  --reasoning-effort <level>  Codex low, medium, high, or xhigh
  --variant <name>            Optional OpenCode model variant
  --execution-profile <file> Operator-owned logical tiers and provider routes
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
  - OpenCode is explicit, macOS-contained, and never selected by auto
  - agents may not commit, push, publish, install dependencies, or use network infrastructure
  - the custom command provider always fails doctor and cannot run without an unsafe opt-in
`);
}

function parseOptions(argv) {
  const options = { _: [], agentArgs: [] };
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
      options[key] = true;
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
      options[key] = value;
    }
  }
  return options;
}
async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  if (isHelpCommand(command, options)) return usage();
  if (command === "doctor") return runDoctor(options);
  if (["status", "stop", "signal", "resolve-checkpoint", "events"].includes(command))
    return runControlCommand(command, options);
  if (["run", "resume"].includes(command)) return await runWorkflow(command, options);
  throw new Error(`unknown autonomous command: ${command}`);
}

function isHelpCommand(command, options) {
  return command === "help" || command === "--help" || command === "-h" || options.help;
}
function runDoctor(options) {
  const baseOptions = {
    provider: options.provider ?? "auto",
    command: options["agent-command"],
    allowUnsafeCommand: options["allow-unsafe-command-provider"] === true,
    workspaceRoot: resolve(options["project-root"] ?? process.cwd()),
    model: options.model,
    variant: options.variant,
  };
  let result;
  if (options["execution-profile"]) {
    const loaded = loadExecutionProfile(options["execution-profile"]);
    if (loaded.profile.schema_version === "3.0.0") {
      const routes = Object.entries(loaded.profile.routes).map(([routeId, route]) => ({
        route_id: routeId,
        result: agentDoctor({
          ...baseOptions,
          provider: route.executor,
          model: route.model,
          variant: route.variant,
        }),
      }));
      result = {
        success: routes.length > 0 && routes.every((entry) => entry.result.success),
        provider: "mixed",
        execution_profile_digest: loaded.digest,
        routes,
      };
    } else {
      const surfaces = Object.entries(loaded.profile.capability_sets ?? {}).map(
        ([name, capabilities]) => ({
          name,
          result: agentDoctor({ ...baseOptions, capabilities }),
        }),
      );
      result =
        loaded.profile.schema_version === "2.0.0"
          ? {
              success: surfaces.length > 0 && surfaces.every((entry) => entry.result.success),
              provider: "codex",
              execution_profile_digest: loaded.digest,
              capability_sets: surfaces,
            }
          : { ...agentDoctor(baseOptions), execution_profile_digest: loaded.digest };
    }
  } else {
    result = agentDoctor(baseOptions);
  }
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
