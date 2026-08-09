/** Exercises the OpenCode adapter with fake provider and sandbox executables. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  _test,
  openCodeDoctor,
  opencodeSandboxProfile,
  runOpenCodePhase,
} from "../lib/opencode-adapter.mjs";

const roots = [];

function executable(root, name, body) {
  const pathValue = resolve(root, name);
  writeFileSync(pathValue, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  chmodSync(pathValue, 0o700);
  return pathValue;
}

function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-opencode-test-")));
  roots.push(root);
  const workspace = resolve(root, "workspace");
  const events = resolve(root, "events.jsonl");
  mkdirSync(workspace);
  executable(
    root,
    "opencode",
    `const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.18.11"); process.exit(0); }
if (args.includes("debug") && args.includes("config")) { console.log(process.env.OPENCODE_CONFIG_CONTENT); process.exit(0); }
if (!args.includes("--pure") || !args.includes("--format") || !args.includes("json") || !args.includes("--dir") || !args.includes("--model")) process.exit(31);
const model = args[args.indexOf("--model") + 1];
console.log(JSON.stringify({ type: "step_start", timestamp: 1, part: { type: "step-start" } }));
console.log(JSON.stringify({ type: "text", timestamp: 2, part: { type: "text", text: JSON.stringify({ ok: true, model }) } }));`,
  );
  const sandbox = executable(
    root,
    "sandbox-wrapper",
    `const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2); const child = spawnSync(args[2], args.slice(3), { cwd: process.cwd(), env: process.env, input: require("node:fs").readFileSync(0), encoding: "utf8" });
process.stdout.write(child.stdout || ""); process.stderr.write(child.stderr || ""); process.exit(child.status ?? 1);`,
  );
  return {
    root,
    workspace,
    events,
    sandbox,
    env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH ?? ""}`, HOME: root },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode adapter", () => {
  test("uses explicit pure JSON execution and persists only normalized events", () => {
    const item = fixture();
    const result = runOpenCodePhase({
      platform: "darwin",
      allowTestSandbox: true,
      sandboxExecutable: item.sandbox,
      workspaceRoot: item.workspace,
      sourceRoot: item.workspace,
      sandboxMode: "read-only",
      model: "openrouter/example",
      variant: "high",
      runId: "run-1",
      phase: "inspect",
      prompt: "Return JSON.",
      eventLogPath: item.events,
      timeoutMs: 5_000,
      env: item.env,
    });
    expect(result.artifact).toEqual({ ok: true, model: "openrouter/example" });
    expect(result.executorVersion).toBe("1.18.11");
    expect(result.capabilitySurface).toMatchObject({
      edit: false,
      shell: false,
      web: false,
      external_directory: false,
      subagents: false,
      plugins: false,
    });
    const persisted = readFileSync(item.events, "utf8");
    expect(persisted).not.toContain("Return JSON");
    expect(persisted).not.toContain("openrouter/example");
    expect(persisted).toContain('"text_bytes"');
  });

  test("doctor verifies the exact merged permission and MCP surface", () => {
    const item = fixture();
    expect(
      openCodeDoctor({
        platform: "darwin",
        allowTestSandbox: true,
        sandboxExecutable: item.sandbox,
        workspaceRoot: item.workspace,
        sandboxMode: "read-only",
        model: "opencode/example",
        timeoutMs: 5_000,
        env: item.env,
      }),
    ).toMatchObject({ success: true, provider: "opencode", sandbox_enforced: true });
  });

  test("write routes reject source-checkout and in-place execution before launch", () => {
    const item = fixture();
    const common = {
      platform: "darwin",
      workspaceRoot: item.workspace,
      sourceRoot: item.workspace,
      sandboxMode: "workspace-write",
      model: "opencode/example",
      env: item.env,
    };
    expect(() => runOpenCodePhase(common)).toThrow(/isolated RAE worktree/);
    expect(() => runOpenCodePhase({ ...common, sourceRoot: item.root, inPlace: true })).toThrow(
      /reject --in-place/,
    );
  });

  test("rejects malformed, multiple, and terminal-error event streams", () => {
    const item = fixture();
    expect(() => _test.parseEvents("not-json", item.events)).toThrow(/invalid at line 1/);
    const text = JSON.stringify({ type: "text", part: { text: "{}" } });
    expect(() => _test.parseEvents(`${text}\n${text}`, item.events)).toThrow(/exactly one/);
    expect(() =>
      _test.parseEvents(JSON.stringify({ type: "error", part: {} }), item.events),
    ).toThrow(/terminal error/);
  });

  test("Seatbelt policy defaults to denial and protects runtime and Git state", () => {
    const item = fixture();
    const runtime = resolve(item.root, "runtime");
    const runDir = resolve(item.workspace, ".pipeline/runs/run-1");
    mkdirSync(runtime);
    const profile = opencodeSandboxProfile({
      workspaceRoot: item.workspace,
      sourceRoot: item.root,
      runDir,
      runtimeRoot: runtime,
      executable: resolve(item.root, "opencode"),
      sandboxMode: "workspace-write",
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(allow file-write* (subpath "${item.workspace}"))`);
    expect(profile).toContain(
      `(deny file-read* file-write* (literal "${resolve(item.workspace, ".git")}")`,
    );
    expect(profile).toContain(`(deny file-read* file-write* (literal "${runDir}")`);
    expect(profile).toContain("(deny network-inbound)");
  });

  const containmentTest = process.platform === "darwin" ? test : test.skip;
  containmentTest("macOS Seatbelt enforces read, write, external, and runtime boundaries", () => {
    const item = fixture();
    const runtime = resolve(item.root, "runtime");
    const external = resolve(item.root, "external.txt");
    const pipeline = resolve(item.workspace, ".pipeline");
    mkdirSync(runtime);
    mkdirSync(pipeline);
    writeFileSync(external, "outside\n");
    writeFileSync(resolve(pipeline, "guard"), "guard\n");
    const attempt = (sandboxMode, target) => {
      const profile = opencodeSandboxProfile({
        workspaceRoot: item.workspace,
        sourceRoot: item.root,
        runDir: pipeline,
        runtimeRoot: runtime,
        executable: "/bin/bash",
        sandboxMode,
      });
      return spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", profile, "/bin/bash", "-c", `printf changed > ${JSON.stringify(target)}`],
        { encoding: "utf8" },
      ).status;
    };
    expect(attempt("read-only", resolve(item.workspace, "read-denied"))).not.toBe(0);
    expect(attempt("workspace-write", resolve(item.workspace, "allowed"))).toBe(0);
    expect(existsSync(resolve(item.workspace, "allowed"))).toBe(true);
    expect(attempt("workspace-write", external)).not.toBe(0);
    expect(readFileSync(external, "utf8")).toBe("outside\n");
    expect(attempt("workspace-write", resolve(pipeline, "guard"))).not.toBe(0);
    expect(readFileSync(resolve(pipeline, "guard"), "utf8")).toBe("guard\n");
  });
});
