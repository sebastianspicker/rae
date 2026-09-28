/** Verifies CLI cancellation holds its run lock until the provider has finished cleanup. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { bootstrap } from "../src/helper.js";

test("SIGTERM waits for provider cleanup before releasing the embedded run lock", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ralph-cli-cancel-repo-")));
  const control = realpathSync(mkdtempSync(join(tmpdir(), "ralph-cli-cancel-control-")));
  const ready = join(control, "ready");
  const codex = join(control, "codex");
  let providerPid: number | undefined;
  let cli: ReturnType<typeof spawn> | undefined;
  try {
    const destination = bootstrap(root);
    writeFileSync(
      join(destination, "prd.json"),
      readFileSync(join(destination, "prd.json.example")),
    );
    writeFileSync(
      codex,
      `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGINT", () => setTimeout(() => process.exit(0), 300));
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      { mode: 0o700 },
    );
    cli = spawn(
      process.execPath,
      [
        join(destination, "dist/src/cli.js"),
        "--mode",
        "audit",
        "--no-security-preflight",
        "--no-model-preflight",
        "1",
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          RALPH_REPO_ROOT: root,
          PATH: `${control}:${dirname(process.execPath)}:/usr/bin:/bin`,
          RALPH_MAX_ATTEMPTS_PER_STORY: "3",
        },
      },
    );
    let diagnostic = "";
    cli.stdout?.resume();
    cli.stderr?.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    const closed = new Promise<number | null>((resolve, reject) => {
      cli?.once("error", reject);
      cli?.once("close", resolve);
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline && cli.exitCode === null) await delay(20);
    assert.ok(existsSync(ready), diagnostic);
    providerPid = Number(readFileSync(ready, "utf8"));
    const lock = join(destination, ".runtime/.run.lock");
    assert.ok(existsSync(lock));
    cli.kill("SIGTERM");
    await delay(100);
    assert.ok(existsSync(lock), "lock released before provider cleanup");
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("CLI cancellation did not finish")), 5000);
        }),
      ]);
      assert.equal(result, 143, diagnostic);
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(existsSync(lock), false);
    assert.throws(() => process.kill(providerPid as number, 0), { code: "ESRCH" });
    const prd = JSON.parse(readFileSync(join(destination, "prd.json"), "utf8")) as {
      stories: Array<{ passes: boolean }>;
    };
    assert.ok(prd.stories.every((story) => !story.passes));
  } finally {
    if (cli?.exitCode === null) cli.kill("SIGKILL");
    if (providerPid) {
      try {
        process.kill(-providerPid, "SIGKILL");
      } catch {
        /* already absent */
      }
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  }
});
