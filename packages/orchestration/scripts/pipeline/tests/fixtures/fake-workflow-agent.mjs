#!/usr/bin/env node
/** Returns deterministic graph-workflow payloads for command-provider integration tests. */
import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
const payload =
  request.phase === "diagnose"
    ? { status: "passed", rationale: "No blocking fixture findings", findings: [] }
    : { summary: `Completed ${request.phase}`, findings: [] };
process.stdout.write(`${JSON.stringify(payload)}\n`);
