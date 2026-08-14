/**
 * Pins subprocess failure conversion and sandbox enforcement so skill-tool callers receive stable diagnostics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPackageRoot } from "../lib/state.mjs";

// We test spawnSkillTool by mocking child_process.spawnSync
// and fs.existsSync to control subprocess behavior.

let spawnSyncMock;
let entrypointExists = true;

// vi.mock calls must be hoisted to module top level.
vi.mock("node:child_process", () => ({
  spawnSync: (...args) => spawnSyncMock(...args),
}));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    existsSync: (p) => {
      if (typeof p === "string" && p.includes("dist/index.js")) return entrypointExists;
      return orig.existsSync(p);
    },
  };
});

describe("spawnSkillTool", () => {
  let spawnSkillTool;
  let spawnArgs;
  const toolOpts = {
    entrypoint: "skills/dev-tools/quality-gate/dist/index.js",
    input: { test: true },
    toolName: "quality-gate",
  };

  beforeEach(async () => {
    entrypointExists = true;
    const mod = await import("../lib/subprocess.mjs");
    spawnSkillTool = mod.spawnSkillTool;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function successfulProcess(data = { result: "ok" }) {
    return {
      stdout: JSON.stringify({ success: true, data }),
      stderr: "",
      status: 0,
      signal: null,
      error: null,
    };
  }

  function toolFailure({ status = 1, success = false, error } = {}) {
    return {
      stdout: JSON.stringify({ success, ...(error === undefined ? {} : { error }) }),
      stderr: "",
      status,
      signal: null,
      error: null,
    };
  }

  function expectToolError(call, { code, message, outerCode } = {}) {
    try {
      call();
      expect.unreachable("should have thrown");
    } catch (err) {
      if (code !== undefined) expect(err.code).toBe(code);
      if (message !== undefined) expect(err.message).toBe(message);
      if (outerCode !== undefined) expect(err.outerCode).toBe(outerCode);
      return err;
    }
  }

  it("preserves the exact Node launch contract and input", () => {
    const originalWorkspace = process.env.WORKSPACE_ROOT;
    const originalToolRoot = process.env.RAE_TOOL_ROOT;
    const originalSentinel = process.env.PIPELINE_SUBPROCESS_SENTINEL;
    try {
      process.env.PIPELINE_SUBPROCESS_SENTINEL = "retained";
      process.env.WORKSPACE_ROOT = "/inherited/workspace";
      process.env.RAE_TOOL_ROOT = "/inherited/tool-root";
      spawnSyncMock = (...args) => {
        spawnArgs = args;
        return successfulProcess();
      };

      const input = { test: true, nested: { stable: true } };
      const result = spawnSkillTool({
        ...toolOpts,
        input,
        root: "/tmp/rae-target-workspace",
        timeoutMs: 1234,
      });
      expect(result).toEqual({ result: "ok" });
      expect(spawnArgs[0]).toBe(process.execPath);
      expect(spawnArgs[1]).toEqual([
        expect.stringMatching(
          /packages\/orchestration\/skills\/dev-tools\/quality-gate\/dist\/index\.js$/,
        ),
      ]);
      expect(spawnArgs[2].cwd).toMatch(/packages\/orchestration$/);
      expect(spawnArgs[2]).toMatchObject({
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 1234,
        cwd: expect.stringMatching(/packages\/orchestration$/),
      });
      expect(spawnArgs[2].shell).toBeUndefined();
      expect(spawnArgs[2].env.PIPELINE_SUBPROCESS_SENTINEL).toBe("retained");
      expect(spawnArgs[2].env.WORKSPACE_ROOT).toBe("/tmp/rae-target-workspace");
      expect(spawnArgs[2].env.RAE_TOOL_ROOT).toMatch(/packages\/orchestration$/);
      expect(input).toEqual({ test: true, nested: { stable: true } });
    } finally {
      if (originalWorkspace === undefined) delete process.env.WORKSPACE_ROOT;
      else process.env.WORKSPACE_ROOT = originalWorkspace;
      if (originalToolRoot === undefined) delete process.env.RAE_TOOL_ROOT;
      else process.env.RAE_TOOL_ROOT = originalToolRoot;
      if (originalSentinel === undefined) delete process.env.PIPELINE_SUBPROCESS_SENTINEL;
      else process.env.PIPELINE_SUBPROCESS_SENTINEL = originalSentinel;
    }
  });

  it("uses package-root workspace and the default timeout", () => {
    spawnSyncMock = (...args) => {
      spawnArgs = args;
      return successfulProcess();
    };

    spawnSkillTool(toolOpts);
    const packageRoot = getPackageRoot();
    expect(spawnArgs[2]).toMatchObject({
      cwd: packageRoot,
      timeout: 30_000,
      env: { WORKSPACE_ROOT: packageRoot, RAE_TOOL_ROOT: packageRoot },
    });
  });

  it("runs the packaged tool while exposing a separate target workspace", () => {
    spawnSyncMock = (...args) => {
      spawnArgs = args;
      return successfulProcess();
    };

    spawnSkillTool({ ...toolOpts, root: "/tmp/rae-target-workspace" });
    expect(spawnArgs[1][0]).toMatch(/packages\/orchestration\/skills\//);
    expect(spawnArgs[2].cwd).toMatch(/packages\/orchestration$/);
    expect(spawnArgs[2].env.WORKSPACE_ROOT).toBe("/tmp/rae-target-workspace");
    expect(spawnArgs[2].env.RAE_TOOL_ROOT).toMatch(/packages\/orchestration$/);
  });

  it("throws on timeout with clear message", () => {
    spawnSyncMock = () => ({
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/timed out/i);
    try {
      spawnSkillTool(toolOpts);
    } catch (err) {
      expect(err.code).toBe("E_QUALITY_GATE_TIMEOUT");
    }
  });

  it("throws on signal termination with signal name", () => {
    spawnSyncMock = () => ({
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGKILL",
      error: null,
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/SIGKILL/);
    try {
      spawnSkillTool(toolOpts);
    } catch (err) {
      expect(err.code).toBe("E_QUALITY_GATE_SIGNAL");
    }
  });

  it("throws on spawn error with spawn code", () => {
    spawnSyncMock = () => ({
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/failed to spawn/i);
    try {
      spawnSkillTool(toolOpts);
    } catch (err) {
      expect(err.code).toBe("E_QUALITY_GATE_SPAWN");
    }
  });

  it("does not spawn when the entrypoint is missing", () => {
    entrypointExists = false;
    spawnSyncMock = vi.fn();

    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_MISSING",
      message:
        "quality-gate dist entrypoint missing. Run npm run build in skills/dev-tools/quality-gate.",
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses error, then signal, then output failure precedence", () => {
    spawnSyncMock = () => ({
      ...successfulProcess(),
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      signal: "SIGTERM",
    });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_SPAWN",
      message: "quality-gate failed to spawn: ENOENT",
    });

    spawnSyncMock = () => ({ ...successfulProcess(), signal: "SIGTERM" });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_SIGNAL",
      message: "quality-gate killed by signal SIGTERM",
    });
  });

  it("throws on empty output", () => {
    spawnSyncMock = () => ({
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
      error: null,
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/empty output/i);
  });

  it("throws on invalid JSON output", () => {
    spawnSyncMock = () => ({
      stdout: "not json",
      stderr: "",
      status: 0,
      signal: null,
      error: null,
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/invalid JSON/i);
  });

  it("selects non-whitespace stdout before stderr and otherwise falls back to stderr", () => {
    spawnSyncMock = () => ({
      ...successfulProcess(),
      stdout: " \n\t",
      stderr: JSON.stringify({ success: true, data: { from: "stderr-whitespace" } }),
    });
    expect(spawnSkillTool(toolOpts)).toEqual({ from: "stderr-whitespace" });

    spawnSyncMock = () => ({
      ...successfulProcess(),
      stdout: "not json",
      stderr: JSON.stringify({ success: true, data: { ignored: true } }),
    });
    expectToolError(() => spawnSkillTool(toolOpts), { code: "E_QUALITY_GATE_PARSE" });

    spawnSyncMock = () => ({ ...successfulProcess(), stdout: " \n", stderr: "\t" });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_EMPTY",
      message: "quality-gate returned empty output",
    });
  });

  it("throws on non-zero exit with error message from tool", () => {
    spawnSyncMock = () => ({
      stdout: JSON.stringify({
        success: false,
        error: { message: "validation failed", code: "E_VALIDATE" },
      }),
      stderr: "",
      status: 1,
      signal: null,
      error: null,
    });

    expect(() => spawnSkillTool(toolOpts)).toThrow(/validation failed/);
  });

  it("preserves both tool error code and outer toolError code when tool returns custom code", () => {
    spawnSyncMock = () => ({
      stdout: JSON.stringify({
        success: false,
        error: { message: "schema invalid", code: "E_SCHEMA_INVALID" },
      }),
      stderr: "",
      status: 1,
      signal: null,
      error: null,
    });

    try {
      spawnSkillTool(toolOpts);
      expect.unreachable("should have thrown");
    } catch (err) {
      // .code should be the tool-provided code (for ERROR_HINTS compatibility)
      expect(err.code).toBe("E_SCHEMA_INVALID");
      // .outerCode should preserve the original E_TOOL_FAILED code
      expect(err.outerCode).toBe("E_QUALITY_GATE_FAILED");
    }
  });

  it("parses output before applying nonzero status and envelope success", () => {
    spawnSyncMock = () => ({ ...successfulProcess(), stdout: "", status: 1 });
    expectToolError(() => spawnSkillTool(toolOpts), { code: "E_QUALITY_GATE_EMPTY" });

    spawnSyncMock = () => ({ ...successfulProcess(), stdout: "not json", status: 1 });
    expectToolError(() => spawnSkillTool(toolOpts), { code: "E_QUALITY_GATE_PARSE" });

    spawnSyncMock = () => toolFailure({ status: 1, success: true });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_FAILED",
      message: `quality-gate failed: ${JSON.stringify({ success: true })}`,
    });

    spawnSyncMock = () => toolFailure({ status: 0, success: false });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_FAILED",
      message: `quality-gate failed: ${JSON.stringify({ success: false })}`,
    });
  });

  it("uses raw output for absent or falsy child messages and keeps default code for falsy child codes", () => {
    for (const error of [undefined, {}, { message: "" }, { message: 0 }]) {
      const output = JSON.stringify({ success: false, ...(error === undefined ? {} : { error }) });
      spawnSyncMock = () => ({ ...successfulProcess(), stdout: output });
      expectToolError(() => spawnSkillTool(toolOpts), {
        code: "E_QUALITY_GATE_FAILED",
        message: `quality-gate failed: ${output}`,
      });
    }

    for (const code of [undefined, "", 0, null]) {
      spawnSyncMock = () =>
        toolFailure({ error: { message: "bad", ...(code === undefined ? {} : { code }) } });
      const error = expectToolError(() => spawnSkillTool(toolOpts), {
        code: "E_QUALITY_GATE_FAILED",
        message: "quality-gate failed: bad",
      });
      expect(error.outerCode).toBeUndefined();
    }
  });

  it("returns missing, null, and primitive data without cloning", () => {
    spawnSyncMock = () => ({ ...successfulProcess(), stdout: JSON.stringify({ success: true }) });
    expect(spawnSkillTool(toolOpts)).toBeUndefined();

    for (const data of [null, "value", 7, false]) {
      spawnSyncMock = () => successfulProcess(data);
      expect(spawnSkillTool(toolOpts)).toBe(data);
    }

    const data = { mutable: false };
    spawnSyncMock = () => successfulProcess(data);
    const result = spawnSkillTool(toolOpts);
    result.mutable = true;
    expect(result).toEqual({ mutable: true });
  });

  it("converts primitive envelopes to FAILED but preserves the native null-envelope failure", () => {
    spawnSyncMock = () => ({ ...successfulProcess(), stdout: JSON.stringify("primitive") });
    expectToolError(() => spawnSkillTool(toolOpts), {
      code: "E_QUALITY_GATE_FAILED",
      message: 'quality-gate failed: "primitive"',
    });

    spawnSyncMock = () => ({ ...successfulProcess(), stdout: "null" });
    expect(() => spawnSkillTool(toolOpts)).toThrow(TypeError);
  });

  it("passes synchronous serialization errors through without spawning", () => {
    const circular = {};
    circular.self = circular;
    spawnSyncMock = vi.fn();
    expect(() => spawnSkillTool({ ...toolOpts, input: circular })).toThrow(TypeError);
    expect(spawnSyncMock).not.toHaveBeenCalled();

    expect(() => spawnSkillTool({ ...toolOpts, input: { value: 1n } })).toThrow(TypeError);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("passes a synchronous spawn exception through unchanged", () => {
    const spawnError = new Error("direct spawn failure");
    spawnSyncMock = () => {
      throw spawnError;
    };

    expect(() => spawnSkillTool(toolOpts)).toThrow(spawnError);
  });

  it("falls back to stderr when stdout is empty", () => {
    spawnSyncMock = () => ({
      stdout: "",
      stderr: JSON.stringify({ success: true, data: { from: "stderr" } }),
      status: 0,
      signal: null,
      error: null,
    });

    const result = spawnSkillTool(toolOpts);
    expect(result).toEqual({ from: "stderr" });
  });
});

describe("sandboxEnforcementReport", () => {
  it("reports the exact fail-closed direct-Node sandbox state", async () => {
    const { sandboxEnforcementReport } = await import("../lib/subprocess.mjs");
    const report = sandboxEnforcementReport();
    expect(report).toEqual({
      enforced: false,
      reason:
        "pipeline skill tools currently run as direct Node subprocesses; declared sandbox manifests are not runtime-enforced",
    });
  });
});
