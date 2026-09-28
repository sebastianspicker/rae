/** Bootstrap refuses symlink redirection and preserves Node-only saved-state initialization. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve(import.meta.dirname, "../scripts/pipeline-init.js");

test("bootstrap never writes through .pipeline or its runs directory symlinks", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rae-init-links-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const component of [".pipeline", ".pipeline/runs"]) {
    const root = join(base, component.replaceAll("/", "-"));
    const outside = `${root}-outside`;
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "untouched");
    if (component.includes("/")) mkdirSync(join(root, ".pipeline"));
    symlinkSync(outside, join(root, component));
    const child = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
    assert.notEqual(child.status, 0);
    assert.deepEqual(readdirSync(outside), ["sentinel"]);
    assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "untouched");
  }
});

test("Node bootstrap creates a readable state and replaces a leaf symlink without following it", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rae-init-state-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".pipeline"));
  writeFileSync(join(root, "outside.json"), "untouched");
  symlinkSync(join(root, "outside.json"), join(root, ".pipeline/pipeline-state.json"));
  const child = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(join(root, "outside.json"), "utf8"), "untouched");
  const state = JSON.parse(readFileSync(join(root, ".pipeline/pipeline-state.json"), "utf8"));
  assert.equal(state.current_phase, "arm");
  assert.equal(state.workspace.root, root);
  assert.match(state.run_id, /^[a-f0-9-]{36}$/);
  const trace = JSON.parse(
    readFileSync(join(root, `.pipeline/runs/${state.run_id}/trace.jsonl`), "utf8"),
  );
  assert.equal(trace.run_id, state.run_id);
  assert.equal(trace.event, "run_start");
});

test("plain bootstrap creates a missing target directory", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rae-init-missing-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "nested", "target");
  const child = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const state = JSON.parse(readFileSync(join(root, ".pipeline/pipeline-state.json"), "utf8"));
  assert.equal(state.workspace.root, root);
});

test("worktree bootstrap still refuses a missing target", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rae-init-missing-wt-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "absent");
  const child = spawnSync(process.execPath, [cli, root, "--use-worktree"], { encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.equal(existsSync(root), false);
});
