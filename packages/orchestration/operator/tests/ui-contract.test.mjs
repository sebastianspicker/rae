/** Verifies the Evidence Dossier retains required controls, states, and accessibility cues. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const staticRoot = resolve(root, "static");
const html = readFileSync(resolve(staticRoot, "index.html"), "utf8");
const stylesEntry = readFileSync(resolve(staticRoot, "styles.css"), "utf8");
const cssModules = [...stylesEntry.matchAll(/@import\s+url\("(\.\/[^"]+)"\)/g)].map((match) =>
  readFileSync(resolve(staticRoot, match[1]), "utf8"),
);
const css = [stylesEntry, ...cssModules].join("\n");

function readJsSources() {
  const entry = readFileSync(resolve(staticRoot, "app.js"), "utf8");
  const jsDir = resolve(staticRoot, "js");
  const modules = readdirSync(jsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(resolve(jsDir, name), "utf8"));
  return [entry, ...modules].join("\n");
}

const app = readJsSources();
const appEntry = readFileSync(resolve(staticRoot, "app.js"), "utf8");
const stateSource = readFileSync(resolve(staticRoot, "js/state.js"), "utf8");

test("operator UI implements the Evidence Dossier shell and complete control surface", () => {
  for (const copy of [
    "RAE",
    "Runboard",
    "Evidence Dossier",
    "Local session",
    "No publish controls",
    "Runs",
    "Evidence log",
    "Human checkpoint",
    "Stop at boundary",
    "Interrupt",
    "Resume",
    "Cleanup",
    "Approve",
    "Reject",
    "Escalate",
    "Start a bounded run",
  ]) {
    assert.ok(html.includes(copy));
  }
  for (const id of [
    "project-select",
    "connection-status",
    "runs-list",
    "phase-list",
    "event-list",
    "gate-count",
    "artifact-count",
    "agent-count",
    "input-count",
    "checkpoint-content",
    "checkpoint-rationale",
    "stop-button",
    "interrupt-button",
    "resume-button",
    "cleanup-button",
    "new-run-button",
    "start-dialog",
    "start-task",
    "start-checkpoint-policy",
    "confirm-dialog",
    "confirm-run-id",
    "toggle-search",
    "cycle-filter",
  ]) {
    assert.ok(html.includes(`id="${id}"`));
    assert.ok(app.includes(`"${id}"`));
  }
  assert.doesNotMatch(html, /\sstyle=|\sonclick=|<script(?![^>]*src=)/);
  assert.match(html, /class="runboard"/);
  assert.match(html, /class="phase-spine"/);
  assert.match(html, /class="proof-band"/);
  assert.match(html, /class="evidence-table"/);
  assert.match(html, /class="decision-panel"/);
  assert.doesNotMatch(html, /product-stage|showcase-copy|dossier-tabs/);
  assert.doesNotMatch(app, /\bprompt\s*\(/);
  assert.match(appEntry, /from "\.\/js\//);
});

test("every named element binding exists in the document and registry", () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const registrySource = stateSource.slice(
    stateSource.indexOf("export const elements"),
    stateSource.indexOf("if (state.token)"),
  );
  const registryIds = new Set(
    [...registrySource.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]),
  );
  const referencedIds = new Set(
    [...app.matchAll(/elements\["([^"]+)"\]/g)].map((match) => match[1]),
  );
  assert.deepEqual(
    [...referencedIds].filter((id) => !htmlIds.has(id)),
    [],
  );
  assert.deepEqual(
    [...referencedIds].filter((id) => !registryIds.has(id)),
    [],
  );
});

test("operator UI maps Evidence Dossier metrics and evidence to projected API data", () => {
  assert.match(app, /run\.gates\.filter/);
  assert.match(app, /run\.evidence\.present/);
  assert.match(app, /run\.resources\.agent_calls/);
  assert.match(app, /run\.resources\.input/);
  assert.match(app, /event\.artifact_ref \?\? event\.gate_id \?\? event\.event_id/);
  assert.doesNotMatch(html, /Export manifest|Bundle ID|protected paths changed/);
});

test("operator UI includes focus, reduced-motion, responsive, and status treatments", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 1260px\)/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /button:disabled/);
  assert.match(css, /\.run-row:hover/);
  assert.match(css, /\.run-row\[aria-selected="true"\]/);
  assert.match(html, /Loading runs…/);
  assert.match(html, /No runs yet/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(app, /showError/);
  assert.match(app, /state\.eventError/);
});

test("typed destructive confirmation preserves the exact run-id contract", () => {
  assert.match(app, /openConfirmation\("interrupt"\)/);
  assert.match(app, /openConfirmation\("cleanup"\)/);
  assert.match(app, /elements\["confirm-run-id"\]\.value !== run\.id/);
  assert.match(app, /\{ confirm_run_id: elements\["confirm-run-id"\]\.value \}/);
  assert.match(app, /elements\["confirm-submit"\]\.disabled/);
});

test("operator event loading rejects stale run selections before rendering or streaming", () => {
  assert.match(app, /const generation = \+\+state\.streamGeneration;/);
  assert.match(app, /const projectId = state\.projectId;/);
  assert.match(app, /const runId = state\.runId;/);
  assert.match(app, /signal: controller\.signal/);
  assert.match(app, /if \(!isCurrentEventSelection\(generation, projectId, runId\)\) return;/);
  assert.match(app, /streamEvents\(page\.next_after, generation, projectId, runId\)/);
  assert.match(app, /runs\/\$\{encodeURIComponent\(runId\)\}\/events\/stream/);
});

test("operator run loading rejects stale project responses before rendering", () => {
  assert.match(app, /const generation = \+\+state\.runsGeneration;/);
  assert.match(app, /const projectId = state\.projectId;/);
  assert.match(app, /encodeURIComponent\(projectId\)\}\/runs\?limit=100/);
  assert.match(app, /generation === state\.runsGeneration/);
  assert.match(app, /projectId === state\.projectId/);
  assert.match(app, /if \(!isCurrentRunList\(generation, projectId\)\) return;/);
});

test("static styles and scripts are modularized under static/css and static/js", () => {
  assert.match(stylesEntry, /@import url\("\.\/css\/tokens\.css"\)/);
  assert.match(stylesEntry, /@import url\("\.\/css\/ledger\.css"\)/);
  assert.match(appEntry, /from "\.\/js\/state\.js"/);
  assert.match(appEntry, /from "\.\/js\/handlers\.js"/);
  assert.match(appEntry, /from "\.\/js\/data\.js"/);
});

test("workflow map provides topology, typed edges, budgets, and accessible instance state", () => {
  assert.match(app, /function topology\(definition\)/);
  assert.match(app, /workflow-edge--\$\{edgeRecord\.type\}/);
  assert.match(app, /fanout:/);
  assert.match(app, /Live and completed node instances/);
  assert.match(app, /execution_tier/);
  assert.match(app, /quorum/);
  assert.match(app, /max_dynamic_instances/);
  assert.match(app, /Registry is read-only while a run is active/);
  assert.match(css, /\.workflow-edge--stream/);
  assert.match(css, /\.workflow-edge--loop-back/);
  assert.match(html, /complete equivalent structure and live instance state/);
});
