/** Purpose: characterize the Node floor, direct CLI rejection and partial verification contracts. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { assertNodeRuntime } from "./node-runtime.js";
import { parseVerificationOptions } from "./verify.js";
import { repositoryResidue } from "./check-repository-hygiene.js";
test("Node 24 is the minimum and malformed versions fail closed", () => {
  for (const version of ["24.0.0", "v24.1.2", "25.0.0", "26.8.1", "30.0.0"])
    assertNodeRuntime(version);
  for (const version of [
    "18.20.8",
    "20.19.0",
    "22.12.0",
    "23.11.1",
    "unknown",
    "NaN.0.0",
    "24",
    "24.0",
    "Infinity.0.0",
  ])
    assert.throws(() => assertNodeRuntime(version), /requires Node/);
});
test("unsupported Node stops direct CLI paths before workflow execution", () => {
  const preload = `data:text/javascript,${encodeURIComponent('Object.defineProperty(process.versions,"node",{value:"22.12.0"});')}`;
  for (const command of ["agent", "operator", "ralph", "profile", "doctor"]) {
    const result = spawnSync(
      process.execPath,
      ["--import", preload, new URL("rae.js", import.meta.url).pathname, command, "--help"],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires Node.js 24/);
    assert.doesNotMatch(result.stderr, /Compiled entrypoint missing|Engine entrypoint/);
  }
});
test("verification flags preserve explicit partial modes and reject ambiguous input", () => {
  assert.deepEqual(parseVerificationOptions(["--skip-install", "--skip-docs"]), {
    skipInstall: true,
    skipDocs: true,
    releaseCandidate: false,
  });
  assert.throws(
    () => parseVerificationOptions(["--release-candidate", "--skip-install"]),
    /cannot be combined/,
  );
  assert.throws(() => parseVerificationOptions(["--unknown"]), /Unknown/);
});
test("tracked residue matching preserves legitimate similarly named paths", () => {
  assert.deepEqual(
    repositoryResidue([".DS_Store", "dir/file.swp", "dir.tmp/file.ts", "template.ts", "file.tmp"]),
    [".DS_Store", "dir/file.swp", "file.tmp"],
  );
});

test("lock checks detect dependency and runtime drift without depending on JSON key order", () => {
  assert.deepEqual(
    manifestLockDifferences(
      { dependencies: { a: "1", b: "2" }, engines: { node: ">=24" } },
      { engines: { node: ">=24" }, dependencies: { b: "2", a: "1" } },
    ),
    [],
  );
  assert.deepEqual(
    manifestLockDifferences({ dependencies: { a: "2" } }, { dependencies: { a: "1" } }),
    ["dependencies"],
  );
  assert.deepEqual(manifestLockDifferences({}, undefined), ["missing package entry"]);
});
import { manifestLockDifferences } from "./check-lockfiles.js";
