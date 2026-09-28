/** Exercises fail-closed event-log replacement through both provider entry points. */
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
import { afterEach, describe, expect, it } from "vitest";
import { runAgentPhase } from "../../agents/agent-executor.js";
import { runOpenCodePhase } from "../../agents/opencode-adapter.js";
import type { AgentExecutionResult } from "../../agents/agent-executor.js";

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
  expect(
    readdirSync(item.workspace).filter(
      (name) => name.includes("events.jsonl.") && name.endsWith(".tmp"),
    ),
  ).toEqual([]);
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

describe("Codex event-log reservation", () => {
  it("creates a private replacement for an absent destination without residue", async () => {
    const item = codexFixture();
    await runCodex(item);
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    assertNoTemps(item);
  });

  it("replaces rather than appends an existing file and preserves it on provider or parse failure", async () => {
    const item = codexFixture();
    writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
    await runCodex(item);
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("old");
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    const malformed = codexFixture({ events: "not-json\n" });
    writeFileSync(malformed.eventLogPath, "old", "utf8");
    await expect(runCodex(malformed)).rejects.toThrow("event stream is invalid");
    expect(readFileSync(malformed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(malformed);
  });

  it("rejects unsafe initial destinations without mutation", async () => {
    const target = root();
    const item = codexFixture();
    writeFileSync(`${target}/target`, "safe", "utf8");
    symlinkSync(`${target}/target`, item.eventLogPath);
    await expect(runCodex(item)).rejects.toThrow("destination must be absent or a regular file");
    expect(readFileSync(`${target}/target`, "utf8")).toBe("safe");
    rmSync(item.eventLogPath);
    mkdirSync(item.eventLogPath);
    await expect(runCodex(item)).rejects.toThrow("destination must be absent or a regular file");
  });

  it("rejects a symlinked parent and a POSIX FIFO without blocking", async () => {
    const item = codexFixture();
    const real = join(item.workspace, "real");
    mkdirSync(real);
    symlinkSync(real, join(item.workspace, "linked"));
    item.eventLogPath = join(item.workspace, "linked", "events.jsonl");
    await expect(runCodex(item)).rejects.toThrow("non-symlink directories");
    if (process.platform !== "win32") {
      const fifo = codexFixture();
      expect(spawnSync("mkfifo", [fifo.eventLogPath]).status).toBe(0);
      await expect(runCodex(fifo)).rejects.toThrow("destination must be absent or a regular file");
    }
  });

  it("does not expose an event-log temp to the provider", async () => {
    const item = codexFixture({ probeTemps: true });
    await runCodex(item);
    expect(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8")).toBe("[]");
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("INJECTED");
  });

  it("does not follow a provider-created final symlink", async () => {
    const item = codexFixture({ swapDestination: true });
    await expect(runCodex(item)).rejects.toThrow("destination must be absent or a regular file");
    expect(readFileSync(item.outside, "utf8")).toBe("outside");
    expect(lstatSync(item.eventLogPath).isSymbolicLink()).toBe(true);
  });
});

describe("OpenCode event-log reservation", () => {
  it("uses the same private replacement contract", async () => {
    const item = openCodeFixture();
    const result = await runOpenCode(item);
    expect(result.artifact).toEqual({ ok: true });
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    assertNoTemps(item);
  });

  it("removes its private runtime when event-log reservation is rejected", async () => {
    const item = openCodeFixture();
    const runtimeRoots = () =>
      readdirSync(item.workspace).filter(
        (name) => name.startsWith("rae-opencode-") && !name.startsWith("rae-opencode-test-"),
      );
    const before = new Set(runtimeRoots());
    item.eventLogPath = join(root(), "outside.events.jsonl");
    await withRuntimeTempRoot(item.workspace, async () => {
      await expect(runOpenCode(item)).rejects.toThrow(
        "event log path must be a file below the authorized workspace root",
      );
    });
    const after = runtimeRoots();
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });

  it("replaces existing content and preserves it on provider or parse failure", async () => {
    const item = openCodeFixture();
    writeFileSync(item.eventLogPath, "old", { mode: 0o644 });
    await runOpenCode(item);
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("old");
    expect(lstatSync(item.eventLogPath).mode & 0o777).toBe(0o600);
    const malformed = openCodeFixture({ events: "not-json\n" });
    writeFileSync(malformed.eventLogPath, "old", "utf8");
    await expect(runOpenCode(malformed)).rejects.toThrow("invalid at line 1");
    expect(readFileSync(malformed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(malformed);
    const failed = openCodeFixture({ status: 7 });
    writeFileSync(failed.eventLogPath, "old", "utf8");
    await expect(runOpenCode(failed)).rejects.toThrow("OpenCode phase exited with status 7");
    expect(readFileSync(failed.eventLogPath, "utf8")).toBe("old");
    assertNoTemps(failed);
  });

  it("rejects unsafe initial destinations and symlinked parents", async () => {
    const target = root();
    const item = openCodeFixture();
    writeFileSync(join(target, "target"), "safe", "utf8");
    symlinkSync(join(target, "target"), item.eventLogPath);
    await expect(runOpenCode(item)).rejects.toThrow("destination must be absent or a regular file");
    expect(readFileSync(join(target, "target"), "utf8")).toBe("safe");
    rmSync(item.eventLogPath);
    mkdirSync(item.eventLogPath);
    await expect(runOpenCode(item)).rejects.toThrow("destination must be absent or a regular file");
    if (process.platform !== "win32") {
      const fifo = openCodeFixture();
      expect(spawnSync("mkfifo", [fifo.eventLogPath]).status).toBe(0);
      await expect(runOpenCode(fifo)).rejects.toThrow(
        "destination must be absent or a regular file",
      );
    }
    const linked = openCodeFixture();
    mkdirSync(join(linked.workspace, "real"));
    symlinkSync(join(linked.workspace, "real"), join(linked.workspace, "linked"));
    linked.eventLogPath = join(linked.workspace, "linked", "events.jsonl");
    await expect(runOpenCode(linked)).rejects.toThrow("non-symlink directories");
  });

  it("does not expose an event-log temp to the provider", async () => {
    const item = openCodeFixture({ probeTemps: true });
    await runOpenCode(item);
    expect(readFileSync(join(item.workspace, "provider-temp-probe.json"), "utf8")).toBe("[]");
    expect(readFileSync(item.eventLogPath, "utf8")).not.toContain("INJECTED");
  });

  it("does not follow a provider-created final symlink", async () => {
    const swappedDestination = openCodeFixture({ swapDestination: true });
    await expect(runOpenCode(swappedDestination)).rejects.toThrow(
      "destination must be absent or a regular file",
    );
    expect(readFileSync(swappedDestination.outside, "utf8")).toBe("outside");
    expect(lstatSync(swappedDestination.eventLogPath).isSymbolicLink()).toBe(true);
  });
});
