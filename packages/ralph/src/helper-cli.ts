#!/usr/bin/env node
/** Provides the command-line entrypoint for Ralph's operational helpers. */
import { join } from "node:path";
import {
  appendProgressEntry,
  archiveState,
  bootstrap,
  generateProgress,
  recordLearningEntry,
  syncAgents,
} from "./helper.js";
import { errorMessage } from "./errors.js";
import { MODES, type Mode } from "./types.js";

const USAGE = `Usage: ralph-helper <command> [options]

Commands:
  bootstrap [--force] [--with-tests] <target-repo>
  generate-progress [prd-file] [output-file]
  append-progress-entry --story <id> --mode <mode> --title <title> --report <path> [--out <path>] [--root <dir>]
  record-learning --story <id> --note <text> [--files <csv>] [--out <path>] [--root <dir>]
  sync-agents [--root <dir>]
  archive [--source-root <dir>] [--archive-root <dir>] [--label <slug>] [--reason <text>] [--force]
`;

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return result;
}

function flag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function assertNoExtra(args: string[]): void {
  if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
}

function bootstrapCommand(args: string[]): number {
  const force = flag(args, "--force");
  const withTests = flag(args, "--with-tests");
  const target = args.shift();
  if (!target) throw new Error("missing required argument: <target-repo>");
  assertNoExtra(args);
  process.stdout.write(`Bootstrapped template to ${bootstrap(target, force, withTests)}\n`);
  return 0;
}

function generateProgressCommand(args: string[]): number {
  const prd = args.shift() ?? join(process.cwd(), "prd.json");
  const output = args.shift() ?? join(process.cwd(), "progress.txt");
  assertNoExtra(args);
  generateProgress(prd, output);
  return 0;
}

function syncAgentsCommand(args: string[]): number {
  const root = value(args, "--root") ?? process.cwd();
  assertNoExtra(args);
  syncAgents(root);
  return 0;
}

function recordLearningCommand(args: string[]): number {
  const root = value(args, "--root") ?? process.cwd();
  const story = value(args, "--story");
  const note = value(args, "--note");
  const files = value(args, "--files") ?? "";
  const output = value(args, "--out");
  if (!story || !note) throw new Error("record-learning requires --story and --note");
  assertNoExtra(args);
  process.stdout.write(
    `Recorded learning in ${recordLearningEntry(root, story, note, files, output)}\n`,
  );
  return 0;
}

function appendProgressEntryCommand(args: string[]): number {
  const root = value(args, "--root") ?? process.cwd();
  const story = value(args, "--story");
  const requestedMode = value(args, "--mode");
  const title = value(args, "--title");
  const report = value(args, "--report");
  const output = value(args, "--out");
  if (!story || !requestedMode || !title || !report)
    throw new Error("append-progress-entry requires --story, --mode, --title, and --report");
  if (!MODES.includes(requestedMode as Mode))
    throw new Error("--mode must be audit|linting|fixing");
  assertNoExtra(args);
  process.stdout.write(
    `Recorded progress in ${appendProgressEntry(root, story, requestedMode as Mode, title, report, output)}\n`,
  );
  return 0;
}

function archiveCommand(args: string[]): number {
  const source = value(args, "--source-root") ?? process.cwd();
  const archive = value(args, "--archive-root") ?? join(source, "archive");
  const label = value(args, "--label") ?? "";
  const reason = value(args, "--reason") ?? "";
  const force = flag(args, "--force");
  assertNoExtra(args);
  process.stdout.write(
    `Archived run state to ${archiveState(source, archive, label, reason, force)}\n`,
  );
  return 0;
}
const COMMANDS = new Map<string, (args: string[]) => number>([
  ["bootstrap", bootstrapCommand],
  ["generate-progress", generateProgressCommand],
  ["sync-agents", syncAgentsCommand],
  ["record-learning", recordLearningCommand],
  ["append-progress-entry", appendProgressEntryCommand],
  ["archive", archiveCommand],
]);
function main(argv: string[]): number {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...args] = argv;
  const handler = command === undefined ? undefined : COMMANDS.get(command);
  if (!handler) throw new Error(`Unknown helper command: ${command}`);
  return handler(args);
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[ralph-helper][ERROR] ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
