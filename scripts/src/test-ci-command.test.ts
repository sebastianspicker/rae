/** CI bootstraps run typed, declarative argument lists without interpreting shell syntax. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseCommands } from "./ci-command.js";

test("CI commands reject malformed values and preserve exact argument strings", () => {
  assert.deepEqual(parseCommands('["npm","run","build"]'), [["npm", "run", "build"]]);
  assert.deepEqual(parseCommands('[["node","a b","$HOME","`id`","$(id)"]]'), [
    ["node", "a b", "$HOME", "`id`", "$(id)"],
  ]);
  for (const value of ["{}", "[]", "[[]]", "[1]", '[["node", 3]]', '["node","\\u0000"]'])
    assert.throws(() => parseCommands(value));
});

test("uncompiled Node bootstrap executes ordered commands with literal shell metacharacters", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rae-ci-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const step = join(root, "step.json");
  const output = join(root, "result.txt");
  const literal = "$HOME `id` $(id) ; space 日本語";
  writeFileSync(
    step,
    JSON.stringify([
      [
        "node",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';fs.writeFileSync(process.argv[1],process.argv[2]);",
        output,
        literal,
      ],
      [
        "node",
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';fs.appendFileSync(process.argv[1],' done');",
        output,
      ],
    ]),
  );
  execFileSync(process.execPath, [resolve(import.meta.dirname, "../src/ci-command.ts"), step]);
  assert.equal(readFileSync(output, "utf8"), `${literal} done`);
});
