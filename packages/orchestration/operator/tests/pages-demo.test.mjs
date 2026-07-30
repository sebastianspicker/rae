/** Verifies the Pages artifact stays derived, sanitized, and entirely simulated. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const orchestrationRoot = resolve(import.meta.dirname, "../..");
const staticRoot = resolve(orchestrationRoot, "operator/static");
const buildScript = resolve(orchestrationRoot, "scripts/build-pages-demo.mjs");

function buildDemo(t) {
  const output = mkdtempSync(join(tmpdir(), "rae-pages-demo-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  execFileSync(process.execPath, [buildScript, "--output", output]);
  return output;
}

test("Pages demo copies canonical application modules without forking the product UI", (t) => {
  const output = buildDemo(t);
  assert.deepEqual(readdirSync(resolve(output, "js")), readdirSync(resolve(staticRoot, "js")));
  for (const name of readdirSync(resolve(staticRoot, "js"))) {
    assert.equal(
      readFileSync(resolve(output, "js", name), "utf8"),
      readFileSync(resolve(staticRoot, "js", name), "utf8"),
    );
  }
  assert.equal(
    readFileSync(resolve(output, "app.js"), "utf8"),
    readFileSync(resolve(staticRoot, "app.js"), "utf8"),
  );
});

test("Pages demo is base-path safe and labels its evidence and actions as simulated", (t) => {
  const output = buildDemo(t);
  const html = readFileSync(resolve(output, "index.html"), "utf8");
  const mock = readFileSync(resolve(output, "demo/mock-api.js"), "utf8");
  assert.match(html, /Static simulation/);
  assert.match(html, /Sanitized fixture data\. No command is run and no state is saved\./);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.doesNotMatch(html, /(?:href|src)="\//);
  for (const id of [
    "new-run-button",
    "start-submit",
    "stop-button",
    "interrupt-button",
    "resume-button",
    "cleanup-button",
    "confirm-submit",
  ]) {
    assert.match(mock, new RegExp(`"${id}"`));
  }
  assert.match(mock, /document\.querySelectorAll\("\[data-decision\]"\)/);
  assert.match(mock, /window\.fetch = demoFetch/);
  assert.match(mock, /does not permit network requests/);
});

test("Pages fixtures contain no local path, credential, provider, or raw prompt data", (t) => {
  const output = buildDemo(t);
  const mock = readFileSync(resolve(output, "demo/mock-api.js"), "utf8");
  assert.doesNotMatch(
    mock,
    /\/Users\/|\/home\/|Bearer |api[_-]?key|private-provider|must-not-leak/i,
  );
  assert.match(mock, /sebastianspicker\/rae · fixture/);
  assert.match(mock, /\.git\/rae-worktrees\//);
});
