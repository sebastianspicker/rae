#!/usr/bin/env node
/** Runs one graph workflow provider session in an isolated Node process. */
import { readFileSync } from "node:fs";
import { runAgentPhase } from "./lib/agent-executor.mjs";

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  const result = runAgentPhase(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
