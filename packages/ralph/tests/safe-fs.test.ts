/** Exercises atomic report confinement while a destination parent is replaced. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { atomicWriteRelative } from "../src/safe-fs.js";

test("report writes remain confined during repeated parent swaps", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-report-race-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "ralph-report-race-outside-")));
  const reports = join(root, "reports");
  const held = join(root, "reports-held");
  const stop = join(root, "stop");
  const ready = join(root, "ready");
  mkdirSync(reports);
  writeFileSync(join(outside, "sentinel.md"), "outside sentinel\n");
  const script = `
const fs = require("node:fs");
const [reports, held, outside, ready, stop] = process.argv.slice(1);
fs.writeFileSync(ready, "ready");
while (!fs.existsSync(stop)) {
  try { fs.renameSync(reports, held); } catch {}
  try { fs.symlinkSync(outside, reports); } catch {}
  try { fs.rmSync(reports); } catch {}
  try { fs.renameSync(held, reports); } catch {}
}
try { fs.rmSync(reports); } catch {}
try { fs.renameSync(held, reports); } catch {}
`;
  const child = spawn(process.execPath, ["-e", script, reports, held, outside, ready, stop], {
    stdio: "ignore",
  });
  try {
    for (let count = 0; count < 500 && !existsSync(ready); count++)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    assert.equal(existsSync(ready), true);
    for (let count = 0; count < 250; count++) {
      try {
        atomicWriteRelative(root, "reports/result.md", `report ${count}\n`);
      } catch {
        /* A raced parent is expected to fail closed. */
      }
    }
    writeFileSync(stop, "stop\n");
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`swap process exited ${code}`)),
      );
      child.once("error", reject);
    });
    assert.equal(readFileSync(join(outside, "sentinel.md"), "utf8"), "outside sentinel\n");
    assert.equal(existsSync(join(outside, "result.md")), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
