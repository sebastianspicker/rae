/** Exercises the OpenCode adapter with fake provider and sandbox executables. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
import * as opencodeFacade from "../lib/opencode-adapter.mjs";
import * as opencodePolicy from "../lib/opencode-policy.mjs";

const roots = [];

function executable(root, name, body) {
  const pathValue = resolve(root, name);
  writeFileSync(pathValue, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  chmodSync(pathValue, 0o700);
  return pathValue;
}

function fixture({
  configMutation = "",
  phaseEvents = null,
  phaseStatus = 0,
  phaseStderr = "",
} = {}) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "rae-opencode-test-")));
  roots.push(root);
  const workspace = resolve(root, "workspace");
  const events = resolve(workspace, "events.jsonl");
  const stream =
    phaseEvents ??
    `${JSON.stringify({ type: "step_start", timestamp: 1, part: { type: "step-start" } })}\n${JSON.stringify({ type: "text", timestamp: 2, part: { type: "text", text: JSON.stringify({ ok: true, model: "openrouter/example" }) } })}\n`;
  mkdirSync(workspace);
  executable(
    root,
    "opencode",
    `const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.18.11"); process.exit(0); }
if (args.includes("debug") && args.includes("config")) { const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); ${configMutation}; console.log(JSON.stringify(config)); process.exit(0); }
if (!args.includes("--pure") || !args.includes("--format") || !args.includes("json") || !args.includes("--dir") || !args.includes("--model")) process.exit(31);
process.stderr.write(${JSON.stringify(phaseStderr)});
process.stdout.write(${JSON.stringify(stream)});
process.exit(${phaseStatus});`,
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

function phaseOptions(item, overrides = {}) {
  return {
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
    ...overrides,
  };
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode adapter", () => {
  test("exports only the documented facade surface", () => {
    expect(Object.keys(opencodeFacade).sort()).toEqual([
      "_test",
      "openCodeDoctor",
      "opencodeSandboxProfile",
      "opencodeVersion",
      "runOpenCodePhase",
    ]);
  });

  test("exports only the documented OpenCode policy surface", () => {
    expect(Object.keys(opencodePolicy).sort()).toEqual([
      "BROKER_PATH",
      "assertEffectiveConfiguration",
      "assertNoProjectExtensions",
      "inlineConfig",
      "permissionSurface",
      "safeChildEnvironment",
      "verificationCatalog",
    ]);
  });

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

  test("doctor rejects same-name MCP mutations", () => {
    const mutations = [
      `config.mcp["rae-verification"].type = "remote"`,
      `config.mcp["rae-verification"].command = ["node"]`,
      `config.mcp["rae-verification"].command[2] = "--unapproved"`,
      `config.mcp["rae-verification"].enabled = false`,
      `config.mcp["rae-verification"].extra = true`,
    ];
    for (const configMutation of mutations) {
      const item = fixture({ configMutation });
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
      ).toMatchObject({
        success: false,
        detail: "effective OpenCode MCP surface contains an unapproved server",
      });
    }
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

  test("replaces the normalized event log before rejecting an invalid final artifact", () => {
    const item = fixture({
      phaseEvents: `${JSON.stringify({ type: "text", part: { type: "text", text: "not-json" } })}\n`,
    });
    writeFileSync(item.events, "old\n", "utf8");
    expect(() => runOpenCodePhase(phaseOptions(item))).toThrow(
      "OpenCode returned invalid final JSON",
    );
    const persisted = readFileSync(item.events, "utf8");
    expect(persisted).not.toContain("old");
    expect(persisted).toContain('"text_bytes"');
  });

  test("redacts flag and GitHub credentials in provider failure output", () => {
    const flagSecret = "flag-secret-value";
    const githubToken = "ghp_12345678901234567890";
    const item = fixture({
      phaseStatus: 7,
      phaseStderr: `--token ${flagSecret} ${githubToken}`,
    });
    let failure;
    try {
      runOpenCodePhase(phaseOptions(item));
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).not.toContain(flagSecret);
    expect(failure?.message).not.toContain(githubToken);
  });

  test("redacts a flag-scoped GitHub credential before applying the failure tail limit", () => {
    const githubToken = `ghp_${"a".repeat(4100)}`;
    const retainedSuffix = "a".repeat(128);
    const item = fixture({
      phaseStatus: 7,
      phaseStderr: `--token ${githubToken}`,
    });
    let failure;
    try {
      runOpenCodePhase(phaseOptions(item));
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain("[REDACTED]");
    expect(failure?.message).not.toContain(retainedSuffix);
  });

  test("cleans failed auth-symlink runtime setup for run and doctor", () => {
    const item = fixture();
    const authTarget = resolve(item.root, "auth-target.json");
    const authLink = resolve(item.root, "auth-link.json");
    writeFileSync(authTarget, "{}\n", "utf8");
    symlinkSync(authTarget, authLink);
    const before = new Set(
      readdirSync(item.root).filter((name) => name.startsWith("rae-opencode-")),
    );
    withRuntimeTempRoot(item.root, () => {
      expect(() => runOpenCodePhase(phaseOptions(item, { authPath: authLink }))).toThrow(
        "OpenCode auth store must be a regular non-symlink file",
      );
      expect(
        openCodeDoctor({
          platform: "darwin",
          allowTestSandbox: true,
          sandboxExecutable: item.sandbox,
          workspaceRoot: item.workspace,
          sandboxMode: "read-only",
          model: "opencode/example",
          authPath: authLink,
          timeoutMs: 5_000,
          env: item.env,
        }),
      ).toMatchObject({
        success: false,
        detail: "OpenCode auth store must be a regular non-symlink file",
      });
    });
    expect(
      readdirSync(item.root).filter(
        (name) => name.startsWith("rae-opencode-") && !before.has(name),
      ),
    ).toEqual([]);
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
