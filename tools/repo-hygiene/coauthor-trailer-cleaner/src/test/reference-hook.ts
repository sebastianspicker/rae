#!/usr/bin/env node
/** Record forwarded ref-hook phases for disposable history transactions. */
import { appendFileSync, readFileSync } from "node:fs";
const log = process.env.RAE_TEST_HOOK_LOG;
if (!log) throw new Error("Expected disposable reference hook log");
appendFileSync(
  log,
  `${JSON.stringify({ phase: process.argv[2], input: readFileSync(0, "utf8") })}\n`,
);
