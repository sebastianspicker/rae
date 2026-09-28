/** Purpose: verify runner-only provider staging and bounded immutable artifact reads. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { assertStagingOutsideWritableRoots, createPrivateStaging } from "../src/hosted-staging.js";
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), "rae-staging-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { home, project };
}
test("staging rejects project and temporary roots, including symlink aliases", (t) => {
  const { home, project } = fixture(t);
  assert.throws(() => createPrivateStaging(home, [home]), /outside/);
  const alias = join(project, "alias");
  fs.symlinkSync(home, alias);
  assert.throws(
    () => assertStagingOutsideWritableRoots(join(alias, ".local/state"), [home]),
    /outside/,
  );
  assertStagingOutsideWritableRoots(join(home, ".local/state"), [project]);
});
test("staging artifacts are private, bounded, no-follow, and disposed after execution", (t) => {
  const { home, project } = fixture(t);
  const staging = createPrivateStaging(home, [project]);
  staging.writeSchema(Buffer.from('{"type":"object"}\n'));
  fs.writeFileSync(staging.outputPath, "{}\n");
  assert.equal(fs.statSync(staging.outputPath).mode & 0o077, 0);
  assert.equal(staging.read("output.json").toString(), "{}\n");
  assert.throws(() => staging.read("output.json", 2), /oversized/);
  fs.symlinkSync(staging.outputPath, staging.eventLogPath);
  assert.throws(() => staging.read("events.jsonl"));
  fs.writeFileSync(join(staging.root, ".events-orphan.tmp"), "temporary", { mode: 0o600 });
  staging.close();
  staging.close();
  assert.equal(fs.existsSync(staging.root), false);
  assert.throws(() => staging.read("output.json"), /closed/);
});
test("staging refuses writable parents and symlinked state directories", (t) => {
  const { home, project } = fixture(t);
  fs.mkdirSync(join(home, ".local"), { mode: 0o700 });
  fs.chmodSync(join(home, ".local"), 0o777);
  assert.throws(() => createPrivateStaging(home, [project]), /permission/);
  fs.rmSync(join(home, ".local"), { recursive: true });
  fs.symlinkSync(project, join(home, ".local"));
  assert.throws(() => createPrivateStaging(home, [project]));
  assert.deepEqual(fs.readdirSync(project), []);
});
