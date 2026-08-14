/** Exercises fail-closed event-log replacement through both provider entry points. */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentPhase } from "../lib/agent-executor.mjs";
import { runOpenCodePhase } from "../lib/opencode-adapter.mjs";

const roots = [];

function root() {
  const value = mkdtempSync(join(tmpdir(), "rae-event-log-security-"));
  roots.push(value);
  return value;
}

function codexFixture({
  events = '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":1,"output_tokens":1,"reasoning_output_tokens":1}}\n',
  status = 0,
  swapDestination = false,
  probeTemps = false,
} = {}) {
  const workspace = root();
  const executable = join(workspace, "codex");
  const outside = join(workspace, "outside.txt");
  const eventLogPath = join(workspace, "events.jsonl");
  const destinationSwap = swapDestination
    ? `fs.rmSync(${JSON.stringify(eventLogPath)},{force:true});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(eventLogPath)});`
    : "";
  const tempProbe = probeTemps
    ? `const t=fs.readdirSync(".").filter(n=>n.includes("events.jsonl.")&&n.endsWith(".tmp"));fs.writeFileSync("provider-temp-probe.json",JSON.stringify(t));for(const p of t)fs.appendFileSync(p,"INJECTED\\n");`
    : "";
  writeFileSync(outside, "outside", "utf8");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a.includes("exec")){fs.writeFileSync(a[a.indexOf("--output-last-message")+1],"{}\\n");${destinationSwap}${tempProbe}process.stdout.write(${JSON.stringify(events)});process.exit(${status})}process.exit(0);\n`,
    "utf8",
  );
  chmodSync(executable, 0o755);
  return {
    workspace,
    outside,
    env: { PATH: workspace },
    eventLogPath,
  };
}

function runCodex(item) {
  return runAgentPhase({
    provider: "codex",
    workspaceRoot: item.workspace,
    schemaPath: join(item.workspace, "schema.json"),
    outputPath: join(item.workspace, "artifact.json"),
    eventLogPath: item.eventLogPath,
    prompt: "fixture",
    sandboxMode: "read-only",
    timeoutMs: 5_000,
    env: item.env,
  });
}

function assertNoTemps(item) {
  expect(
    readdirSync(item.workspace).filter(
      (name) => name.includes("events.jsonl.") && name.endsWith(".tmp"),
    ),
  ).toEqual([]);
}

function withRuntimeTempRoot(root, action) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return action();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

function openCodeFixture({
  events = `${JSON.stringify({ type: "text", part: { type: "text", text: '{"ok":true}' } })}\n`,
  status = 0,
  swapDestination = false,
  probeTemps = false,
} = {}) {
  const workspace = root();
  const executable = join(workspace, "opencode");
  const sandbox = join(workspace, "sandbox-wrapper");
  const eventLogPath = join(workspace, "events.jsonl");
  const outside = join(workspace, "outside.txt");
  const destinationSwap = swapDestination
    ? `fs.rmSync(${JSON.stringify(eventLogPath)},{force:true});fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(eventLogPath)});`
    : "";
  const tempProbe = probeTemps
    ? `const t=fs.readdirSync(".").filter(n=>n.includes("events.jsonl.")&&n.endsWith(".tmp"));fs.writeFileSync("provider-temp-probe.json",JSON.stringify(t));for(const p of t)fs.appendFileSync(p,"INJECTED\\n");`
    : "";
  writeFileSync(outside, "outside", "utf8");
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a[0]==="--version"){console.log("1.18.11")}else if(a.includes("debug")){console.log(process.env.OPENCODE_CONFIG_CONTENT)}else{${destinationSwap}${tempProbe}process.stdout.write(${JSON.stringify(events)});process.exit(${status})}\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    sandbox,
    `#!${process.execPath}\nconst c=require("node:child_process").spawnSync(process.argv[4],process.argv.slice(5),{cwd:process.cwd(),env:process.env,encoding:"utf8"});process.stdout.write(c.stdout||"");process.stderr.write(c.stderr||"");process.exit(c.status||0);\n`,
    { mode: 0o755 },
  );
  return {
    workspace,
    outside,
    eventLogPath,
    sandbox,
    env: {
      ...process.env,
      PATH: `${workspace}${delimiter}${process.env.PATH ?? ""}`,
      HOME: workspace,
    },
  };
}

function runOpenCode(item) {
  return runOpenCodePhase({
    platform: "darwin",
    allowTestSandbox: true,
    sandboxExecutable: item.sandbox,
    workspaceRoot: item.workspace,
    sourceRoot: join(item.workspace, "source"),
    sandboxMode: "read-only",
    model: "openrouter/example",
    eventLogPath: item.eventLogPath,
    prompt: "fixture",
    env: item.env,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Codex event-log reservation", () => {
  it("creates a private replacement for an absent destination without residue", () => {
    const item = codexFixture();
    runCodex(item);
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    assertNoTemps(item);
  });

  it("replaces rather than appends an existing file and preserves it on provider or parse failure", () => {
    const item = codexFixture();
    writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
    runCodex(item);
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("old");
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    const malformed = codexFixture({ events: "not-json\n" });
    writeFileSync(malformed.eventLogPath, "old", "utf8");
    expect(() => runCodex(malformed)).toThrow("event stream is invalid");
    expect(readFileSync(malformed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(malformed);
  });

  it("rejects unsafe initial destinations without mutation", () => {
    const target = root();
    const item = codexFixture();
    writeFileSync(`${target}/target`, "safe", "utf8");
    symlinkSync(`${target}/target`, item.eventLogPath);
    expect(() => runCodex(item)).toThrow("destination must be absent or a regular file");
    expect(readFileSync(`${target}/target`, "utf8")).toBe("safe");
    rmSync(item.eventLogPath);
    mkdirSync(item.eventLogPath);
    expect(() => runCodex(item)).toThrow("destination must be absent or a regular file");
  });

  it("rejects a symlinked parent and a POSIX FIFO without blocking", () => {
    const item = codexFixture();
    const real = join(item.workspace, "real");
    mkdirSync(real);
    symlinkSync(real, join(item.workspace, "linked"));
    item.eventLogPath = join(item.workspace, "linked", "events.jsonl");
    expect(() => runCodex(item)).toThrow("non-symlink directories");
    if (process.platform !== "win32") {
      const fifo = codexFixture();
      expect(spawnSync("mkfifo", [fifo.eventLogPath]).status).toBe(0);
      expect(() => runCodex(fifo)).toThrow("destination must be absent or a regular file");
    }
  });

  it("does not expose an event-log temp to the provider", () => {
    const item = codexFixture({ probeTemps: true });
    runCodex(item);
    expect(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8")).toBe("[]");
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("INJECTED");
  });

  it("does not follow a provider-created final symlink", () => {
    const item = codexFixture({ swapDestination: true });
    expect(() => runCodex(item)).toThrow("destination must be absent or a regular file");
    expect(readFileSync(item.outside, "utf8")).toBe("outside");
    expect(lstatSync(item.eventLogPath).isSymbolicLink()).toBe(true);
  });
});

describe("OpenCode event-log reservation", () => {
  it("uses the same private replacement contract", () => {
    const item = openCodeFixture();
    const result = runOpenCode(item);
    expect(result.artifact).toEqual({ ok: true });
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    assertNoTemps(item);
  });

  it("removes its private runtime when event-log reservation is rejected", () => {
    const item = openCodeFixture();
    const runtimeRoots = () =>
      readdirSync(item.workspace).filter(
        (name) => name.startsWith("rae-opencode-") && !name.startsWith("rae-opencode-test-"),
      );
    const before = new Set(runtimeRoots());
    item.eventLogPath = join(root(), "outside.events.jsonl");
    withRuntimeTempRoot(item.workspace, () => {
      expect(() => runOpenCode(item)).toThrow(
        "event log path must be a file below the authorized workspace root",
      );
    });
    const after = runtimeRoots();
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  it("replaces existing content and preserves it on provider or parse failure", () => {
    const item = openCodeFixture();
    writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
    runOpenCode(item);
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("old");
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    const malformed = openCodeFixture({ events: "not-json\n" });
    writeFileSync(malformed.eventLogPath, "old", "utf8");
    expect(() => runOpenCode(malformed)).toThrow("invalid at line 1");
    expect(readFileSync(malformed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(malformed);
    const failed = openCodeFixture({ status: 7 });
    writeFileSync(failed.eventLogPath, "old", "utf8");
    expect(() => runOpenCode(failed)).toThrow("OpenCode phase exited with status 7");
    expect(readFileSync(failed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(failed);
  });

  it("rejects unsafe initial destinations and symlinked parents", () => {
    const target = root();
    const item = openCodeFixture();
    writeFileSync(join(target, "target"), "safe", "utf8");
    symlinkSync(join(target, "target"), item.eventLogPath);
    expect(() => runOpenCode(item)).toThrow("destination must be absent or a regular file");
    expect(readFileSync(join(target, "target"), "utf8")).toBe("safe");
    rmSync(item.eventLogPath);
    mkdirSync(item.eventLogPath);
    expect(() => runOpenCode(item)).toThrow("destination must be absent or a regular file");
    if (process.platform !== "win32") {
      const fifo = openCodeFixture();
      expect(spawnSync("mkfifo", [fifo.eventLogPath]).status).toBe(0);
      expect(() => runOpenCode(fifo)).toThrow("destination must be absent or a regular file");
    }
    const linked = openCodeFixture();
    mkdirSync(join(linked.workspace, "real"));
    symlinkSync(join(linked.workspace, "real"), join(linked.workspace, "linked"));
    linked.eventLogPath = join(linked.workspace, "linked", "events.jsonl");
    expect(() => runOpenCode(linked)).toThrow("non-symlink directories");
  });

  it("does not expose an event-log temp to the provider", () => {
    const item = openCodeFixture({ probeTemps: true });
    runOpenCode(item);
    expect(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8")).toBe("[]");
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("INJECTED");
  });

  it("does not follow a provider-created final symlink", () => {
    const swappedDestination = openCodeFixture({ swapDestination: true });
    expect(() => runOpenCode(swappedDestination)).toThrow(
      "destination must be absent or a regular file",
    );
    expect(readFileSync(swappedDestination.outside, "utf8")).toBe("outside");
    expect(lstatSync(swappedDestination.eventLogPath).isSymbolicLink()).toBe(true);
  });
});
