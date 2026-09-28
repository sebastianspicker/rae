#!/usr/bin/env node
/** Verify the compiled platform image's public engine entrypoint and immutable contract assets. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(resolve(process.cwd(), "apps/platform/package.json"));
const engineName = "@rae/engine";
const engine: unknown = await import(engineName);
if (
  !engine ||
  typeof engine !== "object" ||
  !("workflowAgentWorkerPath" in engine) ||
  typeof engine.workflowAgentWorkerPath !== "function"
)
  throw new Error("Engine public worker entrypoint is unavailable");
const worker: unknown = engine.workflowAgentWorkerPath();
if (typeof worker !== "string" || !worker.endsWith(".js") || !existsSync(worker))
  throw new Error("Compiled worker entrypoint is missing from image");
const contract = require.resolve("@rae/contracts/v1/workflows/workflow-v2.schema.json");
if (!existsSync(contract)) throw new Error("Workflow v2 schema is missing from image");
if (!existsSync(resolve(dirname(worker), "../public/index.js")))
  throw new Error("Engine public module is missing from image");
console.log("Compiled platform image boundary passed");
