#!/usr/bin/env node
/** Consumes a workflow provider request, then fails for durable pre-invocation evidence tests. */
import { readFileSync } from "node:fs";

JSON.parse(readFileSync(0, "utf8"));
process.stderr.write("intentional workflow provider failure\n");
process.exitCode = 7;
