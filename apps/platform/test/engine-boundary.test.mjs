/** Purpose: prevent the quarantined platform worker from reaching engine implementation internals. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const localExecutorUrl = new URL("../src/local-executor.mjs", import.meta.url);

test("local claim execution uses only the engine public facade", async () => {
  const source = await fs.readFile(fileURLToPath(localExecutorUrl), "utf8");
  assert.match(source, /from\s+"@rae\/engine"/);
  assert.match(source, /const WORKER = workflowAgentWorkerPath\(\);/);
  assert.doesNotMatch(source, /packages\/engine\/src\/(?!public\/index\.mjs)/);
  assert.doesNotMatch(source, /packages\/orchestration\/scripts\/pipeline/);
});
