/** Verifies Ralph terminates complete process groups at deadlines and output limits. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OVERFLOW_EXIT, supervise, TIMEOUT_EXIT } from "../src/supervisor.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function temporary(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("deadline terminates a child and its descendant process", async () => {
  const directory = temporary("ralph-supervisor-");
  const pidFile = join(directory, "descendant.pid");
  try {
    const program = `
      const {spawn} = require("node:child_process");
      const {writeFileSync} = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const code = await supervise({
      command: process.execPath,
      args: ["-e", program],
      cwd: directory,
      env: process.env,
      input: Buffer.alloc(0),
      timeoutSeconds: 0.2,
      graceSeconds: 0.2,
      rawOutput: join(directory, "raw.log"),
      report: join(directory, "report.md"),
    });
    assert.equal(code, TIMEOUT_EXIT);
    const descendant = Number(readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(descendant), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raw output is capped and reported as overflow", async () => {
  const directory = temporary("ralph-supervisor-");
  try {
    const code = await supervise({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)"],
      cwd: directory,
      env: process.env,
      input: Buffer.alloc(0),
      timeoutSeconds: 5,
      graceSeconds: 0.1,
      rawOutput: join(directory, "raw.log"),
      report: join(directory, "report.md"),
      rawLimit: 1024,
    });
    assert.equal(code, OVERFLOW_EXIT);
    assert.equal(readFileSync(join(directory, "raw.log")).length, 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized final reports terminate the provider", async () => {
  const directory = temporary("ralph-supervisor-report-");
  const report = join(directory, "report.md");
  try {
    const program = `require("node:fs").writeFileSync(${JSON.stringify(report)}, "x".repeat(8192)); setInterval(() => {}, 1000)`;
    const code = await supervise({
      command: process.execPath,
      args: ["-e", program],
      cwd: directory,
      env: process.env,
      input: Buffer.alloc(0),
      timeoutSeconds: 5,
      graceSeconds: 0.1,
      rawOutput: join(directory, "raw.log"),
      report,
      reportLimit: 1024,
    });
    assert.equal(code, OVERFLOW_EXIT);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("early parent exit does not cancel cleanup of a signal-resistant descendant", async () => {
  const directory = temporary("ralph-supervisor-orphan-");
  const pidFile = join(directory, "descendant.pid");
  let descendant: number | undefined;
  try {
    const program = `
      const {spawn} = require("node:child_process");
      const {writeFileSync} = require("node:fs");
      const child = spawn(process.execPath, ["-e", "process.on('SIGINT', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], {stdio: ["ignore", "pipe", "ignore"]});
      child.stdout.once('data', () => {
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        process.stdout.write('x'.repeat(8192));
      });
      setInterval(() => {}, 1000);
    `;
    const code = await supervise({
      command: process.execPath,
      args: ["-e", program],
      cwd: directory,
      env: process.env,
      input: Buffer.alloc(0),
      timeoutSeconds: 5,
      graceSeconds: 0.2,
      rawOutput: join(directory, "raw.log"),
      report: join(directory, "report.md"),
      rawLimit: 1024,
    });
    descendant = Number(readFileSync(pidFile, "utf8"));
    assert.equal(code, OVERFLOW_EXIT);
    assert.equal(alive(descendant), false);
  } finally {
    if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation awaits group cleanup and suppresses already-cancelled launches", async () => {
  const directory = temporary("ralph-supervisor-abort-");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    const options = {
      command: process.execPath,
      args: ["-e", "process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],
      cwd: directory,
      env: process.env,
      input: Buffer.alloc(0),
      timeoutSeconds: 5,
      graceSeconds: 0.1,
      rawOutput: join(directory, "raw.log"),
      report: join(directory, "report.md"),
      signal: controller.signal,
    };
    const started = Date.now();
    assert.equal(await supervise(options), 130);
    assert.ok(Date.now() - started >= 250);
    assert.equal(await supervise({ ...options, command: "/not-an-executable" }), 130);
  } finally {
    clearTimeout(timer);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("symlinked provider reports are rejected without reading their target", async () => {
  const directory = temporary("ralph-supervisor-report-link-");
  const outside = join(directory, "outside");
  const report = join(directory, "report.md");
  try {
    const program = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(outside)},'private');fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(report)});`;
    await assert.rejects(() =>
      supervise({
        command: process.execPath,
        args: ["-e", program],
        cwd: directory,
        env: process.env,
        input: Buffer.alloc(0),
        timeoutSeconds: 5,
        graceSeconds: 0.1,
        rawOutput: join(directory, "raw.log"),
        report,
      }),
    );
    assert.equal(readFileSync(outside, "utf8"), "private");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
