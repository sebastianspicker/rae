#!/usr/bin/env node
/** Returns deterministic workflow payloads for autonomous context integration tests. */
import { readFileSync } from "node:fs";

const request = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(
  `${JSON.stringify({ summary: `Completed ${request.phase}`, findings: [] })}\n`,
);
