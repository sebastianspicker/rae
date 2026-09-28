/** Exercises fail-closed event-log replacement through both provider entry points. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAgentPhase } from "../src/agents/agent-executor.js";
import { runOpenCodePhase } from "../src/agents/opencode-adapter.js";
import type { AgentExecutionResult } from "../src/agents/agent-executor.js";

const roots: string[] = [];
interface ProviderFixture {
  workspace: string;
  outside: string;
  eventLogPath: string;
  env: NodeJS.ProcessEnv;
  sandbox?: string;
}

function root(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), "rae-event-log-security-")));
  roots.push(value);
  return value;
}

function codexFixture({
  events = '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":1,"output_tokens":1,"reasoning_output_tokens":1}}\n',
  status = 0,
  swapDestination = false,
  probeTemps = false,
}: {
  events?: string;
  status?: number;
  swapDestination?: boolean;
  probeTemps?: boolean;
} = {}): ProviderFixture {
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

function runCodex(item: ProviderFixture): Promise<AgentExecutionResult> {
  return runAgentPhase({
    provider: "codex",
    phase: "test",
    runId: "test-run",
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

function assertNoTemps(item: ProviderFixture): void {
  assert.deepEqual(
    readdirSync(item.workspace).filter(
      (name) => name.includes("events.jsonl.") && name.endsWith(".tmp"),
    ),
    [],
  );
}

async function withRuntimeTempRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return await action();
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
}: {
  events?: string;
  status?: number;
  swapDestination?: boolean;
  probeTemps?: boolean;
} = {}): ProviderFixture & { sandbox: string } {
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

function runOpenCode(
  item: ProviderFixture & { sandbox: string },
): Promise<Record<string, unknown>> {
  return runOpenCodePhase({
    platform: "darwin" as const,
    allowTestSandbox: true,
    sandboxExecutable: item.sandbox,
    workspaceRoot: item.workspace,
    sourceRoot: join(item.workspace, "source"),
    sandboxMode: "read-only",
    model: "openrouter/example",
    phase: "test",
    eventLogPath: item.eventLogPath,
    prompt: "fixture",
    env: item.env,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("Codex event-log reservation creates a private replacement for an absent destination without residue", async () => {
  const item = codexFixture();
  await runCodex(item);
  assert.equal(lstatSync(item.eventLogPath).mode & 0o777, 0o600);
  assertNoTemps(item);
});

test("Codex event-log reservation replaces rather than appends an existing file and preserves it on provider or parse failure", async () => {
  const item = codexFixture();
  writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
  await runCodex(item);
  assert.equal(readFileSync(item.eventLogPath, "utf8").includes("old"), false);
  assert.equal(lstatSync(item.eventLogPath).mode & 0o777, 0o600);
  const malformed = codexFixture({ events: "not-json\n" });
  writeFileSync(malformed.eventLogPath, "old", "utf8");
  await assert.rejects(runCodex(malformed), /event stream is invalid/);
  assert.equal(readFileSync(malformed.eventLogPath, "utf8"), "old");
  assertNoTemps(malformed);
});

test("Codex event-log reservation rejects unsafe initial destinations without mutation", async () => {
  const target = root();
  const item = codexFixture();
  writeFileSync(`${target}/target`, "safe", "utf8");
  symlinkSync(`${target}/target`, item.eventLogPath);
  await assert.rejects(runCodex(item), /destination must be absent or a regular file/);
  assert.equal(readFileSync(`${target}/target`, "utf8"), "safe");
  rmSync(item.eventLogPath);
  mkdirSync(item.eventLogPath);
  await assert.rejects(runCodex(item), /destination must be absent or a regular file/);
});

test("Codex event-log reservation rejects a symlinked parent and a POSIX FIFO without blocking", async () => {
  const item = codexFixture();
  const real = join(item.workspace, "real");
  mkdirSync(real);
  symlinkSync(real, join(item.workspace, "linked"));
  item.eventLogPath = join(item.workspace, "linked", "events.jsonl");
  await assert.rejects(runCodex(item), /non-symlink directories/);
  if (process.platform !== "win32") {
    const fifo = codexFixture();
    assert.equal(spawnSync("mkfifo", [fifo.eventLogPath]).status, 0);
    await assert.rejects(runCodex(fifo), /destination must be absent or a regular file/);
  }
});

test("Codex event-log reservation does not expose an event-log temp to the provider", async () => {
  const item = codexFixture({ probeTemps: true });
  await runCodex(item);
  assert.equal(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8"), "[]");
  assert.equal(readFileSync(item.eventLogPath, "utf8").includes("INJECTED"), false);
});

test("Codex event-log reservation does not follow a provider-created final symlink", async () => {
  const item = codexFixture({ swapDestination: true });
  await assert.rejects(runCodex(item), /destination must be absent or a regular file/);
  assert.equal(readFileSync(item.outside, "utf8"), "outside");
  assert.equal(lstatSync(item.eventLogPath).isSymbolicLink(), true);
});

test("OpenCode event-log reservation uses the same private replacement contract", async () => {
  const item = openCodeFixture();
  const result = await runOpenCode(item);
  assert.deepEqual(result.artifact, { ok: true });
  assert.equal(lstatSync(item.eventLogPath).mode & 0o777, 0o600);
  assertNoTemps(item);
});

test("OpenCode event-log reservation removes its private runtime when event-log reservation is rejected", async () => {
  const item = openCodeFixture();
  const runtimeRoots = () =>
    readdirSync(item.workspace).filter(
      (name) => name.startsWith("rae-opencode-") && !name.startsWith("rae-opencode-test-"),
    );
  const before = new Set(runtimeRoots());
  item.eventLogPath = join(root(), "outside.events.jsonl");
  await withRuntimeTempRoot(item.workspace, async () => {
    await assert.rejects(
      runOpenCode(item),
      /event log path must be a file below the authorized workspace root/,
    );
  });
  const after = runtimeRoots();
  assert.deepEqual(
    after.filter((name) => !before.has(name)),
    [],
  );
});

test("OpenCode event-log reservation replaces existing content and preserves it on provider or parse failure", async () => {
  const item = openCodeFixture();
  writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
  await runOpenCode(item);
  assert.equal(readFileSync(item.eventLogPath, "utf8").includes("old"), false);
  assert.equal(lstatSync(item.eventLogPath).mode & 0o777, 0o600);
  const malformed = openCodeFixture({ events: "not-json\n" });
  writeFileSync(malformed.eventLogPath, "old", "utf8");
  await assert.rejects(runOpenCode(malformed), /invalid at line 1/);
  assert.equal(readFileSync(malformed.eventLogPath, "utf8"), "old");
  assertNoTemps(malformed);
  const failed = openCodeFixture({ status: 7 });
  writeFileSync(failed.eventLogPath, "old", "utf8");
  await assert.rejects(runOpenCode(failed), /OpenCode phase exited with status 7/);
  assert.equal(readFileSync(failed.eventLogPath, "utf8"), "old");
  assertNoTemps(failed);
});

test("OpenCode event-log reservation rejects unsafe initial destinations and symlinked parents", async () => {
  const target = root();
  const item = openCodeFixture();
  writeFileSync(join(target, "target"), "safe", "utf8");
  symlinkSync(join(target, "target"), item.eventLogPath);
  await assert.rejects(runOpenCode(item), /destination must be absent or a regular file/);
  assert.equal(readFileSync(join(target, "target"), "utf8"), "safe");
  rmSync(item.eventLogPath);
  mkdirSync(item.eventLogPath);
  await assert.rejects(runOpenCode(item), /destination must be absent or a regular file/);
  if (process.platform !== "win32") {
    const fifo = openCodeFixture();
    assert.equal(spawnSync("mkfifo", [fifo.eventLogPath]).status, 0);
    await assert.rejects(runOpenCode(fifo), /destination must be absent or a regular file/);
  }
  const linked = openCodeFixture();
  mkdirSync(join(linked.workspace, "real"));
  symlinkSync(join(linked.workspace, "real"), join(linked.workspace, "linked"));
  linked.eventLogPath = join(linked.workspace, "linked", "events.jsonl");
  await assert.rejects(runOpenCode(linked), /non-symlink directories/);
});

test("OpenCode event-log reservation does not expose an event-log temp to the provider", async () => {
  const item = openCodeFixture({ probeTemps: true });
  await runOpenCode(item);
  assert.equal(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8"), "[]");
  assert.equal(readFileSync(item.eventLogPath, "utf8").includes("INJECTED"), false);
});

test("OpenCode event-log reservation does not follow a provider-created final symlink", async () => {
  const swappedDestination = openCodeFixture({ swapDestination: true });
  await assert.rejects(
    runOpenCode(swappedDestination),
    /destination must be absent or a regular file/,
  );
  assert.equal(readFileSync(swappedDestination.outside, "utf8"), "outside");
  assert.equal(lstatSync(swappedDestination.eventLogPath).isSymbolicLink(), true);
});
