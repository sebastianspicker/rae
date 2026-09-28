/** Applications resolve compiled engine behavior solely through its public facade. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { workflowAgentWorkerPath } from "@rae/engine";

test("local claim execution uses the compiled public engine supervisor", () => {
  const source = readFileSync(new URL("../src/local-executor.js", import.meta.url), "utf8");
  assert.match(source, /from\s+"@rae\/engine"/);
  assert.doesNotMatch(source, /packages\/engine\/src\//);
  const worker = workflowAgentWorkerPath();
  assert.match(worker, /dist\/src\/cli\/workflow-agent-worker\.js$/);
  assert.equal(existsSync(worker), true);
});
