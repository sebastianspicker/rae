/** Covers the Pages mock transport and subpath-safe static demo build. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDemoTransport } from "../demo/transport.js";
import { buildDemo } from "../scripts/build-demo.mjs";

test("mock transport routes data and retains mutations in browser memory", async () => {
  const transport = createDemoTransport();
  const projects = await transport.request("/projects");
  assert.equal(projects.projects[0].id, "demo-project");
  const original = await transport.request("/projects/demo-project/runs?limit=100");
  await transport.request("/projects/demo-project/runs", { method: "POST", body: JSON.stringify({ task: "Create mock evidence" }) });
  const started = await transport.request("/projects/demo-project/runs?limit=100");
  assert.equal(started.runs.length, original.runs.length + 1);
  const run = started.runs[0];
  await transport.request(`/projects/demo-project/runs/${run.id}/stop`, { method: "POST", body: "{}" });
  const afterStop = await transport.request("/projects/demo-project/runs?limit=100");
  assert.equal(afterStop.runs[0].status, "stop-requested");
  const stream = await transport.eventStream(`/projects/demo-project/runs/${run.id}/events/stream?after=0`);
  assert.equal(stream.ok, true);
  assert.match(await stream.text(), /mock run created/);
});

test("mock transport covers checkpoint and workflow mutation routes", async () => {
  const transport = createDemoTransport();
  await transport.request("/projects/demo-project/runs/run-demo-hold/checkpoint-decision", {
    method: "POST",
    body: JSON.stringify({ checkpoint_id: "checkpoint-demo-ship", decision: "approve", decision_id: "decision-demo", rationale: "Mock-only acceptance." }),
  });
  const workflows = await transport.request("/projects/demo-project/workflows");
  assert.equal(workflows.workflows[0].workflow_id, "repository-change");
  const analysis = await transport.request("/projects/demo-project/workflows/repository-change/analysis", {
    method: "POST", body: JSON.stringify({ workflow: { nodes: [{ id: "one" }], edges: [] } }),
  });
  assert.equal(analysis.analysis.source, "mock-only");
  const proposal = await transport.request("/projects/demo-project/workflows/repository-change/proposals", { method: "POST", body: JSON.stringify({ task: "Add a mock gate" }) });
  const completed = await transport.request(`/projects/demo-project/workflows/repository-change/proposals/${proposal.id}`);
  assert.equal(completed.proposal.state, "completed");
  const template = await transport.request("/projects/demo-project/workflows/templates", {
    method: "POST", body: JSON.stringify({ template_id: "review-hold", workflow_id: "repository-change", revision: 4 }),
  });
  const saved = await transport.request("/projects/demo-project/workflows/repository-change/drafts", {
    method: "POST", body: JSON.stringify({ workflow: template.workflow, actor: "demo", rationale: "Mock draft." }),
  });
  const validation = await transport.request("/projects/demo-project/workflows/repository-change/revisions/4/validate", { method: "POST", body: "{}" });
  assert.equal(validation.validation.valid, true);
  const activation = await transport.request("/projects/demo-project/workflows/repository-change/revisions/4/activate", {
    method: "POST", body: JSON.stringify({ digest: saved.revision.digest, actor: "demo", rationale: "Mock activation." }),
  });
  assert.equal(activation.activation.revision, 4);
});

test("Pages build rewrites root assets and emits nojekyll", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "rae-operator-demo-test-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  await buildDemo(output);
  const index = readFileSync(join(output, "index.html"), "utf8");
  assert.match(index, /href="\.\/styles\.css"/);
  assert.match(index, /src="\.\/demo\/bootstrap\.js"/);
  assert.match(index, /href="\.\/demo\/tour\.html"/);
  assert.doesNotMatch(index, /(?:href|src)="\//);
  assert.equal(existsSync(join(output, ".nojekyll")), true);
  assert.equal(existsSync(join(output, "demo", "transport.js")), true);
  assert.equal(existsSync(join(output, "demo", "tour.html")), true);
  assert.equal(existsSync(join(output, "demo", "screenshots", "evidence-dossier-desktop.png")), true);
});

test("Pages build rejects source and ancestor output directories", async () => {
  await assert.rejects(buildDemo(join(import.meta.dirname, "..", "static")), /outside the operator source/);
  await assert.rejects(buildDemo(join(import.meta.dirname, "..")), /outside the operator source/);
});
